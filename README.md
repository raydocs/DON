# DON

**Local AGPL-3.0 fork of [Donut Browser](https://github.com/zhom/donutbrowser).**  
**Version 0.0.1 — not affiliated with official Donut.**

Open-source anti-detect browser manager (Tauri + Wayfern), customized for personal use:

- All local “Pro” capabilities unlocked (no paid plan required for fingerprint edit / automation)
- Safer fingerprint generation (host DPR + screen bounds, no randomize-on-launch by default)
- Isolated app id and data dir so official Donut installs are untouched
- Official auto-updates disabled

See **[FORK.md](./FORK.md)** for the full delta list and license notes.

## Quick start

```bash
pnpm install
pnpm tauri dev      # development
pnpm tauri build    # release installer
```

## Data location (Windows)

| Build | Directory |
|-------|-----------|
| Release | `%LOCALAPPDATA%\DON\` |
| Debug | `%LOCALAPPDATA%\DONDev\` |

Official Donut still uses `%LOCALAPPDATA%\DonutBrowser\`.

## License

AGPL-3.0 — same as upstream. Distribute source with binaries; do not rebrand as official Donut.
