#!/usr/bin/env python3
"""Read aggregate stats from the local bitcoind and push them to the dashboard Worker.

Only aggregates are sent: no peer addresses, no hostnames, no local paths.
Config comes from ~/.config/btc-dashboard.env (PUSH_URL, WRITE_KEY, optional BITAXE_URL)
and ~/.config/dmnd.env (optional API_TX_TOKEN, RPC_URL, RPC_USER, RPC_PWD). See examples/.
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

CLI = (os.environ.get("BITCOIN_CLI") or shutil.which("bitcoin-cli")
       or os.path.expanduser("~/.local/bin/bitcoin-cli"))
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
        "accel": len(t["mempool_space_included"]) if isinstance(t.get("mempool_space_included"), list) else None,
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


def prioritization(token):
    """Whether transaction prioritisation (incl. mempool.space accelerations) is on, and how many
    transactions each source currently prioritises. Counts only, never txids."""
    caps = unwrap(client_get("/api/capabilities"))
    enabled = caps.get("transaction_prioritization") if isinstance(caps, dict) else None
    out = {"enabled": enabled if isinstance(enabled, bool) else None, "mempoolSpace": None, "manual": None}
    if enabled:
        pr = unwrap(client_get("/api/tx/prioritized", token))
        if isinstance(pr, dict):
            for key, name in (("mempool_space", "mempoolSpace"), ("manually_prioritized", "manual")):
                if isinstance(pr.get(key), dict):
                    out[name] = len(pr[key])
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
    out["prio"] = prioritization(cfg.get("API_TX_TOKEN"))
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


FINAL_FILE = os.path.expanduser("~/.cache/btc-dashboard-final.json")  # written by template_watch.py


def final_templates(limit=12):
    """The last declared template for each finished height (from template_watch.py). Totals only."""
    try:
        with open(FINAL_FILE) as f:
            hs = json.load(f).get("heights", {})
    except Exception:
        return None
    out = []
    for h, r in sorted(hs.items(), key=lambda kv: int(kv[0])):
        if not r.get("end") or r.get("stale") or r.get("fees") is None:
            continue
        wt = r.get("weight")
        out.append({"height": int(h), "fees": r["fees"], "txCount": r.get("tx"),
                    "fullness": wt / BLOCK_WEIGHT * 100 if wt else None,
                    "age": r["end"] - r["recv"] if r.get("recv") else None})
    return out[-limit:]


MEMPOOL_API = "https://mempool.space/api/v1"  # public data, no key; a handful of requests every 2 minutes
POOLNAMES_CACHE = os.path.expanduser("~/.cache/btc-dashboard-poolnames.json")


def ms_get(path):
    req = urllib.request.Request(MEMPOOL_API + path, headers={"User-Agent": "btc-dashboard-collector/1"})
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            return json.load(r)
    except Exception:
        return None


def pool_names():
    """Pool id -> name from mempool.space, refreshed once a day."""
    try:
        with open(POOLNAMES_CACHE) as f:
            c = json.load(f)
        if time.time() - c.get("t", 0) < 86400:
            return {int(k): v for k, v in c["names"].items()}
    except Exception:
        pass
    raw = ms_get("/mining/pools")
    names = {}
    if isinstance(raw, list):
        for x in raw:
            if isinstance(x, dict) and isinstance(x.get("unique_id"), int) and isinstance(x.get("name"), str):
                names[x["unique_id"]] = x["name"]
    if names:
        try:
            os.makedirs(os.path.dirname(POOLNAMES_CACHE), exist_ok=True)
            json.dump({"t": time.time(), "names": names}, open(POOLNAMES_CACHE, "w"))
        except OSError:
            pass
    return names


def ms_next_block(blocks):
    """mempool.space's projected next block and how many blocks of backlog it sees."""
    if not (isinstance(blocks, list) and blocks and isinstance(blocks[0], dict)):
        return None
    b = blocks[0]
    fees, vsize = b.get("totalFees"), b.get("blockVSize")
    return {"tx": b.get("nTx"), "fees": fees, "vsize": vsize, "median": b.get("medianFee"),
            "avg": round(fees / vsize, 3) if fees is not None and vsize else None, "backlog": len(blocks)}


