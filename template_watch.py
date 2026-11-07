#!/usr/bin/env python3
"""Record the last template the DMND client declared for each block height.

The client's API only keeps its newest few templates, all for the current height, so once a block
is found the template you were actually mining on is gone. This polls the local client API every
2 seconds and saves totals (fees, tx count, weight, times) for the declared template per height to
~/.cache/btc-dashboard-final.json. collector.py reads that file. Totals only: no txids.

Run it as a long-lived service (see examples/systemd/template-watch.service).
"""
import json
import os
import time
import urllib.request

CLIENT_API = "http://127.0.0.1:3001/api/templates/recent"
DMND_ENV = os.path.expanduser("~/.config/dmnd.env")
OUT = os.path.expanduser("~/.cache/btc-dashboard-final.json")
POLL = 2
KEEP = 30
STALE_AFTER = 10  # seconds without a poll before a block makes the record untrustworthy


def token():
    try:
        with open(DMND_ENV) as f:
            for line in f:
                if line.startswith("API_TX_TOKEN="):
                    return line.split("=", 1)[1].strip()
    except OSError:
        pass
    return None


def fetch(tok):
    req = urllib.request.Request(CLIENT_API)
    if tok:
        req.add_header("Authorization", "Bearer " + tok)
        req.add_header("X-API-Token", tok)
    with urllib.request.urlopen(req, timeout=3) as r:
        raw = json.load(r)
    return raw.get("data", raw) if isinstance(raw, dict) else {}


def load():
    try:
        with open(OUT) as f:
            d = json.load(f)
        return {int(k): v for k, v in d.get("heights", {}).items()}
    except Exception:
        return {}


def save(heights):
    keep = sorted(heights)[-KEEP:]
    tmp = OUT + ".tmp"
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(tmp, "w") as f:
        json.dump({"heights": {str(h): heights[h] for h in keep}}, f)
    os.replace(tmp, OUT)


def step(heights, data, now):
    """Apply one API reply. Returns True when the saved state should change."""
    changed = False
    templates = [t for t in data.get("templates") or [] if isinstance(t, dict) and isinstance(t.get("height"), int)]
    if not templates:
        return False
    active = data.get("active_declaration")
    # A current template (or the declared one) for a higher height means the lower heights' blocks
    # were found: close them. "Future" templates can arrive before the block, so they don't count
    # until they are declared.
    current = [t["height"] for t in templates if not t.get("future_template") or t.get("template_id") == active]
    if not current:
        return False
    top = max(current)
    for h, rec in heights.items():
        if h < top and rec.get("end") is None:
            rec["end"] = now
            # If we were not watching just before the block (watcher or client down), the record
            # may be old. Keep it but mark it so it is not shown as exact.
            rec["stale"] = now - rec.get("last", 0) > STALE_AFTER
            changed = True
    for t in templates:
        h = t["height"]
        if t.get("template_id") != active or t.get("total_fees_sat") is None:
            continue
        rec = heights.get(h)
        if rec is not None and rec.get("end") is not None:
            continue  # height already closed; never reopen it
        if rec is None or rec.get("id") != active:
            heights[h] = {"id": active, "fees": t.get("total_fees_sat"), "tx": t.get("tx_count"),
                          "weight": t.get("total_weight"), "recv": t.get("received_at"), "end": None}
            changed = True
        heights[h]["last"] = now
    return changed


def main():
    tok = token()
    heights = load()
    while True:
        changed = False
        try:
            changed = step(heights, fetch(tok), int(time.time()))
        except Exception:
            tok = tok or token()
        if changed:
            try:
                save(heights)
            except OSError:
                pass
        time.sleep(POLL)


if __name__ == "__main__":
    main()
