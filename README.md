# Bitcoin node dashboard

A small public dashboard for a local Bitcoin Core node, hosted on Cloudflare Workers.

- `worker.js` is the Worker. It serves the page at `/`, public aggregate stats at `/api/stats`, and accepts snapshots at `POST /api/push` (Bearer write key).
- `collector.py` runs on the node's machine, reads `bitcoin-cli`, and pushes aggregate stats only (no peer addresses, no hostnames).
- `deploy.sh` uploads the Worker through the Cloudflare REST API (no Node or wrangler needed). It creates the KV namespace and a write key on first run.

## Setup

1. Put a Cloudflare API token (Workers Scripts + Workers KV Storage write) in `~/.config/cloudflare.env`:

   ```
   CLOUDFLARE_API_TOKEN=...
   ```

2. Edit `ACCOUNT`, `NAME` and `SUBDOMAIN` at the top of `deploy.sh`, then run `./deploy.sh`.
   It writes the push URL and a generated write key to `~/.config/btc-dashboard.env`.
3. Schedule `collector.py` every 2 minutes (a systemd user timer or cron). Cloudflare's free KV plan allows
   1,000 writes per day and each push is one write, so 2 minutes is the practical floor.

Secrets stay in `~/.config/`, outside this folder.