def ms_accelerations(active, history):
    """Counts and totals for the accelerator market. No txids."""
    out = {"active": len(active) if isinstance(active, list) else None}
    rows = [r for r in history if isinstance(r, dict)] if isinstance(history, list) else []
    if rows:
        names = pool_names()
        mined = {}
        for r in rows:
            n = names.get(r.get("minedByPoolUniqueId"), "Other")
            mined[n] = mined.get(n, 0) + 1
        added = [r["added"] for r in rows if isinstance(r.get("added"), (int, float))]
        out.update({
            "done": len(rows),
            "feeDelta": sum(r.get("feeDelta") or 0 for r in rows),
            "bid": sum(r.get("bidBoost") or 0 for r in rows),
            "span": round((time.time() - min(added)) / 3600, 1) if added else None,
            "pools": max(len(r.get("pools") or []) for r in rows),
            "minedBy": dict(sorted(mined.items(), key=lambda kv: -kv[1])[:6]),
        })
    return out


def mempool_space():
    """What mempool.space shows publicly: its projected next block, fee tiers and accelerations."""
    nxt = ms_next_block(ms_get("/fees/mempool-blocks"))
    rec = ms_get("/fees/recommended")
    acc = ms_accelerations(ms_get("/services/accelerator/accelerations"),
                           ms_get("/services/accelerator/accelerations/history?status=completed"))
    if nxt is None and not isinstance(rec, dict) and acc.get("active") is None:
        return None
    return {"next": nxt, "rec": numeric_scalars(rec, 6) if isinstance(rec, dict) else None, "acc": acc}


def block_hunter(url):
    """Public state of the Block Hunter game (aggregates only). Returns None when not configured."""
    if not url:
        return None
    try:
        req = urllib.request.Request(url.rstrip("/") + "/api/state", headers={"User-Agent": "btc-dashboard-collector/1"})
        with urllib.request.urlopen(req, timeout=8) as r:
            st = json.load(r)
        rd = st.get("round")
        if not isinstance(rd, dict):
            return None
        crowd = rd.get("crowd") or {}
        now = st.get("now") or int(time.time())
        return {
            "height": rd.get("height"), "mode": rd.get("mode"), "open": now < (rd.get("lockAt") or 0),
            "votes": sum(v for v in (rd.get("votes") or {}).values() if isinstance(v, int)),
            "picked": len(crowd.get("ids") or []), "score": crowd.get("score"),
            "gate": (rd.get("result") or {}).get("gate"), "age": max(0, now - (rd.get("created") or now)),
            "rounds": len(st.get("history") or []),
        }
    except Exception:
        return None


RSK_RPC = os.environ.get("RSK_RPC_URL", "http://127.0.0.1:4444")


def rsk_rpc(method, params=None):
    req = urllib.request.Request(
        RSK_RPC, data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or []}).encode(),
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=4) as r:
            return json.load(r).get("result")
    except Exception:
        return None


def unit_active(name):
    try:
        out = subprocess.run(["systemctl", "--user", "is-active", name], capture_output=True, text=True, timeout=5)
        return out.stdout.strip() == "active"
    except Exception:
        return None


