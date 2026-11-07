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
    try:
        return json.loads(out)
    except ValueError:
        return out.strip()  # bare strings such as block hashes


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
        "clientUptime": proc_uptime(["pgrep", "-x", "dmnd-client"]),
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


def summarise_template(t, active_id=None, base_fees=None):
    """Totals for one candidate block. No txids, addresses or transaction lists."""
    fees = pick(t, "total_fees_sat", "total_fees", "totalFees", "fees")
    txc = pick(t, "tx_count", "txCount", "transactions")
    wt = pick(t, "total_weight", "weight", "block_weight")
    full = wt / BLOCK_WEIGHT * 100 if wt else None
    tid = pick(t, "template_id")
    pri = t.get("prioritized_included")
    return {
        "height": pick(t, "height", "block_height"),
        "fees": fees,
        "txCount": txc,
        "fullness": full,
        "feeRate": round(fees / (wt / 4), 2) if fees is not None and wt else None,  # sat per vbyte
        "prioritized": len(pri) if isinstance(pri, list) else None,
        "declared": (tid is not None and tid == active_id) if active_id is not None else None,
        "gained": fees - base_fees if fees is not None and base_fees is not None else None,
        "coinbase": pick(t, "coinbase_value_sat", "coinbase_value"),
        "age": None,
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


def miner_tag():
    """Coinbase tag the client writes, read from its command line (/DMND/<name>/ by default)."""
    try:
        pid = subprocess.run(["pgrep", "-x", "dmnd-client"], capture_output=True, text=True, timeout=5).stdout.split()[0]
        args = open(f"/proc/{pid}/cmdline", "rb").read().decode().split("\0")
    except Exception:
        return None
    def opt(name):
        for i, a in enumerate(args):
            if a == name and i + 1 < len(args):
                return args[i + 1]
            if a.startswith(name + "="):
                return a.split("=", 1)[1]
        return None
    name = opt("--miner-name")
    return (opt("--tag-prefix") or "/DMND/") + name + "/" if name else None


def dmnd_client(synced):
    """Template summaries and client stats. Returns None when the client API cannot be reached."""
    try:
        cfg = load_env_file(DMND_ENV)
    except Exception:
        return None
    if not wait_for_client_api(35):
        return None
    schema = {}
    out = {"templates": [], "stats": {}, "pool": {}, "tag": miner_tag()}
    raw = client_get("/api/templates/recent", cfg.get("API_TX_TOKEN"))
    if raw is not None:
        schema["templates"] = shape(raw)
        info = unwrap(raw) if isinstance(unwrap(raw), dict) else {}
        active = info.get("active_declaration")
        tl = [t for t in template_list(raw) if isinstance(t, dict)]
        # "fees gained" = fees compared with the first template received for the same height
        first = {}
        for t in sorted(tl, key=lambda x: x.get("received_at") or 0):
            first.setdefault(t.get("height"), t.get("total_fees_sat"))
        out["templates"] = [summarise_template(t, active, first.get(t.get("height"))) for t in tl[:3]]
        out["activeId"] = active if isinstance(active, int) else None
        out["policy"] = info.get("policy") if isinstance(info.get("policy"), str) else None
    agg = client_get("/api/stats/aggregate")
    if agg is not None:
        schema["aggregate"] = shape(agg)
        out["stats"] = numeric_scalars(unwrap(agg))
        out["stats"].pop("aggregate_hashrate", None)  # client estimate, far off the real hashrate right now
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


POOL_TAGS = [("foundry", "Foundry USA"), ("antpool", "AntPool"), ("f2pool", "F2Pool"), ("viabtc", "ViaBTC"),
             ("binance", "Binance Pool"), ("mara", "MARA Pool"), ("luxor", "Luxor"), ("sbicrypto", "SBI Crypto"),
             ("braiins", "Braiins"), ("slush", "Braiins"), ("ocean", "OCEAN"), ("dmnd", "DMND"),
             ("spiderpool", "SpiderPool"), ("poolin", "Poolin"), ("btc.com", "BTC.com"), ("secpool", "SecPool"),
             ("ultimus", "Ultimus"), ("carbon", "Carbon Negative"), ("kucoin", "KuCoinPool"), ("bitfufu", "BitFuFu")]
FEE_BUCKETS = [0, 2, 5, 10, 25, 50, 100]  # lower bounds in sat/vB


def fee_market(mem_size):
    """Mempool vsize per fee-rate bucket and fee estimates. Aggregates only."""
    out = {"buckets": None, "estimates": {}}
    if mem_size and mem_size <= 60000:
        try:
            raw = rpc("getrawmempool", "true")
            vs = [0] * len(FEE_BUCKETS)
            for tx in raw.values():
                vsize = tx.get("vsize") or 0
                fee = (tx.get("fees") or {}).get("base")
                if not vsize or fee is None:
                    continue
                rate = fee * 1e8 / vsize
                i = max(j for j, lo in enumerate(FEE_BUCKETS) if rate >= lo)
                vs[i] += vsize
            out["buckets"] = vs
        except Exception:
            pass
    for target in (1, 3, 6, 24, 144):
        try:
            r = rpc("estimatesmartfee", str(target))
            if r.get("feerate") is not None:
                out["estimates"][str(target)] = round(r["feerate"] * 1e5, 2)  # BTC/kvB -> sat/vB
        except Exception:
            pass
    return out


def pool_name(coinbase_hex):
    try:
        text = bytes.fromhex(coinbase_hex).decode("latin-1").lower()
    except Exception:
        return None
    for tag, name in POOL_TAGS:
        if tag in text:
            return name
    return None


def recent_blocks(tip, count=6):
    """Last few blocks: totals and the pool tag found in the coinbase. No addresses."""
    out = []
    try:
        h = rpc("getblockhash", str(tip))
        for _ in range(count):
            blk = rpc("getblock", h, "1")
            st = rpc("getblockstats", h)
            name = None
            try:
                cb = rpc("getrawtransaction", blk["tx"][0], "true", h)
                name = pool_name(cb["vin"][0].get("coinbase", ""))
            except Exception:
                pass
            out.append({"height": blk["height"], "time": blk["time"], "txs": st.get("txs"),
                        "size": blk.get("size"), "weight": blk.get("weight"),
                        "fees": st.get("totalfee"), "feeRate": st.get("avgfeerate"),
                        "subsidy": st.get("subsidy"), "pool": name})
            h = blk.get("previousblockhash")
            if not h:
                break
    except Exception:
        pass
    return out


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
        "fees": fee_market(mem.get("size")),
        "recent": recent_blocks(chain.get("blocks")) if chain.get("initialblockdownload") is False else [],
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
