import argparse
import glob
import json
import os
import shutil
import subprocess
import tempfile

import imageio_ffmpeg
from PIL import Image, ImageChops, ImageDraw, ImageStat

p = argparse.ArgumentParser()
p.add_argument("--src", required=True)
p.add_argument("--out")
p.add_argument("--count", type=int, default=8)
p.add_argument("--cols", type=int, default=4)
p.add_argument("--cell-width", type=int, default=300)
p.add_argument("--check", action="store_true")
a = p.parse_args()


def gif_frames(path):
    im = Image.open(path)
    for i in range(im.n_frames):
        im.seek(i)
        yield im.convert("RGB")


def mp4_frames(path):
    work = tempfile.mkdtemp(prefix="vqa-frames-")
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-i", path, "-vf", "fps=2",
                    f"{work}/f_%05d.png"], check=True)
    try:
        for f in sorted(glob.glob(f"{work}/f_*.png")):
            yield Image.open(f).convert("RGB").copy()
    finally:
        shutil.rmtree(work, ignore_errors=True)


frames = list(gif_frames(a.src) if a.src.lower().endswith(".gif") else mp4_frames(a.src))
n = len(frames)
if a.check:
    changed, prev, means = 0, None, []
    for i, im in enumerate(frames):
        g = im.convert("L")
        if i in (0, n // 2, n - 1):
            means.append(round(ImageStat.Stat(g).mean[0]))
        if prev is not None and ImageChops.difference(g, prev).getbbox():
            changed += 1
        prev = g
    print(json.dumps({"frames": n, "changedFrames": changed, "meanFirstMidLast": means,
                      "size": list(frames[0].size) if n else None, "bytes": os.path.getsize(a.src)}))
    raise SystemExit(0)

if n == 0:
    raise SystemExit("no frames")
count = min(a.count, n)
idx = sorted({round(i * (n - 1) / max(count - 1, 1)) for i in range(count)})
cw = a.cell_width
cells = []
for i in idx:
    im = frames[i]
    ch = round(im.height * cw / im.width)
    cell = im.resize((cw, ch))
    ImageDraw.Draw(cell).rectangle((0, ch - 16, 58, ch), fill=(0, 0, 0))
    ImageDraw.Draw(cell).text((3, ch - 14), f"#{i + 1}/{n}", fill=(255, 255, 255))
    cells.append(cell)
cols = min(a.cols, len(cells))
rows = (len(cells) + cols - 1) // cols
rh = max(c.height for c in cells)
sheet = Image.new("RGB", (cols * cw + (cols + 1) * 4, rows * rh + (rows + 1) * 4), (60, 60, 64))
for k, c in enumerate(cells):
    sheet.paste(c, (4 + (k % cols) * (cw + 4), 4 + (k // cols) * (rh + 4)))
sheet.save(a.out)
print(json.dumps({"out": a.out, "frames": n, "picked": [i + 1 for i in idx], "size": list(sheet.size)}))
