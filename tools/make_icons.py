"""Draws the app icons (a gradient with a sound-wave mark) using only the standard library."""
import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "web" / "icons"
OUT.mkdir(parents=True, exist_ok=True)


def lerp(a, b, t):
    return a + (b - a) * t


def render(size):
    rows = []
    bars = [0.28, 0.5, 0.78, 0.5, 0.34]  # heights of the five wave bars
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            u, v = x / size, y / size
            t = (u + v) / 2
            r, g, b = lerp(255, 255, t), lerp(79, 190, t), lerp(134, 70, t)  # pink -> orange (Sunset)
            # five rounded bars, centred
            bw, gap = 0.085, 0.045
            total = 5 * bw + 4 * gap
            x0 = 0.5 - total / 2
            cover = 0.0
            for i, h in enumerate(bars):
                cx = x0 + i * (bw + gap) + bw / 2
                half = h / 2
                dx = abs(u - cx) - (bw / 2 - bw / 2)  # distance from the bar's centre line
                dy = max(abs(v - 0.5) - (half - bw / 2), 0)
                d = math.hypot(max(abs(u - cx) - 0, 0), dy) - bw / 2
                px = 1 / size
                cover = max(cover, min(1, max(0, 0.5 - d / px)))
            r, g, b = lerp(r, 18, cover), lerp(g, 6, cover), lerp(b, 28, cover)  # dark plum bars
            row += bytes((int(r), int(g), int(b)))
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


for n in (180, 192, 512):
    (OUT / f"icon-{n}.png").write_bytes(render(n))
    print("wrote", n)
