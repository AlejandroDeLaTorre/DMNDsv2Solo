# btcnode: mine on your own block templates, and show it off

A home Bitcoin mining setup that uses **Stratum V2 Job Declaration**: your own Bitcoin Core node builds the block templates, a Bitaxe hashes on them, and the DMND pool pays you. A small public dashboard shows it all live.

**Live example:** https://bitcoin-node.alejandro-d92.workers.dev/

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
| Add the public dashboard on top              | [Dashboard](#dashboard) below |
| Use an AI assistant to help me set it up     | [Using an AI assistant](#using-an-ai-assistant) |

The mining stack (GUIDE.md) works on its own. The dashboard is optional.

## Using an AI assistant

This repo is written so an AI coding assistant (Claude Code, Codex, Cursor, …) can walk you through it. Clone it, open the folder in your assistant, and say something like:

> Follow GUIDE.md to set up the mining stack on this machine. Do one step at a time, check each step works before moving on, and ask me before using sudo or entering my DMND token.

Assistant instructions live in [AGENTS.md](AGENTS.md) (Claude Code reads it through [CLAUDE.md](CLAUDE.md)). They cover the steps, the known problems, and the rule to never commit or print secrets.

## Dashboard

A Cloudflare Worker serves the page; a Python script on your node pushes aggregate stats to it every 2 minutes. No Node.js or wrangler needed, and the free Cloudflare plan is enough.

| File | What it does |
|---|---|
| `collector.py` | Runs on the node. Reads `bitcoin-cli`, Bitcoin Core RPC, the DMND client API and the Bitaxe API, then pushes **aggregates only** (no txids, addresses, IPs or tokens). |
| `worker.js` | The Worker. Serves the page at `/`, stats at `/api/stats`, and accepts pushes at `POST /api/push` (needs the write key). The page HTML is inside it. |
| `deploy.sh` | Uploads the Worker through the Cloudflare API. Creates the KV store and a write key on first run. |
| `examples/` | Example config files and systemd units to copy. |

### Setup

1. **Cloudflare config.** Copy [`examples/cloudflare.env.example`](examples/cloudflare.env.example) to `~/.config/cloudflare.env` and fill in an API token (permissions: Workers Scripts edit + Workers KV Storage edit), your account ID and your workers.dev subdomain.
2. **Deploy.** Run `./deploy.sh` (set `NAME=...` to change the Worker name; default `bitcoin-node`). It prints your dashboard URL and writes the push URL and write key to `~/.config/btc-dashboard.env`.
3. **Optional extras** in `~/.config/btc-dashboard.env`: add `BITAXE_URL=http://<bitaxe-ip>` to show miner stats.
4. **Optional DMND + RPC data** in `~/.config/dmnd.env` (the same file the client uses): `API_TX_TOKEN` for templates, and `RPC_URL`, `RPC_USER`, `RPC_PWD` for the mempool policy and transaction-type sections. See [`examples/dmnd.env.example`](examples/dmnd.env.example).
5. **Schedule the collector** every 2 minutes with the systemd units in [`examples/systemd/`](examples/systemd/):

   ```bash
   cp examples/systemd/btc-dashboard.* ~/.config/systemd/user/
   # edit the path to collector.py in btc-dashboard.service
   systemctl --user daemon-reload
   systemctl --user enable --now btc-dashboard.timer
   ```

   Cloudflare's free KV plan allows 1,000 writes a day, so 2 minutes is the practical minimum.

Every section degrades gracefully: if the Bitaxe, the DMND client or RPC isn't configured, that part of the page just stays empty.

## Secrets

All secrets live in `~/.config/*.env`, outside the repo, and `.gitignore` blocks `*.env`. Never commit tokens, keys, IPs or wallet details.

## Requirements

- Linux with systemd, Python 3 (standard library only), `curl`
- Bitcoin Core v30+ (multiprocess), sv2-tp, dmnd-client, a Bitaxe: see GUIDE.md
- A free Cloudflare account (dashboard only)
