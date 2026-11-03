"""Writes the Pillow GIF fixtures of card E6.1 and the expected hashes of their composed frames.

Run: python3 -I make_pil.py <out-dir>   (needs Pillow; tested with 11.3.0)

Pillow only writes the files. The expected frames come from the scene functions below (plain Python
lists of RGBA pixels), so the pinned hashes do not depend on any GIF decoder. Hash layout: sha256 of
width (u32 BE), height (u32 BE), then RGBA bytes, as the TypeScript `hashRGBA` does.
Licence: these scripts and the GIFs they write are ours, released under CC0 1.0.
"""
import hashlib
import json
import struct
import sys
from PIL import Image

W, H = 20, 16
T = (0, 0, 0, 0)
BG = (30, 40, 90, 255)
RED = (220, 40, 40, 255)
GRN = (40, 200, 70, 255)
YEL = (240, 220, 40, 255)
WHT = (250, 250, 250, 255)


def canvas(bg):
    return [[bg for _ in range(W)] for _ in range(H)]


def box(px, x, y, w, h, c):
    for yy in range(y, y + h):
        for xx in range(x, x + w):
            px[yy][xx] = c


def to_image(px):
    im = Image.new('RGBA', (W, H))
    im.putdata([c for row in px for c in row])
    return im


def raw(px):
    return bytes(v for row in px for c in row for v in c)


def digest(px):
    return hashlib.sha256(struct.pack('>II', W, H) + raw(px)).hexdigest()


def opaque_frames():
    out = []
    for i, c in enumerate([RED, GRN, YEL]):
        px = canvas(BG)
        box(px, 2 + 5 * i, 3 + 2 * i, 4, 5, c)
        px[0][0] = WHT  # a marker pixel in the corner
        px[H - 1][W - 1] = c
        out.append(px)
    return out


def striped_frames():
    """Every pixel changes from frame to frame, so Pillow writes full frames and really interlaces them
    (it switches interlace off for frames under 16 rows or columns). Rows differ, so a wrong row order shows."""
    bgs = [(30, 40, 90, 255), (90, 40, 30, 255), (30, 90, 40, 255)]
    out = []
    for i, bg in enumerate(bgs):
        px = canvas(bg)
        for y in range(H):
            for x in range(W):
                if (x + y * 3 + i) % 5 == 0:
                    px[y][x] = [RED, GRN, YEL, WHT][(y + i) % 4]
        out.append(px)
    return out


def accumulate(frames):
    """What a viewer shows when no frame is disposed: later opaque pixels replace earlier ones."""
    out = []
    cur = canvas(T)
    for f in frames:
        cur = [[f[y][x] if f[y][x][3] else cur[y][x] for x in range(W)] for y in range(H)]
        out.append(cur)
    return out


def sprite_frames():
    out = []
    for i, c in enumerate([RED, GRN, YEL, WHT]):
        px = canvas(T)
        box(px, 1 + 4 * i, 2 + i, 5, 4, c)
        box(px, 2 + 4 * i, 3 + i, 1, 1, BG)  # a hole of another colour inside
        out.append(px)
    return out


def save(name, frames, **kw):
    ims = [to_image(f) for f in frames]
    if len(ims) == 1:
        # Pillow interlaces only single-image files (its multi-frame writer always writes progressive frames)
        ims[0].save(name, optimize=False, **kw)
    else:
        ims[0].save(name, save_all=True, append_images=ims[1:], optimize=False, **kw)


def main(out):
    expected = {}

    def add(name, frames, durations, loop, shown=None, **kw):
        extra = {'loop': loop} if loop is not None else {}
        save(f'{out}/{name}.gif', frames, duration=durations, **extra, **kw)
        expected[name] = {
            'width': W,
            'height': H,
            'durationsMs': durations if isinstance(durations, list) else [durations],
            'loopCount': loop,
            'hashes': [digest(f) for f in (shown or frames)],
        }

    add('pil_opaque', opaque_frames(), [60, 120, 200], 0)
    add('pil_interlaced', striped_frames()[:1], 100, None, interlace=True)
    for d in range(4):
        # disposal 0 and 1 keep every earlier frame, so the sprite leaves a trail; 2 and 3 show each frame alone
        frames = sprite_frames()
        shown = accumulate(frames) if d < 2 else None
        add(f'pil_sprite_disposal{d}', frames, [80, 80, 80, 80], 0, shown=shown, disposal=d)
    json.dump(expected, open(f'{out}/pil_expected.json', 'w'), indent=1, sort_keys=True)


main(sys.argv[1])
