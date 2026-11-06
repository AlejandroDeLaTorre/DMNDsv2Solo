#!/usr/bin/env python3
"""Read aggregate stats from the local bitcoind and push them to the dashboard Worker.

Only aggregates are sent: no peer addresses, no hostnames, no local paths.
Config comes from ~/.config/btc-dashboard.env (PUSH_URL, WRITE_KEY).
"""
import json
import os
import shutil
import subprocess
import sys
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
    }


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
        "bytesIn": totals.get("totalbytesrecv"),
        "bytesOut": totals.get("totalbytessent"),
        "resources": node_resources(),
        "bitaxe": bitaxe(cfg.get("BITAXE_URL")),
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
