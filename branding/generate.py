#!/usr/bin/env python3
"""Generates the Redline logo files (outlined SVG, no font needed to display them).

Needs fontTools and a heavy sans font. By default Arial Black from macOS; point
REDLINE_FONT at any bold TTF to rebuild elsewhere. The generated SVG files are
committed, so this is only needed to change the logo.
"""
import os
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

FONT_PATH = os.environ.get("REDLINE_FONT", "/System/Library/Fonts/Supplemental/Arial Black.ttf")
FONT = TTFont(FONT_PATH)
GS, CMAP, UPM = FONT.getGlyphSet(), FONT.getBestCmap(), FONT["head"].unitsPerEm
H = GS[CMAP[ord("H")]]
from fontTools.pens.boundsPen import BoundsPen
_bp = BoundsPen(GS)
H.draw(_bp)
CAP = _bp.bounds[3]  # cap height in font units, measured from "H"

RED = "#ff2a2a"
OUT = Path(__file__).resolve().parent


def glyph(ch, x, size, color):
    name = CMAP[ord(ch)]
    pen = SVGPathPen(GS)
    s = size / UPM
    GS[name].draw(TransformPen(pen, (s, 0, 0, -s, x, 0)))
    return f'<path d="{pen.getCommands()}" fill="{color}"/>', GS[name].width * s


def tilt_i(x, cap):
    """The slanted I: a callback to the tilted i of the TiltAlert logo, and a route line."""
    bw, sk = cap * 0.25, cap * 0.24
    return f'<path d="M{x + sk:.1f},{-cap:.1f} L{x + sk + bw:.1f},{-cap:.1f} L{x + bw:.1f},0 L{x:.1f},0 Z" fill="{RED}"/>', cap * 0.5


def wordmark(size, neutral, track=0.02):
    cap = CAP * size / UPM
    out, x = [], 0.0
    for kind, content, color in (("t", "RED", RED), ("t", "L", neutral), ("i", None, None), ("t", "NE", neutral)):
        if kind == "t":
            for ch in content:
                svg, adv = glyph(ch, x, size, color)
                out.append(svg)
                x += adv + track * size
        else:
            svg, w = tilt_i(x, cap)
            out.append(svg)
            x += w + track * size
    return "".join(out), x - track * size, cap


def tagline(size, grey, y):
    words, out, x = ("TRACK", "PREDICT", "SURVIVE"), [], 0.0
    gap = size * 1.4
    for i, w in enumerate(words):
        color = RED if i == 1 else grey
        for ch in w:
            svg, adv = glyph(ch, x, size, color)
            out.append(f'<g transform="translate(0,{y})">{svg}</g>')
            x += adv + size * 0.12
        if i < 2:
            out.append(f'<circle cx="{x + gap / 2:.1f}" cy="{y - size * 0.35:.1f}" r="{size * 0.07:.1f}" fill="{grey}"/>')
            x += gap
    return "".join(out), x


def logo(neutral, grey, with_tagline=True, size=140, bg=None):
    body, w, cap = wordmark(size, neutral)
    pad = 28
    tag, tw = tagline(size * 0.2, grey, cap * 0.0 + size * 0.50) if with_tagline else ("", 0)
    width = max(w, tw) + 2 * pad
    height = cap + (size * 0.50 + size * 0.04 if with_tagline else 0) + 2 * pad
    rect = f'<rect x="{-pad}" y="{-cap - pad}" width="{width:.0f}" height="{height:.0f}" fill="{bg}"/>' if bg else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{-pad} {-cap - pad:.0f} {width:.0f} {height:.0f}" '
            f'width="{width:.0f}" height="{height:.0f}" role="img" aria-label="Redline: Track, Predict, Survive">'
            f'{rect}{body}{tag}</svg>')


def icon():
    s = 256
    w = s * 0.14
    cx, cy = s / 2, s / 2
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {s} {s}" width="{s}" height="{s}">'
            f'<rect width="{s}" height="{s}" rx="{s * 0.22:.0f}" fill="#0b0b0c"/>'
            f'<path d="M{cx + s * 0.13:.1f},{cy - s * 0.3:.1f} L{cx + s * 0.13 + w:.1f},{cy - s * 0.3:.1f} '
            f'L{cx - s * 0.13:.1f},{cy + s * 0.3:.1f} L{cx - s * 0.13 - w:.1f},{cy + s * 0.3:.1f} Z" fill="{RED}"/></svg>')


if __name__ == "__main__":
    (OUT / "redline-logo-dark.svg").write_text(logo("#f5f5f5", "#8a8a90"), encoding="utf-8")   # for dark backgrounds
    (OUT / "redline-logo-light.svg").write_text(logo("#111113", "#5c5c63"), encoding="utf-8")  # for light backgrounds
    (OUT / "redline-wordmark-dark.svg").write_text(logo("#f5f5f5", "#8a8a90", with_tagline=False), encoding="utf-8")
    (OUT / "redline-wordmark-light.svg").write_text(logo("#111113", "#5c5c63", with_tagline=False), encoding="utf-8")
    (OUT / "redline-icon.svg").write_text(icon(), encoding="utf-8")
    print("Generated logo files in", OUT)
