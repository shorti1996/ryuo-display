#!/usr/bin/env python3
"""Encode synthetic desktop frames with ryuo_display.py's encoder and print each frame's size.

Feeds 2240x1080 BGRx frames through the same nvh265enc settings as gst_cmd() (fdsrc and
rawvideoparse instead of PipeWire) and splits the output with GdpReader, so the sizes are what the
receiver's AccessUnitReader would see. Each scenario changes a small part of a fixed desktop:
nothing, a blinking text cursor, a moving pointer, a clock, a tooltip, a scroll. Needs an NVIDIA GPU
and gst-launch-1.0 with nvh265enc; touches no capture, virtual monitor or cooler.

    /usr/bin/python3 docs/009-burn-in/frame_sizes.py [BITRATE_MBPS]
"""

import os
import random
import subprocess
import sys
import threading

sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", ".."))
import ryuo_display

WIDTH, HEIGHT = ryuo_display.PANEL_W, ryuo_display.PANEL_H
BPP = 4


def px(rgb):
    return bytes((rgb[2], rgb[1], rgb[0], 255))


def fill(buf, left, top, width, height, rgb):
    row = px(rgb) * width
    for line in range(top, top + height):
        offset = (line * WIDTH + left) * BPP
        buf[offset : offset + width * BPP] = row


rng = random.Random(1)
GLYPHS = [[[rng.random() < 0.35 for _ in range(7)] for _ in range(10)] for _ in range(64)]


def text(buf, left, top, count, fg, bg, seed):
    pick = random.Random(seed)
    for index in range(count):
        glyph = GLYPHS[pick.randrange(64)]
        for row, bits in enumerate(glyph):
            offset = ((top + row) * WIDTH + left + index * 8) * BPP
            buf[offset : offset + 7 * BPP] = b"".join(px(fg) if bit else px(bg) for bit in bits)


def desktop():
    """A dark desktop with a light text window, a dark text window and a panel bar."""
    buf = bytearray(px((32, 33, 36)) * (WIDTH * HEIGHT))
    fill(buf, 40, 40, 1100, 980, (250, 250, 250))
    for line in range(45):
        text(buf, 60, 60 + line * 20, rng.randint(30, 130), (20, 20, 20), (250, 250, 250), line)
    fill(buf, 1180, 80, 1000, 900, (40, 44, 52))
    for line in range(42):
        text(buf, 1200, 100 + line * 20, rng.randint(20, 120), (200, 200, 120), (40, 44, 52), 100 + line)
    fill(buf, 0, 1040, WIDTH, 40, (20, 20, 24))
    return buf


ARROW = [[1 if column <= row and column < 12 else 0 for column in range(16)] for row in range(22)]


def pointer(buf, left, top):
    for row, bits in enumerate(ARROW):
        for column, bit in enumerate(bits):
            if bit:
                offset = ((top + row) * WIDTH + left + column) * BPP
                buf[offset : offset + 4] = px((0, 0, 0)) if column in (0, row) else px((255, 255, 255))


def scenarios():
    base = desktop()
    yield "first (keyframe)", bytes(base)
    for _ in range(240):
        yield "unchanged", bytes(base)
    for blink in range(20):
        frame = bytearray(base)
        if blink % 2 == 0:
            fill(frame, 600, 401, 2, 18, (0, 0, 0))
        yield "caret blink", bytes(frame)
    for _ in range(60):
        yield "unchanged", bytes(base)
    pointer_x = 1500
    for _ in range(20):
        frame = bytearray(base)
        pointer_x += 3
        pointer(frame, pointer_x, 500)
        yield "pointer 3 px", bytes(frame)
    for _ in range(20):
        frame = bytearray(base)
        pointer_x -= 15
        pointer(frame, pointer_x, 500)
        yield "pointer 15 px", bytes(frame)
    for step in range(20):
        frame = bytearray(base)
        pointer(frame, 700 + step, 300)
        yield "pointer 1 px", bytes(frame)
    for _ in range(30):
        yield "unchanged", bytes(base)
    for tick in range(10):
        frame = bytearray(base)
        text(frame, 2150, 1055, 5, (230, 230, 230), (20, 20, 24), 1000 + tick)
        yield "clock (5 glyphs)", bytes(frame)
    for _ in range(30):
        yield "unchanged", bytes(base)
    tooltip = bytearray(base)
    fill(tooltip, 300, 300, 300, 120, (255, 255, 220))
    for line in range(5):
        text(tooltip, 310, 310 + line * 20, 30, (0, 0, 0), (255, 255, 220), 2000 + line)
    yield "tooltip appears", bytes(tooltip)
    for _ in range(10):
        yield "tooltip, unchanged", bytes(tooltip)
    for step in range(10):
        scrolled = bytearray(base)
        shift, top = 20 * (step + 1) * WIDTH * BPP, 60 * WIDTH * BPP
        scrolled[top : top + 900 * WIDTH * BPP] = base[top + shift : top + shift + 900 * WIDTH * BPP]
        yield "scroll", bytes(scrolled)
    yield "end", bytes(base)  # flushes the scroll's last frame


def main():
    bitrate = float(sys.argv[1]) if len(sys.argv) > 1 else ryuo_display.DEFAULT_BITRATE
    rd, wr = os.pipe()
    args = ryuo_display.gst_cmd("unused", wr, bitrate)
    head = [
        "gst-launch-1.0",
        "-q",
        "fdsrc",
        "fd=0",
        f"blocksize={WIDTH * HEIGHT * BPP}",
        "!",
        "rawvideoparse",
        f"width={WIDTH}",
        f"height={HEIGHT}",
        "format=bgrx",
        "framerate=60/1",
        "!",
    ]
    gst = subprocess.Popen(head + args[args.index("glupload") :], stdin=subprocess.PIPE, pass_fds=(wr,))
    os.close(wr)
    sizes = []

    def read():
        reader = ryuo_display.GdpReader()
        while chunk := os.read(rd, 1 << 20):
            packets = reader.feed(chunk)
            sizes.extend(
                len(ryuo_display.panel_frame(payload)) for kind, payload in packets if kind == ryuo_display.GDP_BUFFER
            )

    reader_thread = threading.Thread(target=read)
    reader_thread.start()
    labels = []
    for label, frame in scenarios():
        labels.append(label)
        gst.stdin.write(frame)
    gst.stdin.close()
    gst.wait()
    reader_thread.join()
    print(f"{bitrate:g} Mb/s: {len(sizes)} frames out for {len(labels)} in")
    runs = []
    # The encoder holds the last input back, so there is one size fewer than labels (the "end" frame).
    for label, size in zip(labels, sizes, strict=False):
        if runs and runs[-1][0] == label:
            runs[-1][1].append(size)
        else:
            runs.append((label, [size]))
    for label, ns in runs:
        tail = ns[-8:] if len(ns) > 8 else ns
        print(f"  {label:20} {len(ns):4} frames  min {min(ns):7}  max {max(ns):7}  last {tail}")


if __name__ == "__main__":
    main()
