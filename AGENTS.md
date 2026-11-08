# Instructions for AI assistants

This repo has two parts:

1. **The mining stack** (Bitcoin Core → sv2-tp → dmnd-client → Bitaxe). The setup steps are in [GUIDE.md](GUIDE.md). Nothing in this repo runs it; the guide uses upstream binaries.
2. **The dashboard** (`collector.py`, `worker.js`, `deploy.sh`, plus the optional `template_watch.py` service), described in [README.md](README.md).

## Helping someone set up the mining stack

- Follow GUIDE.md **in order, one step at a time**, and run its "✅ Check" before moving on. Mining cannot work until the node is fully synced (`initialblockdownload: false`), which takes 1–2 days.
- **Ask before** using `sudo`, opening ports, downloading binaries, or changing a running service.
- **Verify downloads** (Bitcoin Core and sv2-tp release signatures) rather than skipping it.
- **The DMND token is a secret.** Ask the user to put it in `~/.config/dmnd.env` themselves (`chmod 600`). Never print it, echo it, log it, or put it in a command line, a commit, or chat. To check a value is set, print the key name only (e.g. `sed -E 's/=.*/=<set>/' ~/.config/dmnd.env`).
- Find the machine's LAN IP with `hostname -I`; the Bitaxe pool URL is that IP, port `32767`, password = the DMND token (the user types it into the Bitaxe UI).

### Known problems

- **dmnd-client v0.3.30 release loops**: the pool drops Job Declaration every ~30 s and the miner shows "Not connected". Build from source (`cargo build --release` on `master`). Prefer a newer signed release if one exists.
- **Repeated client restarts** within an hour make the pool reject custom jobs (`SetCustomMiningJobError`) and disconnect for ~6 minutes. It recovers on its own: wait at least 10 minutes before concluding a change broke something, and don't restart in a loop.
- **sv2-tp starts before the node socket exists** → it fails. The systemd unit in GUIDE.md waits for `~/.bitcoin/node.sock`.
- **Laptop suspend** stops everything. Check the power settings.
- **RSK merge mining** (optional, see GUIDE.md): enabled by a non-empty `API_SECRET` in `~/.config/dmnd.env`. Sync RskJ with `--import` once (it wipes the DB, so never in a service). Do not print `API_SECRET` or `rsk-bridge.env`. The merge-mining status endpoint takes `API_TX_TOKEN`, not `API_SECRET`.
- The client listens on `0.0.0.0:3001` for its local dashboard/API; keep it off the public internet.

## Working on the dashboard code

- **No build step and no dependencies.** Python 3 standard library only; the Worker is one plain JS file.
- The page has five tabs (`p-over`, `p-block`, `p-miner`, `p-market`, `p-nodes`); new sections go in the tab where a reader would look for them. `worker.js` holds the whole page in `const PAGE = String.raw\`...\``. Inside the page, **never use backticks or `${`**. Use string concatenation and single quotes in the page's JS, and never put an apostrophe inside a single-quoted string (write \u2019 or reword).
- **Privacy rule: publish aggregates only.** Never send txids, addresses, IPs, hostnames, peer details, tokens, pool usernames or wallet data to the Worker. The Worker's `sanitize*` functions whitelist and clamp every field; add new fields there, or they are dropped. Pushes over 40,000 bytes are rejected.
- `collector.py` must keep working when parts are missing (no Bitaxe, no DMND client, no RPC credentials): wrap each source and return `None` on failure.
- Config comes only from `~/.config/btc-dashboard.env`, `~/.config/dmnd.env` and `~/.config/cloudflare.env`. Never hard-code personal paths, IPs, account IDs or keys.

### The live diagram

- `WIDE` and `TALL` in `worker.js` define the two layouts (boxes, outlines, links). A link is `[key, colour, path, label position, label, dy]`; `dy` is where the value line sits (`null` for none). Link state comes from `derive()`.
- Dots on the lines use SVG `animateMotion` at an illustrative pace; the real rates only set the spacing. Respect `prefers-reduced-motion`.
- The page refreshes every 30 s but the collector pushes every 2 min, so flashes and toasts fire when new data shows a change, not at the exact moment.
- A background browser pane throttles timers: to test event detection, extract the function and run it in isolation.

### Block Hunter (`blockhunter/`)

- A separate Worker with one Durable Object. `page.html` is joined into `worker.js` by `deploy.sh` (same rule: no backticks or `${` in the page). Never print `WRITE_KEY` or `ACCESS_CODE`.
- `runner.py` is the only code that changes the node. Keep it outbound-only, keep `MODE=dry` the default, record deltas before applying them, and never skip the gate. Do not switch to live mode without the user saying so in the current conversation.
- Tests: `python3 -I tests/test_blockhunter.py`.

### Testing changes

- `python3 -I tests/test_template_watch.py` tests the template watcher (no network needed).
- `python3 -I collector.py` runs one collection and push (needs the env files).
- `./deploy.sh` redeploys the Worker; it's safe to re-run (keeps the KV store and write key).
- To test the page without deploying: extract `PAGE` into an `.html` file, serve it with `python3 -m http.server`, and serve a sample `api/stats` JSON next to it. Check the browser console for errors and check narrow (phone) widths.

### Before committing

- `git diff` must contain no secrets, IPs or personal paths.
- Don't commit `*.env`, caches or `__pycache__/` (already in `.gitignore`).
