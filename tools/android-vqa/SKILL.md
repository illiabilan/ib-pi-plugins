---
name: android-vqa
description: Visual QA on an Android emulator or device with captioned GIF evidence. Runs scripted scenarios (launch, wait, tap by text/id, back, assert) while recording the screen and dumping the UI hierarchy in the same window, checks present/absent assertions against those dumps, builds captioned validation GIFs, renders frame contact sheets you can look at, detects static GIFs, and can mock one backend URL with fixture JSON through mitmproxy. Use when asked for validation GIFs, screen recordings of a fix or PR, UI assertions or visual verification on an Android emulator/device, checking a feature toggle or backend-driven UI, mocking a backend response for an Android app, or repeating the same GIF scope on another branch.
---

# Android VQA

Standalone, zero-dependency Node 20+ CLI at `script/android-vqa.mjs` in this skill's directory
(installed: `~/.claude/skills/android-vqa/script/android-vqa.mjs`). Do not hand-roll adb screenrecord /
ffmpeg / uiautomator shell loops; this tool does them consistently.

```bash
V=~/.claude/skills/android-vqa/script/android-vqa.mjs
node $V --help              # all commands
node $V <command> --help    # one command
```

## Rules

1. **Use `run` to produce validation GIFs.** It records and asserts in the SAME window, so every GIF has a
   UI-dump verdict. A GIF proves nothing unless something checked the screen.
2. **Look before you claim.** A passing run proves only what its assertions check. Before saying a GIF looks
   right, run `node $V frames <gif>` and **Read the PNG path it prints** (the contact sheet). Check the
   caption and the state shown. If you did not look, say so explicitly.
3. **Write assertions as present/absent regexes** (case-insensitive) over visible node text, content-desc and
   resource-id, e.g. `"absent": ["info_icon"]` for an element that must be hidden. Assert negatives too: no
   error screen, no checkout after a no-action tap. Overlap bugs (a CTA clipped by an icon) need the bounds in
   the dump timeline, not the GIF.
4. **One `assert` per visual state, including after Back** (the return to the start screen).
5. **Mocking:** use `proxy start` / `proxy fixture` / `proxy device` to mock one backend URL with fixture JSON
   files, and always finish with `proxy device off`, `ca remove` and `proxy stop`. Never mock against
   production accounts without the user's approval.
6. **Never start emulators and never install anything globally.** If `status` shows no device, ask the user to
   start one. `setup` only creates a private venv (see Setup). Do not run `setup` without telling the user it
   downloads packages.
7. **Trust the settings restore, then verify.** `run` sets animation scales to 1.0 and show_touches to 1 while
   recording and puts the original values back afterwards, also on step errors and Ctrl-C/SIGINT. If a run was
   killed hard (second Ctrl-C, SIGKILL) or aborted, check with `node $V status`.
8. **Same scope, different branch = same scenario list.** Keep scenarios in a JSON file (a list is allowed),
   rerun with another `--out-dir` (e.g. `gifs-fixes/`) and compare verdicts. Record the APK sha256 and commit
   sha in the README so the two runs are distinguishable.

## Setup

`node $V setup` once per machine: private venv with `imageio-ffmpeg`, `pillow` and `mitmproxy`
(`--no-proxy` skips mitmproxy). Venv: `~/.local/share/android-vqa/venv`; `ANDROID_VQA_HOME` overrides the
home dir (venv at `$ANDROID_VQA_HOME/venv`, proxy state at `$ANDROID_VQA_HOME/proxy.json`). Without
`ANDROID_VQA_HOME`, an existing venv from the old Pi extension (`~/.pi/agent/android-vqa/venv`) is reused when
the new one does not exist. `PYTHON` picks the interpreter used to create the venv. Then `node $V status`.

adb comes from `ADB`, `ANDROID_HOME`, `ANDROID_SDK_ROOT` or the default SDK paths. Device: `--serial`, else
`ANDROID_SERIAL`, else the only device in `adb devices` "device" state. Recording/GIF/frames/check need the
venv; `ui`, `tap`, `key`, `type`, `status`, `run --no-record`, `report`, `proxy device` do not.

## Commands

