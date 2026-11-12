# DMNDsv2Solo: mine on your own block templates

A home Bitcoin mining setup that uses **Stratum V2 Job Declaration**: your own Bitcoin Core node builds the block templates, a Bitaxe hashes on them, and the DMND pool pays you. An optional public dashboard shows it all live.

**Live example:** https://bitcoin-node.alejandro-d92.workers.dev/

## Quick start

You need an always-on Linux machine (~80 GB free disk, 8 GB+ RAM), a Bitaxe, and a free DMND token from https://join.dmnd.work.

1. Install **Bitcoin Core v30+**, pruned, and let it sync (1–2 days).
2. Install **sv2-tp** (hands your node's templates to the client).
3. Build and run the **DMND client**.
4. Point your **Bitaxe** at `<your LAN IP>:32767`, password = your DMND token.
5. Open **http://127.0.0.1:3001/dashboard/overview**. This is the DMND client's own dashboard and your **source of truth**: it shows the pool connection, your connected miner, the block templates your node declares, and the logs. If it looks right, you are mining on your own templates.

The public Cloudflare dashboard further down is an optional extra for sharing. It is built from the client's data, so when the two disagree, trust the client's dashboard.

Every step, with the exact commands and a check after each one, is in **[GUIDE.md](GUIDE.md)**.

```
Bitcoin Core ──IPC──▶ sv2-tp ──SV2──▶ dmnd-client ──SV1──▶ Bitaxe
 (your node)       (templates)      (Job Declaration)     (hashing)
      │                                   │
      └──────── collector.py ─────────────┴──▶ Cloudflare Worker (public dashboard)
```

## Start here

| I want to…                                   | Read                       |
|----------------------------------------------|----------------------------|
| Set up the node + sv2-tp + DMND + Bitaxe     | **[GUIDE.md](GUIDE.md)**   |
| Also merge-mine RSK (optional)               | [GUIDE.md](GUIDE.md#optional-also-mine-rsk-merge-mining) |
| Check that it works                          | http://127.0.0.1:3001/dashboard/overview (the DMND client's own dashboard) |
| Optional: share a public dashboard           | [Public dashboard](#optional-public-dashboard-cloudflare) below |
| Use an AI assistant to help me set it up     | [Using an AI assistant](#using-an-ai-assistant) |

The mining stack (GUIDE.md) works on its own. The public dashboard is optional.

## Using an AI assistant

This repo is written so an AI coding assistant (Claude Code, Codex, Cursor, …) can walk you through it. Clone it, open the folder in your assistant, and say something like:

> Follow GUIDE.md to set up the mining stack on this machine. Do one step at a time, check each step works before moving on, and ask me before using sudo or entering my DMND token.

Assistant instructions live in [AGENTS.md](AGENTS.md) (Claude Code reads it through [CLAUDE.md](CLAUDE.md)). They cover the steps, the known problems, and the rule to never commit or print secrets.

## Optional: public dashboard (Cloudflare)

Not needed for mining. Skip it unless you want a page to show others. The DMND client's local dashboard at http://127.0.0.1:3001/dashboard/overview is the source of truth.

A Cloudflare Worker serves a four-tab page (Overview, My block, Miner, Nodes); the Overview shows the live stack and the RSK merge-mining status. The Worker serves the page; a Python script on your node pushes aggregate stats to it every 2 minutes. No Node.js or wrangler needed, and the free Cloudflare plan is enough.

| File | What it does |
|---|---|
| `collector.py` | Runs on the node. Reads `bitcoin-cli`, Bitcoin Core RPC, the DMND client API, the Bitaxe API and mempool.space's public API (a few small requests every 2 minutes, no key), then pushes **aggregates only** (no txids, addresses, IPs or tokens). |
| `worker.js` | The Worker. Serves the page at `/`, stats at `/api/stats`, and accepts pushes at `POST /api/push` (needs the write key). The page HTML is inside it. |
| `template_watch.py` | Optional, runs on the node. Saves the last template the DMND client declared for each block height, so the "my template vs the real block" comparison is exact. |
| `examples/systemd/rskj.service`, `rsk-bridge.service` | Optional RSK merge mining. `collector.py` reports the RSK node and bridge as counts and flags only. |
| `deploy.sh` | Uploads the Worker through the Cloudflare API. Creates the KV store and a write key on first run. |
| `examples/` | Example config files and systemd units to copy. |

### Setup

1. **Cloudflare config.** Copy [`examples/cloudflare.env.example`](examples/cloudflare.env.example) to `~/.config/cloudflare.env` and fill in an API token (permissions: Workers Scripts edit + Workers KV Storage edit), your account ID and your workers.dev subdomain.
2. **Deploy.** Run `./deploy.sh` (set `NAME=...` to change the Worker name; default `bitcoin-node`). It prints your dashboard URL and writes the push URL and write key to `~/.config/btc-dashboard.env`.
3. **Optional extras** in `~/.config/btc-dashboard.env`: add `BITAXE_URL=http://<bitaxe-ip>` to show miner stats, and `BLOCKHUNTER_URL=https://<your block-hunter worker>` to show the Block Hunter game in the diagram.
4. **Optional DMND + RPC data** in `~/.config/dmnd.env` (the same file the client uses): `API_TX_TOKEN` for templates, and `RPC_URL`, `RPC_USER`, `RPC_PWD` for the mempool policy and transaction-type sections. See [`examples/dmnd.env.example`](examples/dmnd.env.example).
5. **Schedule the collector** every 2 minutes with the systemd units in [`examples/systemd/`](examples/systemd/):

   ```bash
   cp examples/systemd/btc-dashboard.* ~/.config/systemd/user/
   # edit the path to collector.py in btc-dashboard.service
   systemctl --user daemon-reload
   systemctl --user enable --now btc-dashboard.timer
   ```

   Cloudflare's free KV plan allows 1,000 writes a day, so 2 minutes is the practical minimum.

6. **Optional: exact template comparison.** Install `examples/systemd/template-watch.service` the same way (edit the path, then `systemctl --user enable --now template-watch`). Without it, the "my template vs the real block" section stays empty.

Every section degrades gracefully: if the Bitaxe, the DMND client or RPC isn't configured, that part of the page just stays empty.

## Secrets

All secrets live in `~/.config/*.env`, outside the repo, and `.gitignore` blocks `*.env`. Never commit tokens, keys, IPs or wallet details.

## Requirements

- Linux with systemd, Python 3 (standard library only), `curl`
- Bitcoin Core v30+ (multiprocess), sv2-tp, dmnd-client, a Bitaxe: see GUIDE.md
- A free Cloudflare account (dashboard only)
