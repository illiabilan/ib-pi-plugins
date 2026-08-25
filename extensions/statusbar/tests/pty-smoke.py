#!/usr/bin/env python3
"""Drive a REAL pi TUI on a pty and capture what the footer actually paints.

  python3 tests/pty-smoke.py [/tmp/sbar-pty/capture.raw]
  node tests/analyze-pty.mjs /tmp/sbar-pty/capture.raw

Phases: startup at 100 cols, resize 80/60/40/20/10, back to 100, /statusbar off,
/statusbar on, 4 rapid toggles, /statusbar segments (then Escape), then exit.
Needs `pi` on PATH; it starts a real session in the repo root (no prompt is sent, so no
model call is made).
"""
import fcntl, os, pty, select, signal, struct, sys, termios, time

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.join(HERE, "..", "index.ts")
CWD = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/sbar-pty/capture.raw"
os.makedirs(os.path.dirname(OUT), exist_ok=True)

pid, fd = pty.fork()
if pid == 0:
    os.chdir(CWD)
    env = dict(os.environ, TERM="xterm-256color", COLUMNS="100", LINES="30")
    os.execvpe("pi", ["pi", "-e", os.path.abspath(EXT)], env)

def resize(cols, rows=30):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

chunks, marks = [], []

def pump(seconds):
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return
            if not data:
                return
            chunks.append(data)

def mark(label):
    marks.append((label, sum(len(c) for c in chunks)))

resize(100)
pump(7); mark("startup@100")
for cols in (80, 60, 40, 20, 10):
    resize(cols); pump(2.0); mark("resize@%d" % cols)
resize(100); pump(2.0); mark("resize-back@100")
os.write(fd, b"/statusbar\r"); pump(3.0); mark("toggled-off")
os.write(fd, b"/statusbar\r"); pump(3.0); mark("toggled-on")
for _ in range(4):
    os.write(fd, b"/statusbar\r"); pump(0.8)
mark("rapid-toggle")
os.write(fd, b"/statusbar segments\r"); pump(2.0)
os.write(fd, b"\x1b"); pump(1.5); mark("segments-dialog")
os.write(fd, b"\x03"); pump(1.0)
os.write(fd, b"\x03"); pump(1.0)
os.write(fd, b"\x04"); pump(2.0)
try:
    os.kill(pid, signal.SIGTERM)
except ProcessLookupError:
    pass
time.sleep(0.5)

raw = b"".join(chunks)
with open(OUT, "wb") as f:
    f.write(raw)
with open(OUT + ".marks", "w") as f:
    for label, off in marks:
        f.write("%s\t%d\n" % (label, off))
print("captured %d bytes -> %s" % (len(raw), OUT))
for label, off in marks:
    print("  %s\t@%d" % (label, off))
