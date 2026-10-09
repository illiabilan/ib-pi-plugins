---
name: android-gif-vqa
description: Produces visual QA evidence on an Android emulator with the `android_vqa` tool. Records scripted scenarios, asserts UI state from uiautomator dumps taken in the same window, builds captioned GIFs, optionally mocks one backend response with fixture JSON through mitmproxy, and lets the agent look at the result through a frame contact sheet. Use when asked for validation GIFs, screen recordings of a fix or PR, visual verification of a feature toggle or backend-driven UI, or to repeat the same GIF scope on another branch.
---

# Android GIF VQA

Tool: `android_vqa` (extension `android-vqa`). Do not hand-write adb/ffmpeg/uiautomator shell loops.

## Rules that came from a real session

1. **A GIF proves nothing unless something checked the screen.** A subagent that records cannot see images. Every scenario must carry `assert` steps (present/absent regexes over visible text, content-desc, resource-id) taken during the recording. The verdict in the GIF README comes from those asserts only.
2. **Look before you claim.** After a run call `android_vqa {action:'frames', src:<gif>}` and read the sheet image. Check the caption and the state shown. If you did not look, say so.
3. **Assert negatives.** Hidden elements (`absent:['info_icon']`), no error screens, no checkout after a `no_action` tap. Overlap bugs (a CTA clipped by an icon) need the bounds in the dump timeline, not the GIF.
4. **Assert after Back.** One `assert` per visual state, including the return to the start screen.
5. **Same scope, different branch = same scenario list.** Keep the scenarios as a JSON list, rerun with another `outDir` (for example `gifs-fixes/`) and compare verdicts. Record the APK sha256 and commit sha in the README so the two runs are distinguishable.
6. **Never start emulators yourself.** If `status` shows no device, ask the user. Never install anything globally. `setup` only creates a private venv under `~/.pi/agent/android-vqa/`.

## Workflow

1. `android_vqa {action:'setup'}` once per machine (imageio-ffmpeg, pillow, mitmproxy in a venv). Then `status`.
2. Prepare app state outside the tool: build and install the APK, log in, set feature toggles. Keep a backup of any file you edit. Edit only the keys you need (two-key `sed`), never restore a whole preferences file over a live session.
3. If the scenario needs a specific backend response (no live backend, rare states):
   - Put fixtures in a directory as `<name>.json`.
   - `proxy_start {fixturesDir, match:'<url substring>', port}` then `ca_install` (user CA, validated on API 33 AOSP only; the app must trust user CAs, so use a debuggable or staging build) then `proxy_device {value:'on'}`.
   - Per scenario pick the fixture with a `{do:'fixture', value:'<name>'}` step, or `proxy_fixture`. `404` and `passthrough` are built in. `proxy_log` shows the request bodies the app sent, which is also evidence for request-shape checks.
4. Run scenarios with `run`. Skeleton:
   ```
   android_vqa {action:'run', name:'G03-single-copy', app:{package:'com.example.app'},
     title:'G03 · single copy', desc:'toggle ON, redesign OFF, fixture m1-single, tap bar, Back',
     expect:'static bar with CTA Join inside the bar, no info icon, tap opens checkout, Back returns',
     steps:[
       {do:'fixture', value:'m1-single'},
       {do:'force_stop'}, {do:'launch'},
       {do:'wait', text:'Delivery', timeout:30},
       {do:'cut'},
       {do:'assert', label:'bar', present:['QA single copy','^Join$'], absent:['cashback_info_icon']},
       {do:'tap', text:'QA single copy'}, {do:'sleep', s:3},
       {do:'assert', label:'checkout', present:['Standard Plan'], absent:['Monthly to Annual']},
       {do:'back'}, {do:'sleep', s:2},
       {do:'assert', label:'back-home', present:['QA single copy']}
     ]}
   ```
   - `cut` marks where the GIF starts, so cold start loading is trimmed.
   - `hold {s, every}` dumps repeatedly. Use it for rotating banners (assert two different texts appear by listing both in separate asserts after a `hold`, or read the timeline).
   - `tap` accepts `text` (regex), `id`, `index`, or `x`,`y`.
   - Animations are set to 1.0 and show-touches to 1 during recording and restored after. `status` shows the current values.
5. `frames {src:<gif>}`, read the sheet, fix scenarios whose GIF is wrong (static GIF warning, wrong screen, caption overflow), rerun only those.
6. `report {outDir}` writes `README.md` with one row per `*.result.json`: GIF, setup, expected, verdict, what was checked, size.
7. Cleanup, in this order: `proxy_device {value:'off'}`, `ca_remove`, `proxy_stop`, restore the app state you changed (toggles back to their original values), delete stray recordings under `/sdcard`. Confirm with `status` (`http_proxy=:0`, animations back to the original values).

## Failure handling

- `wait` or `tap` target not found: the run aborts with FAIL and still produces the GIF, which shows what was on screen. Read the timeline first.
- Empty dumps or all assertions failing: check the app actually launched (`ui` shows the foreground activity) and that the device is not showing a geo-block or login screen. A VPN or region block shows up as network errors in the app, not as tool errors.
- `ca_install` cannot find a Settings row: the Settings UI differs from API 33 AOSP. Install the cert by hand and continue.
- Static GIF warning: the recording captured a frozen screen. Rerun. Only one `screenrecord` can run at a time on an emulator.

## Evidence hygiene

- OkHttp or mitm logs contain tokens, cookies and credentials. Redact before they leave the machine. Do not paste test account passwords into READMEs or PR descriptions.
- Keep artifacts in a gitignored directory. Do not commit GIFs unless the user asks. GIFs for PRs should stay under about 6 MB (the tool lowers fps then width automatically).
- Say what was not verified: scenarios on a mocked backend prove client behavior only, not the real backend contract.

## Final step when you change this tool

Load `agentic-tool-validation-loop` and rerun a scenario against a real emulator (for example Settings: open, tap, Back) before reporting the change as done.
