#!/usr/bin/env python3
"""Read aggregate stats from the local bitcoind and push them to the dashboard Worker.

Only aggregates are sent: no peer addresses, no hostnames, no local paths.
Config comes from ~/.config/btc-dashboard.env (PUSH_URL, WRITE_KEY).
"""
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

CLI = os.environ.get("BITCOIN_CLI", "/home/pigeon/.local/bin/bitcoin-cli")
ENV_FILE = os.path.expanduser("~/.config/btc-dashboard.env")


def load_env():
    cfg = {}
    with open(ENV_FILE) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                cfg[k] = v
    return cfg


def rpc(*args):
    out = subprocess.run([CLI, *args], capture_output=True, text=True, timeout=30, check=True).stdout
    return json.loads(out)


TP_PORT = 8336        # sv2-tp (Template Provider), localhost only
CLIENT_PORT = 32767   # dmnd-client stratum V1 port for miners
IPC_SOCKET = os.path.expanduser("~/.bitcoin/node.sock")


def ss(*args):
    try:
        return subprocess.run(["ss", "-H", *args], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return ""


def services():
    """Booleans and one count only. No addresses of miners or this machine are collected."""
    listening = ss("-ltn")
    tp_up = f":{TP_PORT} " in listening
    client_up = f":{CLIENT_PORT} " in listening
    miners = 0
    if client_up:
        est = ss("-tn", "state", "established", f"( sport = :{CLIENT_PORT} )")
        miners = len([ln for ln in est.splitlines() if ln.strip()])
    return {
        "ipc": os.path.exists(IPC_SOCKET),
        "tp": tp_up,
        "client": client_up,
        "miners": miners,
        "tpUptime": proc_uptime(["pgrep", "-x", "sv2-tp"]),
        "clientUptime": proc_uptime(["pgrep", "-f", "^./dmnd-client-linux"]),
    }


def proc_uptime(pgrep_cmd):
    """Seconds since the matching process started, or None if it isn't running."""
    try:
        pid = subprocess.run(pgrep_cmd, capture_output=True, text=True, timeout=5).stdout.split()
        if not pid:
            return None
        et = subprocess.run(["ps", "-o", "etimes=", "-p", pid[0]], capture_output=True, text=True, timeout=5).stdout.strip()
        return int(et) if et else None
    except Exception:
        return None


def net_difficulty():
    """Difficulty of the best known header, i.e. the current network difficulty even mid-sync."""
    try:
        tips = rpc("getchaintips")
        best = max(tips, key=lambda t: t.get("height", 0))
        return rpc("getblockheader", best["hash"]).get("difficulty")
    except Exception:
        return None


def bitaxe(url):
    """Numbers from the Bitaxe's local API. The address, pool user and wallet are never sent."""
    if not url:
        return None
    try:
        with urllib.request.urlopen(url.rstrip("/") + "/api/system/info", timeout=5) as r:
            d = json.load(r)
    except Exception:
        return {"online": False}

    def n(key):
        v = d.get(key)
        return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None

    best = d.get("bestDiff")
    return {
        "online": True,
        "hashrate": n("hashRate"),          # GH/s
        "temp": n("temp"),                  # ASIC, C
        "vrTemp": n("vrTemp"),              # voltage regulator, C
        "power": n("power"),                # W
        "voltage": n("voltage"),            # mV
        "frequency": n("frequency"),        # MHz
        "fanRpm": n("fanrpm"),
        "fanPct": n("fanspeed"),
        "accepted": n("sharesAccepted"),
        "rejected": n("sharesRejected"),
        "bestDiff": str(best)[:16] if best is not None else None,
        "uptime": n("uptimeSeconds"),
        "rssi": n("wifiRSSI"),
    }


CLIENT_API = "http://127.0.0.1:3001"
DMND_ENV = os.path.expanduser("~/.config/dmnd.env")
SCHEMA_LOG = os.path.expanduser("~/.cache/dmnd-api-schema.json")  # key names and types only, never values
BLOCK_WEIGHT = 4_000_000


def norm(k):
    return re.sub(r"[^a-z0-9]", "", str(k).lower())


def pick(d, *names):
    """First numeric value in dict d whose normalised key matches one of names."""
    if not isinstance(d, dict):
        return None
    m = {norm(k): v for k, v in d.items()}
    for n in names:
        v = m.get(norm(n))
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            return v
    return None


def pick_bool(d, *names):
    if not isinstance(d, dict):
        return None
    m = {norm(k): v for k, v in d.items()}
    for n in names:
        v = m.get(norm(n))
        if isinstance(v, bool):
            return v
    return None


def shape(v, depth=0):
    """Describe a JSON value by key names and types only, so values (txids, tokens) never reach disk."""
    if isinstance(v, dict):
        return {k: shape(x, depth + 1) for k, x in list(v.items())[:40]} if depth < 4 else "object"
    if isinstance(v, list):
        return [shape(v[0], depth + 1)] if v and depth < 4 else "list"
    return type(v).__name__


def wait_for_client_api(max_wait):
    """The client's API port only opens briefly at times, so poll for it."""
    end = time.time() + max_wait
    while True:
        try:
            socket.create_connection(("127.0.0.1", 3001), timeout=0.3).close()
            return True
        except OSError:
            if time.time() >= end:
                return False
            time.sleep(0.05)


def client_get(path, token=None):
    req = urllib.request.Request(CLIENT_API + path)
    if token:
        req.add_header("Authorization", "Bearer " + token)
        req.add_header("X-API-Token", token)
    try:
        with urllib.request.urlopen(req, timeout=4) as r:
            return json.load(r)
    except Exception:
        return None


def unwrap(raw):
    """The client wraps replies as {success, message, data}."""
    if isinstance(raw, dict) and isinstance(raw.get("data"), (dict, list)):
        return raw["data"]
    return raw


def template_list(raw):
    raw = unwrap(raw)
    if isinstance(raw, list):
        return raw
    if isinstance(raw, dict):
        for k in ("templates", "data", "items", "recent"):
            if isinstance(raw.get(k), list):
                return raw[k]
    return []


def summarise_template(t):
    """Totals for one candidate block. No txids, addresses or transaction lists."""
    fees = pick(t, "total_fees", "totalFees", "fees", "fee_total", "total_fee")
    txc = pick(t, "tx_count", "txCount", "transactions", "num_txs", "n_tx", "transaction_count")
    wt = pick(t, "weight", "total_weight", "block_weight")
    full = pick(t, "fullness", "fullness_pct", "full_pct", "fill")
    if full is None and wt is not None:
        full = wt / BLOCK_WEIGHT * 100
    elif full is not None and full <= 1:
        full = full * 100
    return {
        "height": pick(t, "height", "block_height"),
        "fees": fees,
        "txCount": txc,
        "fullness": full,
        "feeRate": pick(t, "fee_rate", "feeRate", "avg_fee_rate", "median_fee_rate", "sat_vb"),
        "prioritized": pick(t, "prioritized", "prioritised", "prioritized_count", "prioritized_txs"),
        "declared": pick_bool(t, "declared", "is_declared", "active"),
        "gained": pick(t, "fees_gained", "feesGained", "gained", "fee_delta"),
        "coinbase": pick(t, "coinbase_value", "coinbaseValue", "coinbase"),
        "age": pick(t, "age", "age_seconds", "received_ago"),
    }


def numeric_scalars(d, limit=16):
    out = {}
    if isinstance(d, dict):
        for k, v in d.items():
            if isinstance(v, (int, float)) and not isinstance(v, bool) and re.fullmatch(r"[A-Za-z0-9_]{1,40}", str(k)):
                out[k] = v
            if len(out) >= limit:
                break
    return out


def dmnd_client(synced):
    """Template summaries and client stats. Returns None when the client API cannot be reached."""
    try:
        cfg = load_env_file(DMND_ENV)
    except Exception:
        return None
    if not wait_for_client_api(35):
        return None
    schema = {}
    out = {"templates": [], "stats": {}, "pool": {}}
    raw = client_get("/api/templates/recent", cfg.get("API_TX_TOKEN"))
    if raw is not None:
        schema["templates"] = shape(raw)
        out["templates"] = [summarise_template(t) for t in template_list(raw)[:3] if isinstance(t, dict)]
    agg = client_get("/api/stats/aggregate")
    if agg is not None:
        schema["aggregate"] = shape(agg)
        out["stats"] = numeric_scalars(unwrap(agg))
    pool = client_get("/api/pool/info")
    if pool is not None:
        schema["pool"] = shape(pool)
        out["pool"] = numeric_scalars(unwrap(pool), 8)
    try:
        os.makedirs(os.path.dirname(SCHEMA_LOG), exist_ok=True)
        with open(SCHEMA_LOG, "w") as f:
            json.dump(schema, f, indent=1)
    except Exception:
        pass
    return out


def load_env_file(path):
    cfg = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                cfg[k] = v
    return cfg


def node_resources():
    """Aggregate resource use of the node process and its data disk."""
    out = {}
    try:
        ps = subprocess.run(["ps", "-C", "bitcoin-node", "-o", "rss=,pcpu="], capture_output=True, text=True, timeout=5).stdout.split()
        if len(ps) >= 2:
            out["memBytes"] = int(ps[0]) * 1024
            out["cpuPct"] = float(ps[1])
    except Exception:
        pass
    try:
        u = shutil.disk_usage(os.path.expanduser("~/.bitcoin"))
        out["diskFree"], out["diskTotal"] = u.free, u.total
    except Exception:
        pass
    return out


def main():
    cfg = load_env()
    chain = rpc("getblockchaininfo")
    net = rpc("getnetworkinfo")
    mem = rpc("getmempoolinfo")
    peers = rpc("getpeerinfo")
    uptime = rpc("uptime")
    totals = rpc("getnettotals")

    networks = {}
    for p in peers:
        n = str(p.get("network", "unknown"))
        networks[n] = networks.get(n, 0) + 1

    payload = {
        "chain": chain.get("chain"),
        "blocks": chain.get("blocks"),
        "headers": chain.get("headers"),
        "progress": chain.get("verificationprogress"),
        "ibd": chain.get("initialblockdownload"),
        "tipTime": chain.get("time"),
        "difficulty": chain.get("difficulty"),
        "sizeOnDisk": chain.get("size_on_disk"),
        "pruned": chain.get("pruned"),
        "pruneHeight": chain.get("pruneheight"),
        "pruneTarget": chain.get("prune_target_size"),
        "peersIn": net.get("connections_in"),
        "peersOut": net.get("connections_out"),
        "network": networks,
        "mempoolTx": mem.get("size"),
        "mempoolBytes": mem.get("bytes"),
        "version": net.get("subversion", "").strip("/"),
        "uptime": uptime,
        "services": services(),
        "netDifficulty": net_difficulty(),
        "bytesIn": totals.get("totalbytesrecv"),
        "bytesOut": totals.get("totalbytessent"),
        "resources": node_resources(),
        "bitaxe": bitaxe(cfg.get("BITAXE_URL")),
        "dmnd": dmnd_client(chain.get("initialblockdownload") is False),
    }
    req = urllib.request.Request(
        cfg["PUSH_URL"],
        data=json.dumps(payload).encode(),
        headers={"Authorization": "Bearer " + cfg["WRITE_KEY"], "Content-Type": "application/json",
                 "User-Agent": "btc-dashboard-collector/1"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        if r.status != 200:
            print("push failed:", r.status, file=sys.stderr)
            sys.exit(1)


if __name__ == "__main__":
    main()
