#!/usr/bin/env python3
"""Adversarial pty run for sound-notify (real pi TUI).

  python3 extensions/sound-notify/tests/pty-adversarial.py [outdir]

Cases:
  1. startup                     -> silence
  2. /reload, then a normal run  -> EXACTLY one sound (a stale extension instance
                                    left over by the reload must not double-ring)
  3. long run + Esc mid-stream   -> no sound at all (the human is at the keyboard)
  4. run right after the abort   -> sound works again (the abort latch is not sticky)
  5. follow-up typed mid-stream  -> the whole exchange rings once, not once per run
  6. exit                        -> clean shutdown
"""
import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.abspath(os.path.join(HERE, "..", "index.ts"))
PLAYER = os.path.join(HERE, "fixtures", "probe-player.sh")
CWD = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
OUTDIR = sys.argv[1] if len(sys.argv) > 1 else "/tmp/sn-pty2"
os.makedirs(OUTDIR, exist_ok=True)
PLAYS = os.path.join(OUTDIR, "plays.log")
DEC = os.path.join(OUTDIR, "decisions.log")
CAP = os.path.join(OUTDIR, "capture.raw")
for f in (PLAYS, DEC, CAP):
    if os.path.exists(f):
        os.remove(f)

failures = []


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (("  :: " + detail) if detail else ""))
    if not ok:
        failures.append(label)


def kinds():
    if not os.path.exists(PLAYS):
        return []
    out = []
    with open(PLAYS) as f:
        for line in f:
            m = re.search(r"--tag (\w+)", line)
            if m:
                out.append(m.group(1))
    return out


pid, fd = pty.fork()
if pid == 0:
    os.chdir(CWD)
    env = dict(
        os.environ,
        TERM="xterm-256color",
        COLUMNS="100",
        LINES="30",
        PI_SOUND_PLAYER="%s --tag {kind}" % PLAYER,
        PI_SOUND_PROBE_LOG=PLAYS,
        PI_SOUND_DEBUG=DEC,
    )
    os.execvpe("pi", ["pi", "-e", EXT], env)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
chunks = []


def pump(seconds, until=None):
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            chunks.append(data)
        if until is not None and until(b"".join(chunks).decode("utf-8", "replace")):
            return True
    return False


def send(s):
    os.write(fd, s.encode())


pump(6)
check("1. startup rings nothing", kinds() == [], "plays=%r" % kinds())

# --- 2. reload must not create a second ringing instance -------------------
send("/reload\r")
pump(8)
base = len(kinds())
send("Reply with exactly: ok\r")
pump(60, until=lambda t: re.search(r"\bok\b", t) is not None)
pump(10)
after_reload = kinds()[base:]
check("2. exactly one sound after /reload", after_reload == ["done"], "plays=%r" % after_reload)

# --- 3. Esc-aborted run stays silent --------------------------------------
base = len(kinds())
send("Write a 400 word essay about the sea, slowly and in full detail.\r")
pump(4.0)
send("\x1b")  # Esc: abort the stream
pump(12)
check("3. Esc-aborted run rings nothing", kinds()[base:] == [], "plays=%r" % kinds()[base:])

# --- 4. the very next run rings again -------------------------------------
base = len(kinds())
send("Reply with exactly: ok2\r")
pump(60, until=lambda t: "ok2" in t)
pump(10)
check("4. sound recovers after an abort", kinds()[base:] == ["done"], "plays=%r" % kinds()[base:])

# --- 5. a follow-up typed while streaming must not double-ring --------------
base = len(kinds())
send("Write a 120 word paragraph about rivers.\r")
pump(3.0)
send("Now reply with exactly: ok3\r")  # queued/steered while the agent works
pump(90, until=lambda t: "ok3" in t)
pump(12)
check(
    "5. mid-stream follow-up rings once, not per run",
    kinds()[base:] == ["done"],
    "plays=%r" % kinds()[base:],
)

send("\x03")
pump(1)
send("\x03")
pump(1)
send("\x04")
pump(4)
try:
    os.kill(pid, signal.SIGTERM)
except ProcessLookupError:
    pass
time.sleep(0.5)

with open(CAP, "wb") as f:
    f.write(b"".join(chunks))
print("\nplays: %s" % kinds())
if os.path.exists(DEC):
    print("decisions:")
    with open(DEC) as f:
        for line in f:
            print("   " + line.rstrip())
print("\n%d failure(s)" % len(failures))
sys.exit(1 if failures else 0)
