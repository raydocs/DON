"""One-shot: copy official DonutBrowser profiles into DON data dir."""
from __future__ import annotations

import json
import shutil
import time
from pathlib import Path

src_root = Path.home() / "AppData/Local/DonutBrowser/profiles"
dst_root = Path.home() / "AppData/Local/DON/profiles"
dst_root.mkdir(parents=True, exist_ok=True)

# Donut proxy UUID -> DON US-Pro proxy UUID (same exit IP 69.33.36.235)
PROXY_MAP = {
    "ce84f7ae-d9fa-4e84-a07b-40717ef8c209": "04d35260-8475-47d6-a214-530d40d1fdb9",
}


def main() -> None:
    if not src_root.is_dir():
        raise SystemExit(f"Source not found: {src_root}")

    results: list[str] = []
    for src_dir in sorted(src_root.iterdir()):
        if not src_dir.is_dir():
            continue
        meta_path = src_dir / "metadata.json"
        if not meta_path.exists():
            continue
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        name = meta.get("name", src_dir.name)
        pid = meta.get("id") or src_dir.name

        dst_dir = dst_root / pid
        if dst_dir.exists():
            results.append(f"SKIP exists: {name} ({pid})")
            continue

        # Copy full profile tree (cookies, local storage, fingerprint, etc.)
        shutil.copytree(src_dir, dst_dir)

        meta_dst = dst_dir / "metadata.json"
        meta = json.loads(meta_dst.read_text(encoding="utf-8"))
        old_proxy = meta.get("proxy_id")
        if old_proxy in PROXY_MAP:
            meta["proxy_id"] = PROXY_MAP[old_proxy]
        meta["process_id"] = None

        tags = list(meta.get("tags") or [])
        for t in ("migrated-from-donut",):
            if t not in tags:
                tags.append(t)
        if meta.get("proxy_id") and "claude" not in tags:
            tags.append("claude")
            if "residential" not in tags:
                tags.append("residential")
            if "don-isolation" not in tags:
                tags.append("don-isolation")
        meta["tags"] = tags

        note = meta.get("note") or ""
        stamp = time.strftime("%Y-%m-%d")
        migrate_line = f"migrated_from: DonutBrowser ({stamp})"
        if "migrated_from:" not in note:
            note = (note + "\n" if note.strip() else "") + migrate_line
        if meta.get("proxy_id") and "start_url:" not in note:
            note += "\nstart_url: https://claude.com"
            note += "\nproxy_lease_days: 3"
            if "card:" not in note.lower():
                note += "\ncard: card-A (migrated — set your label)"
            if "residential:" not in note.lower():
                note += "\nresidential: US-Pro-69.33.36.235"
        meta["note"] = note.strip() + "\n"
        meta["last_sync"] = None

        meta_dst.write_text(
            json.dumps(meta, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

        size_mb = sum(
            f.stat().st_size for f in dst_dir.rglob("*") if f.is_file()
        ) / (1024 * 1024)
        results.append(
            f"OK {name} -> proxy={meta.get('proxy_id')} "
            f"size={size_mb:.1f}MB id={pid}"
        )

    print("\n".join(results) if results else "No profiles found")
    print("--- DON profiles now ---")
    for d in sorted(dst_root.iterdir()):
        mp = d / "metadata.json"
        if mp.exists():
            m = json.loads(mp.read_text(encoding="utf-8"))
            print(m.get("name"), m.get("proxy_id"), m.get("tags"))


if __name__ == "__main__":
    main()
