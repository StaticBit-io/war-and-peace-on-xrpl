#!/usr/bin/env python3
"""Renders preview.jpg, the 1200x630 card shown when this page is shared.

Every figure on the card is read from data/manifest.json at generation time, and the title and
subtitle are read from index.html, so the card cannot drift away from what the page says.

    python tools/build-preview.py
"""

import json
import pathlib
import re
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "data" / "manifest.json"
INDEX = ROOT / "index.html"
OUT = ROOT / "preview.jpg"

WIDTH, HEIGHT = 1200, 630
MARGIN = 72
QUALITY = 88

BACKGROUND = "#10131c"
ACCENT = "#e8b40c"
ACCENT_2 = "#2dd4a7"
TEXT = "#e6e9f0"
MUTED = "#8b93a7"
RULE = "#232a3a"

PAGE_URL = "https://staticbit-io.github.io/war-and-peace-on-xrpl/"

FONT_CANDIDATES = {
    "bold": ["C:/Windows/Fonts/segoeuib.ttf", "C:/Windows/Fonts/arialbd.ttf",
             "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
             "/System/Library/Fonts/Supplemental/Arial Bold.ttf"],
    "regular": ["C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/arial.ttf",
                "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
                "/System/Library/Fonts/Supplemental/Arial.ttf"],
}


# The report below prints the rendered figures, which may contain non-ASCII glyphs.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def font(kind, size):
    for path in FONT_CANDIDATES[kind]:
        if pathlib.Path(path).exists():
            return ImageFont.truetype(path, size)
    raise SystemExit(f"no {kind} font found; add one to FONT_CANDIDATES")


def figures(manifest):
    """The numbers on the card. Values come straight from the manifest, never from prose."""
    ledger = manifest["ledger"]
    book = manifest["book"]
    return [
        (str(ledger["transactions"]), "transactions"),
        (str(book["bytes"]), "bytes of text"),
        (str(ledger["ledgersUsed"]), "ledgers used"),
        (str(ledger["feeBurnedXrp"]), "XRP burned in fees"),
    ]


def head_text(html, pattern):
    match = re.search(pattern, html, re.I)
    if not match:
        raise SystemExit(f"could not read {pattern} from index.html")
    return match.group(1).strip()


def wrap(draw, text, face, max_width, max_lines):
    lines, current = [], ""
    for word in text.split():
        candidate = f"{current} {word}".strip()
        if draw.textlength(candidate, font=face) <= max_width or not current:
            current = candidate
        else:
            lines.append(current)
            current = word
            if len(lines) == max_lines:
                break
    if current and len(lines) < max_lines:
        lines.append(current)
    return lines


def main():
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    html = INDEX.read_text(encoding="utf-8")
    title = head_text(html, r"<title>(.*?)</title>")
    description = head_text(html, r'<meta name="description" content="(.*?)">')

    image = Image.new("RGB", (WIDTH, HEIGHT), BACKGROUND)
    draw = ImageDraw.Draw(image)

    # Accent rule across the top, and a matching hairline above the figures.
    draw.rectangle([0, 0, WIDTH, 6], fill=ACCENT)

    brand = font("bold", 22)
    x = MARGIN
    for char in "STATICBIT":
        draw.text((x, 74), char, font=brand, fill=ACCENT)
        x += draw.textlength(char, font=brand) + 4
    network = font("regular", 22)
    label = manifest["network"]
    draw.text((WIDTH - MARGIN - draw.textlength(label, font=network), 74),
              label, font=network, fill=MUTED)

    title_face = font("bold", 60)
    y = 140
    for line in wrap(draw, title, title_face, WIDTH - 2 * MARGIN, 2):
        draw.text((MARGIN, y), line, font=title_face, fill=TEXT)
        y += 74

    subtitle_face = font("regular", 26)
    y += 12
    for line in wrap(draw, description, subtitle_face, WIDTH - 2 * MARGIN - 40, 2):
        draw.text((MARGIN, y), line, font=subtitle_face, fill=MUTED)
        y += 38

    draw.rectangle([MARGIN, 440, WIDTH - MARGIN, 441], fill=RULE)

    values = figures(manifest)
    value_face = font("bold", 46)
    caption_face = font("regular", 21)
    column = (WIDTH - 2 * MARGIN) / len(values)
    for index, (value, caption) in enumerate(values):
        cx = MARGIN + index * column
        colour = ACCENT_2 if index == len(values) - 1 else ACCENT
        draw.text((cx, 478), value, font=value_face, fill=colour)
        draw.text((cx, 538), caption, font=caption_face, fill=MUTED)

    url_face = font("regular", 20)
    draw.text((MARGIN, HEIGHT - 50), PAGE_URL, font=url_face, fill="#3d465c")

    image.save(OUT, "JPEG", quality=QUALITY, optimize=True, progressive=True)

    # Prove the card carries no invented numbers: every numeric token must be in the manifest.
    raw = MANIFEST.read_text(encoding="utf-8")
    rendered = " ".join(f"{value} {caption}" for value, caption in values)
    missing = [token for token in re.findall(r"\d+(?:\.\d+)?", rendered) if token not in raw]

    size = OUT.stat().st_size
    with Image.open(OUT) as written:
        dimensions = written.size
    print(f"{OUT.name}: {dimensions[0]}x{dimensions[1]} JPEG, {size} bytes ({size / 1024:.1f} KB), quality {QUALITY}")
    print("figures:", ", ".join(f"{value} {caption}" for value, caption in values))
    print("numbers not found verbatim in data/manifest.json:", missing or "none")
    if missing or dimensions != (WIDTH, HEIGHT):
        sys.exit(1)


if __name__ == "__main__":
    main()
