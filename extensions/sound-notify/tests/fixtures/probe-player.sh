#!/bin/bash
# Fake audio player used by the validation harness: records every playback
# request (with a millisecond timestamp) instead of making noise.
#   PI_SOUND_PLAYER="<this> --tag {kind}"  PI_SOUND_PROBE_LOG=/tmp/x/plays.log
LOG="${PI_SOUND_PROBE_LOG:-/tmp/pi-sound-probe/plays.log}"
mkdir -p "$(dirname "$LOG")"
TS=$(perl -MTime::HiRes -e 'printf("%.0f", Time::HiRes::time()*1000)' 2>/dev/null || date +%s000)
printf '%s %s\n' "$TS" "$*" >>"$LOG"
exit 0
