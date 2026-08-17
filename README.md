# DON

**Local AGPL-3.0 fork of [Donut Browser](https://github.com/zhom/donutbrowser).**  
**Version 0.0.2 — not affiliated with official Donut.**

Open-source anti-detect browser manager (Tauri + Wayfern), customized for personal use:

- All local “Pro” capabilities unlocked (no paid plan required for fingerprint edit / automation)
- Safer fingerprint generation (host DPR + screen bounds, no randomize-on-launch by default)
- Isolated app id and data dir so official Donut installs are untouched
- Private app updates from this fork only; official Donut releases are never installed

See **[FORK.md](./FORK.md)** for the full delta list and license notes.

## Quick start

```bash
pnpm install
pnpm tauri dev      # development
pnpm tauri build    # release installer
```

Private release checks authenticate with `DON_GITHUB_TOKEN`, `GH_TOKEN`,
`GITHUB_TOKEN`, or an existing GitHub CLI login (`gh auth login`). The token is
kept in memory only and must have read access to `raydocs/DON`.

## Data locations

| Platform | Release | Debug |
|----------|---------|-------|
| macOS | `~/Library/Application Support/DON/` | `~/Library/Application Support/DONDev/` |
| Windows | `%LOCALAPPDATA%\DON\` | `%LOCALAPPDATA%\DONDev\` |

Official Donut continues to use `DonutBrowser`, so the two installations do not share profile data.

## License

AGPL-3.0 — same as upstream. Distribute source with binaries; do not rebrand as official Donut.