def rsk_status():
    """Local RSK node and merge-mining bridge. Returns None when no RSK node answers.

    Aggregates only: heights, peer count, flags and counters. No addresses, hashes or payloads.
    """
    height = rsk_rpc("eth_blockNumber")
    if height is None:
        return None
    out = {"online": True, "block": int(height, 16), "bridge": unit_active("rsk-bridge.service")}
    syncing = rsk_rpc("eth_syncing")
    out["synced"] = syncing is False
    peers = rsk_rpc("net_peerCount")
    if isinstance(peers, str):
        out["peers"] = int(peers, 16)
    tip = rsk_rpc("eth_getBlockByNumber", ["latest", False])
    if isinstance(tip, dict) and tip.get("timestamp"):
        out["tipAge"] = max(0, int(time.time()) - int(tip["timestamp"], 16))
    try:
        cfg = load_env_file(DMND_ENV)
        raw = client_get("/api/merge-mining/status", cfg.get("API_TX_TOKEN"))
        data = unwrap(raw) if raw is not None else None
        if isinstance(data, dict):
            act = data.get("activity") if isinstance(data.get("activity"), dict) else {}
            out["mm"] = {
                "configured": data.get("configured") is True,
                "work": act.get("work_available") is True,
                "found": act.get("proofs_found"),
                "pending": act.get("pending_proofs"),
            }
    except Exception:
        pass
    try:
        out["dbBytes"] = sum(
            os.path.getsize(os.path.join(d, f))
            for d, _, files in os.walk(os.path.expanduser("~/.rsk/mainnet/database")) for f in files)
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


# ---------- mempool policy and transaction types ----------
CORE_DEFAULTS = {"minrelaytxfee": 0.1, "dustrelayfee": 3.0, "datacarriersize": 100000, "permitbaremultisig": True,
                 "bytespersigop": 20, "maxmempool": 300, "limitclustercount": 64, "limitclustersize": 101}
TXTYPE_CACHE = os.path.expanduser("~/.cache/btc-dashboard-txtypes.json")
INSCRIPTION_MARK = "0063036f7264"  # OP_FALSE OP_IF "ord": start of an ordinals envelope
DUST_LIMIT = {"witness_v0_keyhash": 294, "witness_v0_scripthash": 330, "witness_v1_taproot": 330}
TX_KINDS = ("opreturn", "inscription", "baremultisig", "dust", "truc", "anchor", "big", "nonstandardout")


def conf_value(key):
    """Read one setting from bitcoin.conf. Only the named key is read; rpcauth and the rest are ignored."""
    try:
        with open(os.path.expanduser("~/.bitcoin/bitcoin.conf")) as f:
            for line in f:
                k, _, v = line.strip().partition("=")
                if k.strip() == key:
                    return v.strip()
    except Exception:
        pass
    return None


def policy(mem):
    """This node's relay policy next to Bitcoin Core's defaults (sat/vB for fee rates)."""
    def f(key, default):
        v = conf_value(key)
        try:
            return float(v) if v is not None else default
        except ValueError:
            return default
    dust = conf_value("dustrelayfee")
    return {
        "minrelaytxfee": round(mem.get("minrelaytxfee", 0) * 1e5, 3),
        "dustrelayfee": round(float(dust) * 1e5, 3) if dust else CORE_DEFAULTS["dustrelayfee"],
        "datacarriersize": mem.get("maxdatacarriersize"),
        "permitbaremultisig": mem.get("permitbaremultisig"),
        "bytespersigop": f("bytespersigop", CORE_DEFAULTS["bytespersigop"]),
        "maxmempool": round(mem.get("maxmempool", 0) / 1e6),
        "limitclustercount": mem.get("limitclustercount"),
        "limitclustersize": round(mem.get("limitclustersize", 0) / 1000) if mem.get("limitclustersize") else None,
        "acceptnonstdtxn": False,  # not allowed on mainnet in Bitcoin Core
    }


