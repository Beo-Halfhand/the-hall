#!/usr/bin/env python3
"""Builds public/og.jpg, the 1200x630 link-preview image (Discord, X, iMessage).

Base art: The owner's picture, already cropped to 1200x630 (default $ART_ORIGINALS/Images/hall-og-1200x630.png,
or pass a path). The text goes on the dark left side, by the jug and chair, clear of the fireplace, cups and window:
"The / Hall" big (hand-made 5x7 pixel font at 11x), "Sealed Hand / Cup & Claim" at 4x, "halfhand.app" at 3x.
Brass letters, a hard one-pixel-step shadow plus a soft dark blur, and a gentle dark ramp on the left edge so it reads at Discord's small size.
Exports a progressive JPEG (about 150-250 KB). Needs Pillow. No machine details in the image.
Usage: python3 scripts/art/make-og.py [base.png] [--final out.jpg]
"""
import os
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
argv = sys.argv[1:]
if '--final' in argv:
    i = argv.index('--final'); EXTRA = Path(argv[i + 1]); del argv[i:i + 2]
else:
    EXTRA = None
args = argv
SRC = Path(args[0]) if args else Path(os.environ.get('ART_ORIGINALS', 'art-source/originals')) / 'Images/hall-og-1200x630.png'
OUT = ROOT / 'public/og.jpg'
W, H = 1200, 630

BRASS, BRASS_HI, EMBER, IVORY = (249, 194, 43), (255, 224, 130), (240, 160, 70), (253, 220, 190)

# 5-wide bitmap font, 9 rows: rows 0-6 are cap height (baseline row 6), rows 7-8 descend.
def g(*rows, top=0):
    rows = [r for r in rows]
    return ['00000'] * top + rows + ['00000'] * (9 - top - len(rows))
FONT = {
    'T': g('11111', '00100', '00100', '00100', '00100', '00100', '00100'),
    'H': g('10001', '10001', '10001', '11111', '10001', '10001', '10001'),
    'C': g('01110', '10001', '10000', '10000', '10000', '10001', '01110'),
    'S': g('01111', '10000', '10000', '01110', '00001', '00001', '11110'),
    'h': g('10000', '10000', '10110', '11001', '10001', '10001', '10001'),
    'e': g('01110', '10001', '11111', '10000', '01110', top=2),
    'a': g('01110', '00001', '01111', '10001', '01111', top=2),
    'l': g('01100', '00100', '00100', '00100', '00100', '00100', '01110'),
    'd': g('00001', '00001', '01101', '10011', '10001', '10011', '01101'),
    'n': g('10110', '11001', '10001', '10001', '10001', top=2),
    'u': g('10001', '10001', '10001', '10011', '01101', top=2),
    'p': g('10110', '11001', '10001', '10001', '11110', '10000', '10000', top=2),
    'i': g('00100', '00000', '01100', '00100', '00100', '00100', '01110'),
    'm': g('11010', '10101', '10101', '10101', '10101', top=2),
    'f': g('00110', '01001', '01000', '11100', '01000', '01000', '01000'),
    '&': g('01100', '10010', '10100', '01000', '10101', '10010', '01101'),
    '.': g('00000', '00000', '00000', '00000', '00000', '00000', '10000'),
    '·': g('00000', '00000', '00000', '10000', '00000', '00000', '00000'),
    ' ': ['00000'] * 9,
}
ADV = {' ': 3, '.': 2, '·': 2, 'l': 4, 'i': 4}   # advance in text pixels (default 6)

def width(text, px):
    return sum(ADV.get(c, 6) for c in text) * px - px   # minus the trailing gap

def draw_text(d, x, y, text, px, fill):
    """x,y = top-left of the cap line. Shadow is one text-pixel down and right (two for the big title)."""
    cx = x
    for c in text:
        for r, row in enumerate(FONT[c]):
            for k, bit in enumerate(row):
                if bit == '1':
                    d.rectangle([cx + k * px, y + r * px, cx + (k + 1) * px - 1, y + (r + 1) * px - 1], fill=fill)
        cx += ADV.get(c, 6) * px


base = Image.open(SRC).convert('RGB')
assert base.size == (W, H), base.size

# gentle dark ramp on the left so the text has ground (0.55 at the edge -> 0 at x=430)
ramp = Image.new('L', (W, H), 0)
rp = ramp.load()
for x in range(430):
    v = int(255 * 0.55 * (1 - x / 430) ** 1.5)
    for y in range(H):
        rp[x, y] = v
base = Image.composite(Image.new('RGB', (W, H), (12, 6, 8)), base, ramp)

lines = [(('The', 11, BRASS, 30), 70), (('Hall', 11, BRASS, 30), 160),
         (('Sealed Hand', 4, IVORY, 30), 262), (('Cup & Claim', 4, IVORY, 30), 296),
         (('halfhand.app', 3, EMBER, 30), 352)]
X0 = 30
shadow = Image.new('L', (W, H), 0)
sd = ImageDraw.Draw(shadow)
hard = Image.new('L', (W, H), 0)
hd = ImageDraw.Draw(hard)
text = base.copy()
td = ImageDraw.Draw(text)
for (t, px, col, _), y in lines:
    draw_text(sd, X0, y, t, px, 255)
    draw_text(hd, X0 + max(2, px // 2), y + max(2, px // 2), t, px, 255)
soft = shadow.filter(ImageFilter.GaussianBlur(9)).point(lambda v: min(255, v * 2))
for mask, alpha in ((soft, 0.9), (hard, 0.85)):
    m = mask.point(lambda v, a=alpha: int(v * a))
    base = Image.composite(Image.new('RGB', (W, H), (10, 5, 6)), base, m)
td = ImageDraw.Draw(base)
for (t, px, col, _), y in lines:
    draw_text(td, X0, y, t, px, col)
    if px >= 11:                                  # a lit top edge on the big letters: first row of each text pixel
        pass

assert base.size == (W, H)
OUT.parent.mkdir(exist_ok=True)
for q in (84, 80, 76, 72, 68):
    base.save(OUT, 'JPEG', quality=q, optimize=True, progressive=True, subsampling=0)
    if OUT.stat().st_size <= 240_000:
        break
if EXTRA:
    EXTRA.write_bytes(OUT.read_bytes())
print(OUT, base.size, OUT.stat().st_size, 'bytes, q', q)
