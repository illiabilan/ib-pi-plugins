import argparse
import glob
import json
import os
import shutil
import subprocess
import tempfile

import imageio_ffmpeg
from PIL import Image, ImageDraw, ImageFont

FF = imageio_ffmpeg.get_ffmpeg_exe()
BOLD = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
]
REG = [
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]


def font(paths, size):
    for p in paths:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def wrap(draw, text, fnt, width):
    lines, cur = [], ""
    for w in text.split(" "):
        t = (cur + " " + w).strip()
        if draw.textlength(t, font=fnt) <= width:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def caption(width, title, desc, expect):
    scale = width / 360
    fb = font(BOLD, round(15 * scale))
    fr = font(REG, round(12 * scale))
    pad = round(7 * scale)
    tmp = ImageDraw.Draw(Image.new("RGB", (width, 10)))
    rows = [(title, fb, (255, 255, 255))]
    if desc:
        rows += [(l, fr, (230, 230, 230)) for l in wrap(tmp, desc, fr, width - 2 * pad)]
    if expect:
        rows += [(l, fr, (140, 230, 140)) for l in wrap(tmp, "Expected: " + expect, fr, width - 2 * pad)]
    lh = [f.getbbox("Ag")[3] + round(3 * scale) for _, f, _ in rows]
    bar = Image.new("RGB", (width, pad * 2 + sum(lh)), (24, 24, 28))
    d = ImageDraw.Draw(bar)
    y = pad
    for (t, f, c), dh in zip(rows, lh):
        d.text((pad, y), t, font=f, fill=c)
        y += dh
    return bar


def build(a, fps, width):
    work = tempfile.mkdtemp(prefix="vqa-gif-")
    try:
        cmd = [FF, "-y", "-loglevel", "error", "-ss", str(a.start)]
        if a.end:
            cmd += ["-t", str(a.end - a.start)]
        cmd += ["-i", a.src, "-vf", f"fps={fps},scale={width}:-2:flags=lanczos", f"{work}/f_%04d.png"]
        subprocess.run(cmd, check=True)
        frames = sorted(glob.glob(f"{work}/f_*.png"))
        if not frames:
            raise SystemExit("no frames extracted (is --start beyond the video length?)")
        bar = caption(width, a.title, a.desc, a.expect) if a.title else None
        n = 0
        for fp in frames + [frames[-1]] * int(fps * a.hold):
            im = Image.open(fp).convert("RGB")
            if bar:
                out = Image.new("RGB", (width, bar.height + im.height))
                out.paste(bar, (0, 0))
                out.paste(im, (0, bar.height))
            else:
                out = im
            n += 1
            out.save(f"{work}/c_{n:04d}.png")
        vf = ("split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];"
              "[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle")
        subprocess.run([FF, "-y", "-loglevel", "error", "-framerate", str(fps), "-i", f"{work}/c_%04d.png",
                        "-vf", vf, "-loop", "0", a.out], check=True)
        return len(frames), n, os.path.getsize(a.out)
    finally:
        shutil.rmtree(work, ignore_errors=True)


p = argparse.ArgumentParser()
p.add_argument("--src", required=True)
p.add_argument("--out", required=True)
p.add_argument("--start", type=float, default=0)
p.add_argument("--end", type=float, default=None)
p.add_argument("--title", default="")
p.add_argument("--desc", default="")
p.add_argument("--expect", default="")
p.add_argument("--fps", type=int, default=10)
p.add_argument("--width", type=int, default=360)
p.add_argument("--hold", type=float, default=1.0)
p.add_argument("--max-bytes", type=int, default=6 * 1024 * 1024)
a = p.parse_args()
fps, width = a.fps, a.width
while True:
    src_frames, total, size = build(a, fps, width)
    if size <= a.max_bytes or fps <= 5:
        break
    fps, width = (fps - 2, width) if fps > 8 else (fps, width - 40)
print(json.dumps({"out": a.out, "fps": fps, "width": width, "srcFrames": src_frames, "frames": total,
                  "durationS": round(total / fps, 1), "bytes": size}))