| Command | |
|---|---|
| `setup [--no-proxy]` | create/update the private venv |
| `status` | venv, adb, device, animation scales, show_touches, http_proxy, proxy state, screenrecord on device |
| `ui [--find re]` | foreground activity + visible nodes `[bounds] id= t= d= clickable checked` (max 150) |
| `tap --text re \| --id id [--index N] \| --x N --y N` | tap node center (no retry; `ui` first) |
| `key [KEYCODE_*\|n]` | key event, default `KEYCODE_BACK` |
| `type <text>` | `input text` (spaces as `%s`) |
| `run --scenario file.json\|-` | scenario(s): record + dump + assert + captioned GIF (see below) |
| `gif <mp4> [--name N] [--title/--desc/--expect] [--fps --width --hold --start --end]` | rebuild a captioned GIF |
| `check <gif\|mp4>` | frame stats; `WARNING: static` when no frame changes |
| `frames <gif\|mp4> [--count 8]` | write `<out-dir>/sheets/<base>.sheet.png`, print its path. **Read that PNG.** |
| `report` | `<out-dir>/README.md`, one row per `*.result.json` |
| `proxy start --fixtures-dir D --match S [--port 8080] [--needle s ...]` | detached mitmdump serving `D/<name>.json` for URLs containing S |
| `proxy fixture <name\|404\|passthrough>` | switch fixture at runtime |
| `proxy log [--lines 30]` | MATCH/NEEDLE log with request bodies (evidence for request-shape checks) |
| `proxy status` / `proxy stop` | pid-verified; stale state (dead or reused pid) is cleaned, foreign pids never killed |
| `proxy device on\|off [--host 10.0.2.2] [--port N]` | device global `http_proxy` (`:0` when off) |
| `ca install` / `ca remove` | mitmproxy user CA via the Settings UI (validated on API 33 AOSP only) |

Artifacts go to `--out-dir` (default `./.vqa`): `<name>.gif`, `<name>.result.json`, `<name>.timeline.txt`,
`ui/*.xml`, `src/<name>.mp4`, `shots/`, `sheets/`, `proxy.log`. Keep that directory gitignored.

Output: compact text by default, `--json` for structured data. Progress lines and errors on stderr. Exit `0` ok,
`1` runtime error **or a FAILed scenario** (the result is still printed), `2` usage error, `130` interrupted.
Values starting with `-` need `--flag=value`.

## Scenarios (`run`)

`--scenario file.json` or `--scenario -` (stdin). One object, or a JSON list of objects run in order.
CLI flags override file fields: `--name --title --desc --expect --package --activity --no-record
--no-animations --no-touches --record-limit --fps --width --hold --start --end`.

Top-level fields:

| Field | Type | |
|---|---|---|
| `name` | string, required | artifact base name, `[A-Za-z0-9._-]`, e.g. `G03-single-copy` |
| `app` | `{package, activity?}` | needed by `launch`/`force_stop`; `activity` fully qualified or relative, omitted = launcher intent |
| `steps` | Step[], required | ordered steps |
| `title` / `desc` / `expect` | string | GIF caption: line 1 (scenario id, default `name`), setup / what is done, `Expected: ...` (green) |
| `noRecord` | bool | only steps + assertions, no recording/GIF/settings changes |
| `animations` / `touches` | bool (default true) | set animation scales 1.0 / show_touches 1 while recording, restore after |
| `recordLimit` | number | max recording seconds (default 170, screenrecord caps at 180) |
| `fps` / `width` / `hold` | number | GIF fps (10), width px (360), seconds frozen on the last frame (1) |
| `start` / `end` | number | GIF trim seconds; default start is the `cut` step |

Step fields (`do` required):

| `do` | fields | |
|---|---|---|
| `launch` | | start `app` (activity or launcher) |
| `force_stop` | | `am force-stop` the app |
| `sleep` | `s` (1) | seconds |
| `wait` | `text` regex and/or `id`, `timeout` (20) | retry dumps until a visible node matches; not found = run aborts FAIL |
| `tap` | `text`/`id` + `index` (0), `timeout` (10), or `x`,`y` | tap node center; not found = run aborts FAIL |
| `back` | | `KEYCODE_BACK` |
| `key` | `code` (`KEYCODE_HOME`) | KEYCODE_* or number |
| `type` | `value` | text input |
| `swipe` | `x` `y` `x2` `y2` `ms` (540 1800 540 600 300) | |
| `dump` | `label` | dump + foreground activity into the timeline |
| `hold` | `s` (5), `every` (2) | dump every N s for s seconds (rotating banners: read the timeline or assert after) |
| `assert` | `label`, `present: [re]`, `absent: [re]` | `present`: some visible node's text/desc/id matches; `absent`: none does |
| `fixture` | `value` (or `name`) | switch the running proxy's fixture (needs `proxy start`) |
| `shell` | `cmd` | `adb shell <cmd>`, output in the timeline |
| `setting` | `ns` (global\|system\|secure, default global), `key`, `value` | `settings put` (not restored automatically) |
| `screenshot` | `name` | PNG into `<out-dir>/shots/` |
| `cut` | | the GIF starts here (trims cold-start loading) |
| `mark` | `label` | timeline note |

`text` regexes are case-insensitive and match node text or content-desc; `id` matches the full resource-id or
the part after `/`. Only visible (non-zero-size) nodes count.

Example (`g03.json`, then `node $V run --scenario g03.json`):

