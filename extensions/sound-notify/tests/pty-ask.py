#!/usr/bin/env python3
"""Drive a REAL pi TUI on a pty and prove the three sounds fire at the right moments.

  python3 extensions/sound-notify/tests/pty-ask.py

Phases and assertions (each printed as PASS/FAIL, non-zero exit on any FAIL):
  1. startup                 -> no sound at all (nothing rings just because pi opened)
  2. prompt -> harness_ask   -> an "ask" sound rings WHILE the dialog is still open
                                (checked before any key is sent to answer it)
  3. answer the dialog       -> a "done" sound rings once the run settles, exactly once
  4. /sound off + a 2nd run  -> no new sound while muted
  5. /sound on + /sound test -> all three kinds ring on demand
  6. exit                    -> pi shuts down cleanly (no crash from the extension)

Requires `pi` on PATH and a model reachable with the ambient credentials.
"""
import os
import pty
import re
import select
import signal
import struct
import sys
import fcntl
import termios
import time

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.abspath(os.path.join(HERE, "..", "index.ts"))
HARNESS = os.path.join(HERE, "fixtures", "harness-ext.ts")
PLAYER = os.path.join(HERE, "fixtures", "probe-player.sh")
CWD = os.path.abspath(os.path.join(HERE, "..", "..", ".."))

OUTDIR = sys.argv[1] if len(sys.argv) > 1 else "/tmp/sn-pty"
os.makedirs(OUTDIR, exist_ok=True)
PLAYS = os.path.join(OUTDIR, "plays.log")
DEC = os.path.join(OUTDIR, "decisions.log")
HLOG = os.path.join(OUTDIR, "harness.log")
CAP = os.path.join(OUTDIR, "capture.raw")
for f in (PLAYS, DEC, HLOG, CAP):
    if os.path.exists(f):
        os.remove(f)

failures = []


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (("  :: " + detail) if detail else ""))
    if not ok:
        failures.append(label)


def plays():
    if not os.path.exists(PLAYS):
        return []
    with open(PLAYS) as f:
        return [l.strip() for l in f if l.strip()]


def kinds():
    out = []
    for line in plays():
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
        PI_SOUND_HARNESS_LOG=HLOG,
        PI_SOUND_DEBUG=DEC,
        PI_SOUND_COOLDOWN_MS="200",
    )
    os.execvpe("pi", ["pi", "-e", EXT, "-e", HARNESS], env)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
chunks = []


def pump(seconds, until=None):
    """Read for `seconds`, or until `until(text)` is true."""
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


# --- phase 1: startup is silent -------------------------------------------
pump(6)
check("1. startup rings nothing", kinds() == [], "plays=%r" % plays())

# --- phase 2: ask sound fires while the dialog blocks ----------------------
send("Call harness_ask with question 'May I proceed?' exactly once, then reply with the answer.\r")
saw_dialog = pump(90, until=lambda t: "Harness" in t and "May I proceed" in t and "No" in t)
time.sleep(0.6)  # the sound is spawned in the same tick the dialog opens
ask_before_answer = kinds()
check("2a. dialog actually opened", saw_dialog)
check(
    "2b. 'ask' sound rang BEFORE the dialog was answered",
    ask_before_answer == ["ask"],
    "plays=%r" % plays(),
)

# --- phase 3: answering leads to exactly one done sound -------------------
send("\r")  # select "Yes"
pump(60, until=lambda t: "user answered" in t or "answered: true" in t)
pump(8)
after = kinds()
check("3a. 'done' sound rang after the run settled", after[-1:] == ["done"], "plays=%r" % after)
check("3b. exactly one sound per phase, no spam", after == ["ask", "done"], "plays=%r" % after)

# --- phase 4: /sound off really mutes -------------------------------------
send("/sound off\r")
pump(3)
baseline = len(kinds())
send("Reply with exactly: ok\r")
pump(60, until=lambda t: "settled" in t)
pump(10)
check("4. muted run rings nothing", len(kinds()) == baseline, "plays=%r" % kinds())

# --- phase 5: /sound on + /sound test ------------------------------------
send("/sound on\r")
pump(3)
send("/sound test\r")
pump(8)
tested = kinds()[baseline:]
check(
    "5. /sound test rings all three kinds",
    tested == ["ask", "done", "error"],
    "plays=%r" % tested,
)

send("/sound status\r")
pump(4)
text = b"".join(chunks).decode("utf-8", "replace")
check("5b. /sound status reports the resolved player", "sound-notify:" in text and "afplay" not in text or "probe-player" in text, "")

# --- phase 6: clean exit --------------------------------------------------
send("\x03")
pump(1)
send("\x03")
pump(1)
send("\x04")
pump(4)
alive = True
try:
    os.kill(pid, 0)
except ProcessLookupError:
    alive = False
if alive:
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
time.sleep(0.5)

with open(CAP, "wb") as f:
    f.write(b"".join(chunks))
print("\ncapture: %s (%d bytes)" % (CAP, sum(len(c) for c in chunks)))
print("plays:   %s" % PLAYS)
for line in plays():
    print("   " + line)
print("decisions: %s" % DEC)
if os.path.exists(DEC):
    with open(DEC) as f:
        for line in f:
            print("   " + line.rstrip())

print("\n%d failure(s)" % len(failures))
sys.exit(1 if failures else 0)
