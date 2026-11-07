# Mine on your own block templates: node → sv2-tp → DMND client → Bitaxe

This guide sets up a Bitaxe that mines on **block templates built by your own Bitcoin node**, using Stratum V2 Job Declaration with the DMND pool. You choose which transactions go into the block, and the pool only pays you.

```
Bitcoin Core ──IPC──▶ sv2-tp ──SV2──▶ dmnd-client ──SV1──▶ Bitaxe
 (your node)       (templates)      (Job Declaration)     (hashing)
                                          │
                                          ▼
                                      DMND pool
```

I ran all of this on one Linux laptop. Plan for about an hour of work, plus 1–2 days for the node to sync.

---

## 0. What you need

- An always-on Linux machine with **~80 GB free disk** (pruned node) and 8 GB+ RAM
- A **Bitaxe** (or any SV1 miner) on the same network
- A **DMND token**: register at https://join.dmnd.work and the token arrives by email
- Rust (`rustup`) to build the client

Throughout this guide, `<LAN-IP>` means your machine's local IP (find it with `hostname -I`).

---

## 1. Bitcoin Core v30+ in multiprocess mode

Download Bitcoin Core (v30 or newer, I used v32.1) from https://bitcoincore.org and **verify the signatures**. The release includes a `bitcoin` wrapper command that can start the multiprocess node.

`~/.bitcoin/bitcoin.conf`:

```ini
prune=60000      # keep ~60 GB of blocks
dbcache=4000     # faster sync; lower it on low-RAM machines
server=1
```

Start the node with IPC enabled:

```bash
bitcoin -m node -ipcbind=unix
```

This creates `~/.bitcoin/node.sock`, the socket sv2-tp talks to.

**✅ Check:** `bitcoin-cli getblockchaininfo` and wait until `initialblockdownload` is `false`. Mining before the sync finishes won't work.

---

## 2. sv2-tp (the Template Provider)

Download sv2-tp (I used v1.1.2) from https://github.com/stratum-mining/sv2-tp/releases and verify it. Its README is the reference: https://github.com/stratum-mining/sv2-tp#readme

`~/.bitcoin/sv2-tp.conf`:

```ini
chain=main
ipcconnect=unix
sv2port=8336
```

Start it:

```bash
./bin/sv2-tp
```

**✅ Check:** `ss -ltn | grep 8336` shows it listening on `127.0.0.1:8336`.

---

## 3. DMND client (Job Declaration)

> ⚠️ **Build from source.** The v0.3.30 release binary got stuck in a loop for me: the pool dropped Job Declaration every ~30 s and the Bitaxe never got work. Building `master` fixed it. Once a newer release than v0.3.30 is out, try that first.

```bash
git clone https://github.com/dmnd-pool/dmnd-client.git
cd dmnd-client
cargo build --release
```

Put your token in a file that only you can read, e.g. `~/.config/dmnd.env`:

```ini
TOKEN=<your-DMND-token>
```

```bash
chmod 600 ~/.config/dmnd.env
```

Run it:

```bash
set -a; . ~/.config/dmnd.env; set +a
./target/release/dmnd-client -l info -d 1T \
  --tp-address=127.0.0.1:8336 \
  --miner-name <your-name>
```

- `-d 1T`: your expected hashrate (a Bitaxe Gamma does ~1.1 TH/s)
- `--miner-name`: puts `/DMND/<your-name>/` in the coinbase of your templates
- The client listens for miners on port **32767** and serves a local dashboard at http://127.0.0.1:3001

---

## 4. Bitaxe

In the Bitaxe web UI (AxeOS), go to **Settings → Pool** and set:

| Field    | Value                   |
|----------|-------------------------|
| URL      | `<LAN-IP>`              |
| Port     | `32767`                 |
| User     | anything, e.g. `bitaxe` |
| Password | your DMND token         |

Save and restart the Bitaxe.

**✅ Check:** the Bitaxe shows as connected and hashing within a minute. Expect the first accepted shares **within ~6 minutes**.

---

## 5. Survive reboots (systemd user services)

Create three files in `~/.config/systemd/user/`, replacing the paths with your own.

`bitcoind.service`:

```ini
[Unit]
Description=Bitcoin Core (multiprocess)

[Service]
ExecStart=/path/to/bitcoin -m node -ipcbind=unix
Restart=on-failure
RestartSec=15
TimeoutStopSec=600

[Install]
WantedBy=default.target
```

`sv2-tp.service`:

```ini
[Unit]
Description=sv2 Template Provider
After=bitcoind.service
Wants=bitcoind.service

[Service]
# wait for the node's IPC socket before starting
ExecStartPre=/bin/sh -c 'for i in $(seq 1 120); do [ -S %h/.bitcoin/node.sock ] && exit 0; sleep 5; done; exit 1'
ExecStart=/path/to/sv2-tp
Restart=on-failure
RestartSec=15

[Install]
WantedBy=default.target
```

`dmnd-client.service`:

```ini
[Unit]
Description=DMND client (Job Declaration)
After=sv2-tp.service
Wants=sv2-tp.service

[Service]
EnvironmentFile=%h/.config/dmnd.env
ExecStart=/path/to/dmnd-client -l info -d 1T --tp-address=127.0.0.1:8336 --miner-name <your-name>
Restart=on-failure
RestartSec=15

[Install]
WantedBy=default.target
```

Enable them, and let them run without you being logged in:

```bash
systemctl --user daemon-reload
systemctl --user enable --now bitcoind sv2-tp dmnd-client
sudo loginctl enable-linger $USER
```

Logs: `journalctl --user -u dmnd-client -f`

---

## 6. Is it working?

- [ ] Node synced (`initialblockdownload: false`)
- [ ] sv2-tp listening on 8336
- [ ] Client logs show templates and accepted custom jobs, with no reconnect loop
- [ ] The client dashboard at http://127.0.0.1:3001 shows your templates
- [ ] Bitaxe connected, hashing, shares accepted

---

## Things that tripped me up

- **Release binary loop.** If the client keeps reconnecting every ~30 s and the miner shows "Not connected", build from source (see step 3).
- **Don't restart the client over and over.** Several restarts within an hour made the pool reject custom jobs (`SetCustomMiningJobError`) for ~6 minutes. It recovers on its own, so wait before deciding something is broken.
- **Laptop sleep stops everything.** Disable suspend, or use a machine that stays on.
- **Keep your token secret.** It's both your pool identity and the Bitaxe password. Don't paste it in chats or commit it.
- **Port 3001 is for your LAN only.** Never expose the client dashboard to the internet.

## Links

- DMND client: https://github.com/dmnd-pool/dmnd-client
- sv2-tp: https://github.com/stratum-mining/sv2-tp
- Stratum V2: https://stratumprotocol.org
- See the block you're mining: https://blog.dmnd.work/see-the-block-youre-mining/
