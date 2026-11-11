#!/usr/bin/env python3
"""Cuts the owner's two Grok dice cups (11-06) out of their black backgrounds, for Cup & Claim's table and your cup panel.

In:  art-source/cups/2026-11-06-dice-cup-down-grok-A.png   the cup turned down over the dice: covered, in play
     art-source/cups/2026-11-06-dice-cup-upright-grok.png  the cup stood up, mouth open: lifted, the dice revealed
     (both kept exactly as the owner made them)
Out: public/art/dice/cup-down.webp and cup-up.webp (with alpha), and lossless PNG copies beside the sources.

The cut: the subject is everything brighter than the near-black background (low enough to keep the leather's shadowed
side), closed over small gaps, its holes filled, the largest piece only. A cup is round, so its outline is the same either
side of its axis: the outline is kept only where its mirror image agrees, which takes off the warm flare Grok painted off
the down cup's rim (it's on one side only, and it's background). Then the outline is smoothed and feathered over about a
pixel, so no black fringe and no halo is left. The picture inside the outline is untouched:
no recolour, no relight (the page lights each cup for its place at the table). Then it's cropped to the cup and scaled to
a height the page never draws it larger than (2x for a sharp phone).
Needs Pillow, numpy, scipy and cwebp.   Usage: python3 scripts/art/cups-grok.py
"""
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / 'art-source/cups'
OUT = ROOT / 'public/art/dice'
CUPS = {
    'cup-down': ('2026-11-06-dice-cup-down-grok-A.png', 12),
    'cup-up': ('2026-11-06-dice-cup-upright-grok.png', 12),
}
HEIGHT = 720  # px (round 3, 11-07): the page draws your cup up to ~150 CSS px tall, and a phone screen is 3x, so 720 keeps it sharp
SMALL = 240  # px: the cups on the table and on the badges are drawn under 80 CSS px; a copy this size, sharpened after the
#            resize, reads crisper than the browser's own shrink of the big one (cup-down-s.webp, cup-up-s.webp)


def cut(path, threshold):
    img = Image.open(path).convert('RGB')
    a = np.asarray(img)
    v = a.max(axis=2)
    m = v > threshold
    m = ndimage.binary_opening(m, iterations=2)  # specks of noise off the subject
    m = ndimage.binary_closing(m, structure=np.ones((9, 9)))  # the dark seams and stitches inside the outline
    m = ndimage.binary_fill_holes(m)
    labels, n = ndimage.label(m)
    if n > 1:
        sizes = ndimage.sum(m, labels, range(1, n + 1))
        m = labels == (1 + int(np.argmax(sizes)))
    # the axis: the middle of the cup's widest rows (its band), where the outline is surest
    rows = np.where(m.any(axis=1))[0]
    widths = m.sum(axis=1)
    band = rows[widths[rows] >= np.percentile(widths[rows], 90)]
    cols = np.where(m[band].any(axis=0))[0]
    axis2 = cols.min() + cols.max()  # twice the axis column
    mirror = np.zeros_like(m)
    xs = np.arange(m.shape[1])
    src = axis2 - xs
    ok = (src >= 0) & (src < m.shape[1])
    mirror[:, xs[ok]] = m[:, src[ok]]
    m = m & mirror
    # smooth the outline (Grok's pixel steps along the edge are noise at this scale), then a feathered edge of ~1 px
    soft = ndimage.gaussian_filter(m.astype(np.float64), 3) > 0.5
    soft = ndimage.binary_erosion(soft, iterations=1)  # off the darkest edge pixels, where the black bled in
    alpha = Image.fromarray((soft * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2))
    out = img.convert('RGBA')
    out.putalpha(alpha)
    box = alpha.point(lambda p: 255 if p > 8 else 0).getbbox()
    out = out.crop(box)
    return out, box


def sized(out, height, sharpen):
    w = round(out.width * height / out.height)
    img = out.resize((w, height), Image.LANCZOS)
    if sharpen:  # a mild unsharp mask on the colour only; the alpha edge stays as feathered as it was
        rgb = img.convert('RGB').filter(ImageFilter.UnsharpMask(radius=1.2, percent=90, threshold=2))
        img = rgb.convert('RGBA')
        img.putalpha(out.getchannel('A').resize((w, height), Image.LANCZOS))
    return img


def main():
    for name, (file, threshold) in CUPS.items():
        cut_out, box = cut(SRC / file, threshold)
        for suffix, height, sharpen in (('', HEIGHT, False), ('-s', SMALL, True)):
            cup = sized(cut_out, height, sharpen)
            png = SRC / f'{name}{suffix}.png'
            cup.save(png, optimize=True)
            webp = OUT / f'{name}{suffix}.webp'
            subprocess.run(['cwebp', '-quiet', '-q', '90', '-alpha_q', '100', '-exact', '-m', '6', str(png), '-o', str(webp)], check=True)
            print(f'{name}{suffix}: from {file} box {box}, {cup.width} x {cup.height}, {webp.stat().st_size // 1024} KB')


main()