```json
{
  "name": "G03-single", "app": {"package": "com.x.app"},
  "title": "G03 single copy", "desc": "toggle ON, tap bar, Back", "expect": "bar with CTA, tap opens checkout",
  "steps": [
    {"do": "force_stop"}, {"do": "launch"},
    {"do": "wait", "text": "Delivery", "timeout": 30},
    {"do": "cut"},
    {"do": "assert", "present": ["QA single copy", "^Join$"], "absent": ["info_icon"]},
    {"do": "tap", "text": "^Join$"}, {"do": "sleep", "s": 3},
    {"do": "assert", "present": ["Checkout"]},
    {"do": "back"}, {"do": "sleep", "s": 2}
  ]
}
```

A fuller one with a mocked fixture and labelled asserts:

```json
{"name": "G03-single-copy", "app": {"package": "com.example.app"},
 "title": "G03 · single copy", "desc": "toggle ON, redesign OFF, fixture m1-single, tap bar, Back",
 "expect": "static bar with CTA Join inside the bar, no info icon, tap opens checkout, Back returns",
 "steps": [
   {"do": "fixture", "value": "m1-single"},
   {"do": "force_stop"}, {"do": "launch"},
   {"do": "wait", "text": "Delivery", "timeout": 30},
   {"do": "cut"},
   {"do": "assert", "label": "bar", "present": ["QA single copy", "^Join$"], "absent": ["cashback_info_icon"]},
   {"do": "tap", "text": "QA single copy"}, {"do": "sleep", "s": 3},
   {"do": "assert", "label": "checkout", "present": ["Standard Plan"], "absent": ["Monthly to Annual"]},
   {"do": "back"}, {"do": "sleep", "s": 2},
   {"do": "assert", "label": "back-home", "present": ["QA single copy"]}
 ]}
```

## Workflow

1. `setup` once, then `status`.
2. Prepare app state outside the tool: build and install the APK, log in, set feature toggles. Keep a backup of
   any file you edit. Edit only the keys you need (two-key `sed`); never restore a whole preferences file over a
   live session.
3. If the scenario needs a specific backend response (no live backend, rare states):
   - Put fixtures in a directory as `<name>.json`.
   - `proxy start --fixtures-dir fx --match '<url substring>' [--port N]`, then `ca install` (once; the app must
     trust user CAs, so use a debuggable or staging build), then `proxy device on`.
   - Per scenario pick the fixture with a `{"do":"fixture","value":"<name>"}` step, or `proxy fixture <name>`.
     `404` and `passthrough` are built in. `proxy log` shows the request bodies the app sent.
   - The proxy keeps running between commands (detached); `proxy status` shows it.
4. Run scenarios with `run`. Read the printed timeline and assertion lines.
5. `frames <gif>`, **Read the sheet PNG**, fix scenarios whose GIF is wrong (static GIF warning, wrong screen,
   caption overflow), rerun only those.
6. `report [--out-dir D]` writes `README.md`: GIF, setup, expected, verdict, what was checked, size.
7. Cleanup, in this order: `proxy device off`, `ca remove`, `proxy stop`, restore the app state you changed
   (toggles back to their original values), delete stray recordings under `/sdcard`. Confirm with `status`
   (`http_proxy=:0`, animations back to the original values, `proxy: stopped`).

## Failure handling

- `wait` or `tap` target not found: the run aborts with FAIL and still produces the GIF, which shows what was on
  screen. Read the timeline first.
- Empty dumps or all assertions failing: check the app actually launched (`ui` shows the foreground activity)
  and that the device is not showing a geo-block or login screen. A VPN or region block shows up as network
  errors in the app, not as tool errors.
- `ca install` cannot find a Settings row: the Settings UI differs from API 33 AOSP. Install the cert by hand
  (`~/.mitmproxy/mitmproxy-ca-cert.cer`, generated by the first `proxy start`) and continue.
- Static GIF warning: the recording captured a frozen screen. Rerun. Only one `screenrecord` can run at a time
  (`status` shows whether one is running on the device).
- Ctrl-C during `run`: recording is stopped, the mp4 is pulled, the GIF is skipped (rebuild with `gif <mp4>`),
  settings are restored, exit 130.
- `proxy start` says the port is in use: something else (maybe an orphaned mitmdump) holds it; pick `--port`.

## Evidence hygiene

- OkHttp and proxy logs contain tokens, cookies and credentials. Redact before they leave the machine. Do not
  paste test account passwords into READMEs or PR descriptions.
- Do not commit GIFs unless the user asks. GIFs for PRs should stay under about 6 MB (`gif`/`run` lower fps,
  then width, automatically).
- Say what was not verified: scenarios on a mocked backend prove client behavior only, not the real backend
  contract.

## Tests

`node --test script/test/*.test.mjs` (from this skill's directory): unit tests for dump parsing, matching,
assertions and scenario validation, plus CLI integration tests against a fake `adb` (via `ADB`), a stub venv
python and a fake mitmdump. No device needed. When you change this tool, also rerun one scenario against a real
emulator (e.g. Settings: open, tap, Back) before reporting the change as done.
