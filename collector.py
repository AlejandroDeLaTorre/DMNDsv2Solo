#!/usr/bin/env python3
"""Read aggregate stats from the local bitcoind and push them to the dashboard Worker.

Only aggregates are sent: no peer addresses, no hostnames, no local paths.
Config comes from ~/.config/btc-dashboard.env (PUSH_URL, WRITE_KEY).
"""
import json
import os
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


def main():
    cfg = load_env()
    chain = rpc("getblockchaininfo")
    net = rpc("getnetworkinfo")
    mem = rpc("getmempoolinfo")
    peers = rpc("getpeerinfo")
    uptime = rpc("uptime")

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
