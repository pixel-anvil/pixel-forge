"""Writes static.png for the macOS `sips` GIF fixture of card E6.1 and prints the hash of its pixels.

Run: python3 -I make_sips.py <out-dir> && sips -s format gif <out-dir>/static.png --out sips_static.gif
(needs Pillow). The printed hash is sha256 of width (u32 BE), height (u32 BE) and the RGBA bytes of the
PNG, the expected hash of `sips_static.gif`. Colours are few and exact so sips' palette quantiser keeps them
(255 white; sips moves 250 to 255).
Licence: this script and the GIF are ours, released under CC0 1.0.
"""
import hashlib
import struct
import sys
from PIL import Image

out = sys.argv[1]
im = Image.new('RGBA', (20, 16), (30, 40, 90, 255))
for y in range(3, 11):
    for x in range(4, 13):
        im.putpixel((x, y), (220, 40, 40, 255))
im.putpixel((0, 0), (255, 255, 255, 255))
im.putpixel((19, 15), (40, 200, 70, 255))
im.save(out + '/static.png')
print(hashlib.sha256(struct.pack('>II', 20, 16) + im.tobytes()).hexdigest())
