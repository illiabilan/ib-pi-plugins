# android-vqa

`android_vqa` tool for Pi: visual QA on an Android emulator or device with GIF evidence.

Extracted from a real session (PR review and fix validation with 12 scenario GIFs per branch), where the recording agent could not view images and the GIFs were verified only through UI dumps. The tool makes that the default:

- `run`: scripted scenario (`launch`, `wait`, `tap` by text/id/xy, `back`, `hold`, `assert`, `fixture`, `screenshot`, `cut`, ...). Records with `screenrecord`, dumps `uiautomator` XML during the same window, evaluates assertions, builds a captioned GIF (scenario id, setup, expected result), checks the GIF is not static, restores animation scales and show-touches. Writes `<name>.gif`, `<name>.result.json`, `<name>.timeline.txt`, `ui/*.xml`, `src/<name>.mp4`.
- `frames`: contact sheet of a GIF/mp4 returned as an image block, so the model can look at it.
- `report`: README table of all `*.result.json` in the output directory.
- `ui`, `tap`, `key`, `type`: quick device probes.
- `gif`, `check`: rebuild a GIF from an mp4, detect static GIFs.
- `proxy_start`, `proxy_fixture`, `proxy_log`, `proxy_stop`, `proxy_device`, `ca_install`, `ca_remove`: mitmproxy that serves fixture JSON for one URL substring, with runtime fixture switching. `ca_install` automates the Settings UI and is validated on API 33 AOSP only.
- `setup`, `status`.

## Install

Copy or symlink this directory into `~/.pi/agent/extensions/android-vqa`, then call `android_vqa {action:'setup'}` once. It creates a private venv at `~/.pi/agent/android-vqa/venv` (override with `PI_ANDROID_VQA_HOME`) with `imageio-ffmpeg`, `pillow` and `mitmproxy`. Nothing is installed globally. `adb` is found through `ADB`, `ANDROID_HOME`, `ANDROID_SDK_ROOT` or the default SDK locations. The tool never starts emulators.

Companion skill: `skills/android-gif-vqa`.

## Validation done

On an API 33 emulator: setup, `run` with passing and failing assertions, `wait`/`tap` target not found (run aborts, GIF still built), contact sheet readable, settings restored after the run, proxy start/fixture/stop. Not validated: `ca_install`/`ca_remove` end to end, proxy-mocked traffic from an app, physical devices.
