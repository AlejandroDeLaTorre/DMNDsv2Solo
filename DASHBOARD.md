# Optional: public dashboard (Cloudflare)

Not needed for mining. Skip it unless you want a page to show others. The DMND client's local dashboard at http://127.0.0.1:3001/dashboard/overview is the source of truth.

Live example: https://bitcoin-node.alejandro-d92.workers.dev/

A Cloudflare Worker serves a four-tab page (Overview, My block, Miner, Nodes). A Python script on your node pushes aggregate stats to it every 2 minutes. No Node.js or wrangler needed, and the free Cloudflare plan is enough.

```
Bitcoin Core ─┐
DMND client  ─┼── collector.py ──▶ Cloudflare Worker (public page)
Bitaxe       ─┘
```

| File | What it does |
|---|---|
| `collector.py` | Runs on the node. Reads `bitcoin-cli`, Bitcoin Core RPC, the DMND client API, the Bitaxe API and mempool.space's public API, then pushes **aggregates only** (no txids, addresses, IPs or tokens). |
| `worker.js` | The Worker. Serves the page at `/`, stats at `/api/stats`, and accepts pushes at `POST /api/push` (needs the write key). |
| `template_watch.py` | Optional. Saves the last template the DMND client declared for each height, so "my template vs the real block" is exact. |
| `deploy.sh` | Uploads the Worker through the Cloudflare API. Creates the KV store and a write key on first run. |
| `examples/` | Example config files and systemd units to copy. |

## Setup

1. **Cloudflare config.** Copy [`examples/cloudflare.env.example`](examples/cloudflare.env.example) to `~/.config/cloudflare.env` and fill in an API token (Workers Scripts edit + Workers KV Storage edit), your account ID and your workers.dev subdomain.
2. **Deploy.** Run `./deploy.sh` (set `NAME=...` to change the Worker name; default `bitcoin-node`). It prints your dashboard URL and writes the push URL and write key to `~/.config/btc-dashboard.env`.
3. **Optional extras** in `~/.config/btc-dashboard.env`: `BITAXE_URL=http://<bitaxe-ip>` for miner stats, `BLOCKHUNTER_URL=https://<your block-hunter worker>` to show the "Create your own block" game in the diagram.
4. **Optional DMND + RPC data** in `~/.config/dmnd.env`: `API_TX_TOKEN` for templates, and `RPC_URL`, `RPC_USER`, `RPC_PWD` for the mempool sections. See [`examples/dmnd.env.example`](examples/dmnd.env.example).
5. **Schedule the collector** every 2 minutes:

   ```bash
   cp examples/systemd/btc-dashboard.* ~/.config/systemd/user/
   # edit the path to collector.py in btc-dashboard.service
   systemctl --user daemon-reload
   systemctl --user enable --now btc-dashboard.timer
   ```

   Cloudflare's free KV plan allows 1,000 writes a day, so 2 minutes is the practical minimum.

6. **Optional: exact template comparison.** Install `examples/systemd/template-watch.service` the same way (edit the path, then `systemctl --user enable --now template-watch`).

Every section degrades gracefully: if the Bitaxe, the DMND client or RPC isn't configured, that part of the page stays empty.

## Requirements

- Linux with systemd, Python 3 (standard library only), `curl`
- A free Cloudflare account
