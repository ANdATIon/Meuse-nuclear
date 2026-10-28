#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Fetch ENTSO-E generation and outages data and save as JSON.
Reads token from ENTSOE_TOKEN env var and imports core logic from server.py.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Add project root to sys.path so server can be imported directly
ROOT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT_DIR))

import server


def ensure_token():
    token = os.environ.get("ENTSOE_TOKEN", "").strip()
    if not token:
        print("ERROR: ENTSOE_TOKEN environment variable is not set.", file=sys.stderr)
        sys.exit(1)


def main():
    ensure_token()

    data_dir = ROOT_DIR / "data"
    data_dir.mkdir(parents=True, exist_ok=True)

    today = server.utc_today()

    # Generation window (default 30 days back to today + 1 day)
    gen_days = server.CONFIG["default_generation_days"]
    gen_start = today - timedelta(days=gen_days)
    gen_end = today + timedelta(days=1)

    print(f"Fetching generation data from {gen_start.date()} to {gen_end.date()}...")
    gen_payload = server.build_generation_payload(gen_start, gen_end, force=True)

    # If any days were pending/downloading in background threads, wait for them to finish
    cursor = gen_start
    keys = []
    while cursor < gen_end:
        keys.append(server._day_key(cursor))
        cursor += timedelta(days=1)

    # Wait on any pending generation background tasks
    for zone_key in server.ZONES:
        for key in keys:
            with server._GEN_LOCK:
                future = server._GEN_JOBS.get((zone_key, key))
            if future:
                try:
                    future.result()
                except Exception as err:
                    print(f"Warning: Failed downloading {zone_key} {key}: {err}", file=sys.stderr)

    # Rebuild final generation payload with all downloaded days
    gen_payload = server.build_generation_payload(gen_start, gen_end, force=False)

    gen_file = data_dir / "generation.json"
    gen_file.write_text(json.dumps(gen_payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {gen_file}")

    # Outages window
    out_back = server.CONFIG["default_outage_back_days"]
    out_fwd = server.CONFIG["default_outage_forward_days"]
    out_start = today - timedelta(days=out_back)
    out_end = today + timedelta(days=out_fwd)

    print(f"Fetching outages data from {out_start.date()} to {out_end.date()}...")
    out_payload = server.build_outages_payload(out_start, out_end)

    out_file = data_dir / "outages.json"
    out_file.write_text(json.dumps(out_payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {out_file}")


if __name__ == "__main__":
    main()
