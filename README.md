# DMNDsv2Solo: mine on your own block templates

Your own Bitcoin node builds the block, a Bitaxe mines it, and the [DMND](https://dmnd.work) pool pays you. It uses [Stratum V2](https://stratumprotocol.org) Job Declaration.

```
Bitcoin Core ──▶ sv2-tp ──▶ DMND client ──▶ Bitaxe
```

## How to set it up

You need an always-on Linux machine (~80 GB disk, 8 GB RAM), a Bitaxe, and a DMND token ([sign up](https://new-platform.dmnd.work/signup); the token arrives by email).

1. Install **[Bitcoin Core](https://bitcoincore.org/en/download/)**, pruned, and let it sync (1–2 days).
2. Install **[sv2-tp](https://github.com/stratum-mining/sv2-tp)** (the Stratum V2 Template Provider).
3. Build and run the **[DMND client](https://github.com/dmnd-pool/dmnd-client)**.
4. Point your **Bitaxe** at `<your LAN IP>:32767`, password = your DMND token.
5. Open **http://127.0.0.1:3001/dashboard/overview** to check it works.

👉 **Step-by-step commands: [GUIDE.md](GUIDE.md)**

Tip: open this folder in an AI coding assistant (Claude Code, Codex, Cursor) and say *"Follow GUIDE.md one step at a time."* It reads [AGENTS.md](AGENTS.md).

## Optional extras

- **Public dashboard** to share your stats: [DASHBOARD.md](DASHBOARD.md) ([live example](https://bitcoin-node.alejandro-d92.workers.dev/))
- **Block Hunter**, let a crowd vote on your block: [blockhunter/README.md](blockhunter/README.md) ([live example](https://block-hunter.alejandro-d92.workers.dev/))
- **RSK merge mining**: [GUIDE.md](GUIDE.md#optional-also-mine-rsk-merge-mining)

Secrets live in `~/.config/*.env`, never in the repo.