def rpc_batch(calls, chunk=400):
    """JSON-RPC batch over HTTP with the dmnd rpcauth user, much faster than one bitcoin-cli call per tx."""
    import base64
    cfg = load_env_file(DMND_ENV)
    auth = base64.b64encode(f"{cfg['RPC_USER']}:{cfg['RPC_PWD']}".encode()).decode()
    out = []
    for i in range(0, len(calls), chunk):
        body = [{"jsonrpc": "1.0", "id": i + j, "method": m, "params": p} for j, (m, p) in enumerate(calls[i:i + chunk])]
        req = urllib.request.Request(cfg.get("RPC_URL", "http://127.0.0.1:8332"), data=json.dumps(body).encode(),
                                     headers={"Authorization": "Basic " + auth, "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as r:
            out.extend(x.get("result") for x in sorted(json.load(r), key=lambda x: x["id"]))
    return out


def classify(tx):
    """Kinds of a decoded transaction. Only labels leave this function, never txids or scripts."""
    kinds = set()
    if tx.get("version") == 3:
        kinds.add("truc")
    if (tx.get("vsize") or 0) >= 20000:
        kinds.add("big")
    for o in tx.get("vout", []):
        spk = o.get("scriptPubKey", {})
        t = spk.get("type")
        if t == "nulldata":
            kinds.add("opreturn")
        elif t == "multisig":
            kinds.add("baremultisig")
        elif t == "anchor":
            kinds.add("anchor")
        elif t == "nonstandard":
            kinds.add("nonstandardout")
        if t not in ("nulldata", "anchor") and round(o.get("value", 0) * 1e8) < DUST_LIMIT.get(t, 546):
            kinds.add("dust")
    for i in tx.get("vin", []):
        if any(INSCRIPTION_MARK in w for w in i.get("txinwitness", [])):
            kinds.add("inscription")
            break
    return sorted(kinds)


def opreturn_bytes(tx):
    return sum(len(o["scriptPubKey"].get("hex", "")) // 2 for o in tx.get("vout", [])
               if o.get("scriptPubKey", {}).get("type") == "nulldata")


def count_kinds(entries):
    counts = {k: 0 for k in TX_KINDS}
    for kinds in entries:
        for k in kinds:
            counts[k] += 1
    return counts


def tx_types(recent_blocks):
    """Transaction kinds in the mempool (new txs only are decoded) and in recent blocks (once per block)."""
    try:
        cache = json.load(open(TXTYPE_CACHE))
    except Exception:
        cache = {}
    mem = cache.get("mem", {})
    blocks = {int(k): v for k, v in cache.get("blocks", {}).items()}
    try:
        txids = rpc("getrawmempool")
        live = set(txids)
        mem = {t: v for t, v in mem.items() if t in live}
        new = [t for t in txids if t not in mem][:8000]
        for t, tx in zip(new, rpc_batch([("getrawtransaction", [t, 1]) for t in new])):
            if tx:
                mem[t] = [classify(tx), opreturn_bytes(tx)]
        for b in recent_blocks[:6]:
            h = b.get("height")
            if h in blocks:
                continue
            blk = rpc_batch([("getblock", [rpc("getblockhash", str(h)), 2])])[0]
            if blk:
                txs = blk["tx"][1:]  # skip the coinbase
                blocks[h] = {"total": len(txs), "counts": count_kinds(classify(t) for t in txs),
                             "opretBytes": sum(opreturn_bytes(t) for t in txs)}
        blocks = dict(sorted(blocks.items())[-6:])
    except Exception as e:
        print("tx type scan failed:", e, file=sys.stderr)
    try:
        os.makedirs(os.path.dirname(TXTYPE_CACHE), exist_ok=True)
        json.dump({"mem": mem, "blocks": blocks}, open(TXTYPE_CACHE, "w"))
    except Exception:
        pass
    return {
        "mempool": {"total": len(mem), "counts": count_kinds(v[0] for v in mem.values()),
                    "opretBytes": sum(v[1] for v in mem.values())},
        "blocks": [dict(height=h, **v) for h, v in sorted(blocks.items(), reverse=True)],
        "kinds": list(TX_KINDS),
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

    recent = recent_blocks(chain.get("blocks")) if chain.get("initialblockdownload") is False else []
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
        "recent": recent,
        "policy": policy(mem),
        "txtypes": tx_types(recent) if chain.get("initialblockdownload") is False else None,
        "final": final_templates(),
        "ms": mempool_space(),
        "rsk": rsk_status(),
        "bh": block_hunter(cfg.get("BLOCKHUNTER_URL")),
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
