#!/usr/bin/env python3
"""Builds the Cup & Claim room from the owner's Grok picture, exactly as he made it: re-encoded for the page, nothing else.

In:  art-source/table-room/2026-11-06-cup-claim-table-grok.jpg (The owner's picture, kept untouched)
Out: public/art/dice/table-room-1152.webp

The tapestry keeps its own art (The owner, 11-06): the official Midnight symbol is no longer woven into the picture. The page
lays the brand file itself over the cloth, at a lower opacity, and leaves it out whenever the frame would cut it
(public/js/dice.js, MARK). Needs cwebp.   Usage: python3 scripts/art/table-room.py
"""
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / 'art-source/table-room/2026-11-06-cup-claim-table-grok.jpg'
OUT_WEBP = ROOT / 'public/art/dice/table-room-1152.webp'

subprocess.run(['cwebp', '-quiet', '-q', '84', '-m', '6', '-sharp_yuv', str(SRC), '-o', str(OUT_WEBP)], check=True)
print(f'{OUT_WEBP.name}: from {SRC.name}, {OUT_WEBP.stat().st_size // 1024} KB')
