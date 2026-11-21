"""Fixes YouTube's audio files so iPhones show the right song length.

YouTube's m4a audio is "fragmented": a header (moov) followed by the sound in small pieces (moof/mdat).
The header already states the full length, and the pieces add up to the full length again. Chrome
handles that, but iOS Safari adds the two together, so a 3-minute song shows as 6 minutes and the
second half is silence. Files made for streaming normally say "0" in the header and let the pieces
give the length, so that's what this does: it sets the header's length fields to 0.

Only numbers inside the header change; nothing is added or removed, so every byte keeps its position
and byte-range requests (used for seeking) stay valid.
"""
import struct

_CONTAINERS = {b"moov", b"trak", b"mdia", b"minf", b"stbl", b"edts"}


def header_end(data: bytes) -> int | None:
    """Where the header (everything up to the end of moov) stops, or None if `data` is too short to tell."""
    i = 0
    while i + 8 <= len(data):
        size, typ = struct.unpack(">I4s", data[i:i + 8])
        if size == 1:
            if i + 16 > len(data):
                return None
            size = struct.unpack(">Q", data[i + 8:i + 16])[0]
        if size < 8:
            return None
        if typ == b"moov":
            return i + size
        if typ in (b"moof", b"mdat"):  # sound before any header: not the layout we know
            return None
        i += size
    return None


def _walk(buf: bytearray, start: int, end: int) -> int:
    changed = 0
    i = start
    while i + 8 <= end:
        size, typ = struct.unpack(">I4s", buf[i:i + 8])
        hdr = 8
        if size == 1:
            size, hdr = struct.unpack(">Q", buf[i + 8:i + 16])[0], 16
        if size < 8 or i + size > end:
            break
        b = i + hdr  # where the box's contents start
        v = buf[b] if b < end else 0
        if typ in (b"mvhd", b"mdhd"):  # version, flags, created, modified, timescale, duration
            off, n = (b + 4 + 8 + 8 + 4, 8) if v == 1 else (b + 4 + 4 + 4 + 4, 4)
            buf[off:off + n] = bytes(n); changed += 1
        elif typ == b"tkhd":  # version, flags, created, modified, track id, reserved, duration
            off, n = (b + 4 + 8 + 8 + 4 + 4, 8) if v == 1 else (b + 4 + 4 + 4 + 4 + 4, 4)
            buf[off:off + n] = bytes(n); changed += 1
        elif typ == b"elst":  # each entry: segment duration, media start, rate. 0 = "until the end"
            count = struct.unpack(">I", buf[b + 4:b + 8])[0]
            n, step = (8, 20) if v == 1 else (4, 12)
            for k in range(min(count, 64)):
                off = b + 8 + k * step
                if off + n <= i + size:
                    buf[off:off + n] = bytes(n)
            changed += 1
        elif typ in _CONTAINERS:
            changed += _walk(buf, b, i + size)
        i += size
    return changed


def patch_header(head: bytes) -> bytes:
    """Returns `head` (the bytes from 0 to header_end) with the length fields set to 0."""
    buf = bytearray(head)
    end = header_end(head)
    if end is None or end > len(buf):
        return bytes(head)
    i = 0
    while i + 8 <= end:
        size, typ = struct.unpack(">I4s", buf[i:i + 8])
        if size < 8:
            break
        if typ == b"moov":
            _walk(buf, i + 8, i + size)
            break
        i += size
    return bytes(buf)
