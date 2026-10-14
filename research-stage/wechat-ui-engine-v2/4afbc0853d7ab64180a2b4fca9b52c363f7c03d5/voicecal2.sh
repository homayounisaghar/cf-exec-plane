#!/bin/bash
# WeChat voice exact-length calibration v11.16 (owner requested 2026-10-14).
# Sends the latest Telegram voice that is already on the server ONCE with the
# "exact" mode (no added silence, button released exactly <audio length> after
# the press) and compares WeChat's length with the real length. If WeChat still
# shows >= 1 s more, ONE more try with a measured correction. The best setting
# becomes the default for sendvoice.sh. File Transfer only, mouse only.
set -u
OUT=/tmp/wxeng/voicecal2
mkdir -p "$OUT"; rm -f "$OUT"/STATUS "$OUT"/SUMMARY.json "$OUT"/*.png "$OUT"/cal*.json "$OUT"/read*.json
exec > "$OUT/console.txt" 2>&1 < /dev/null
step(){ echo; echo "===== $* ($(date +%T))"; }
shot(){ ( cd /tmp/wxeng && bash ./with_wechat_env.sh sh -c 'ffmpeg -nostdin -v error -y -f x11grab -draw_mouse 0 -i "$DISPLAY" -frames:v 1 "$0"' "$OUT/$1" ) || echo "SHOT_FAILED $1"; }
stop(){ echo "STOP $1"; echo "STOPPED_$1" > "$OUT/STATUS"; exit 1; }
L=/tmp/wx-v11.sh
step LOADER
curl -fsSL "https://raw.githubusercontent.com/homayounisaghar/cf-exec-plane/22b2197dbcd43b5fffd090783860db4137f5d147/research-stage/wechat-ui-engine-v2/4afbc0853d7ab64180a2b4fca9b52c363f7c03d5/stage-and-run.sh" -o $L
[ "$(git hash-object $L)" = "ecdb4ec6dda2f4cc1fe7c8b0bf26b38e9251cc3e" ] || stop LOADER_HASH
sh $L --stage-only | tee "$OUT/stage.txt"
grep -q "WX_V11_STAGE_OK files=23 hashes=23" "$OUT/stage.txt" || stop STAGE_FAILED
curl -fsSL "https://raw.githubusercontent.com/homayounisaghar/cf-exec-plane/70375de0b56531f520882b9668c1264d2db1c439/research-stage/wechat-ui-engine-v2/4afbc0853d7ab64180a2b4fca9b52c363f7c03d5/wx_voice_fix_v1116.py" -o /tmp/wxeng/wx_voice_fix.py
[ "$(git hash-object /tmp/wxeng/wx_voice_fix.py)" = "b9ba12628b2cf7c36476192f5e36f78fb64a3e0d" ] || stop FIX_HASH
step AUDIO_ENV
WC=/var/lib/capability-fabric/pcg/wechat/home/.config/pulse/client.conf
PS=$(sed -n 's/^ *default-server *= *//p' "$WC" 2>/dev/null | head -1)
[ -n "$PS" ] && export PULSE_SERVER="$PS"; echo "PULSE_SERVER=${PULSE_SERVER:-unset}"
( cd /tmp/wxeng && bash ./with_wechat_env.sh sh -c '
  pactl list short sources | grep -q wxmic_persist_src || { pactl load-module module-null-sink sink_name=wxmic_persist_sink rate=48000 channels=1 sink_properties=device.description=WeChatMicSink; pactl load-module module-remap-source master=wxmic_persist_sink.monitor source_name=wxmic_persist_src source_properties=device.description=Microphone; }
  pactl set-default-source wxmic_persist_src; pactl info | grep "Default Source"' )
sh $L --v10 voice-probe >/dev/null; cp /tmp/wxeng/v10_last.json "$OUT/probe.json"
grep -q '"ready": *true' "$OUT/probe.json" || stop AUDIO_NOT_READY
step SHOT_BEFORE; shot before.png
send(){ # $1 tag  $2 file  -> $OUT/$1.json
  RF=$(realpath "$2"); SHA=$(printf '%s' "$RF" | sha256sum | cut -d' ' -f1); rm -f /tmp/wxeng/v10_last.json
  ( cd /tmp/wxeng && timeout 300 bash ./with_wechat_env.sh env WXV_STRATEGY=exact WXV_TAIL_S="${TAIL:-0}" PULSE_SERVER="${PULSE_SERVER:-}" python3 ./wx_voice_fix.py send-voice "File Transfer" "$RF" "$SHA" 1 >/dev/null ); echo "send_exit=$?"
  cp /tmp/wxeng/v10_last.json "$OUT/$1.json" 2>/dev/null
  python3 - "$OUT/$1.json" <<'PY'
import json, sys
try: d = json.load(open(sys.argv[1]))
except Exception as e: print("RESULT none", e); sys.exit()
r = d.get("result") or {}
x = (r.get("results") or [{}])[-1]
print("RESULT status=%s bubble_s=%s audio_s=%s diff=%s toggle_to_press=%s mic_open_before_press=%s press_to_release=%s blocked=%s" % (
  r.get("status"), x.get("bubble_s"), x.get("audio_s"), x.get("bubble_minus_audio_s"), r.get("toggle_to_press_s"),
  r.get("mic_open_before_press_s"), r.get("press_to_release_s"), d.get("blocked")))
PY
}
ok(){ python3 -c "
import json,sys
d=json.load(open('$OUT/$1.json')); r=d.get('result') or {}; x=(r.get('results') or [{}])[-1]
print(1 if r.get('status')=='VOICE_ALL_SENT' and x.get('bubble_minus_audio_s') is not None and abs(x['bubble_minus_audio_s'])<=1.5 else 0)" 2>/dev/null || echo 0; }
diffof(){ python3 -c "
import json,math
d=json.load(open('$OUT/$1.json')); r=d.get('result') or {}; x=(r.get('results') or [{}])[-1]
b=x.get('bubble_s'); dur=r.get('duration_s')
print('NA' if b is None or dur is None or r.get('status')!='VOICE_ALL_SENT' else round(b-dur,2))" 2>/dev/null || echo NA; }
V=$(ls -t /tmp/wxeng/in/voice_* 2>/dev/null | head -1)
[ -n "$V" ] || stop NO_TELEGRAM_VOICE_ON_SERVER
echo "source: $(basename "$V") duration=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$V")"
step EXACT_TRY_1
TAIL=0; C=/tmp/wxeng/in/exact1_$(date +%m%d_%H%M%S)_$(basename "$V"); cp -f "$V" "$C"
send cal1 "$C"; D1=$(diffof cal1); echo "diff1=$D1 (WeChat length minus real length)"
BEST_TAIL=0; D2=skipped
if [ "$D1" != NA ] && python3 -c "import sys; sys.exit(0 if $D1 >= 1.0 else 1)"; then
  step EXACT_TRY_2_WITH_CORRECTION
  TAIL=$(python3 -c "print(round(-($D1 - 0.5), 2))"); echo "correction WXV_TAIL_S=$TAIL"
  sleep 3; C=/tmp/wxeng/in/exact2_$(date +%m%d_%H%M%S)_$(basename "$V"); cp -f "$V" "$C"
  send cal2 "$C"; D2=$(diffof cal2); echo "diff2=$D2"
  if [ "$D2" != NA ] && python3 -c "import sys; sys.exit(0 if abs($D2) < abs($D1) else 1)"; then BEST_TAIL=$TAIL; fi
fi
if [ "$D1" != NA ]; then echo exact > /tmp/wxeng/voice_strategy; echo "$BEST_TAIL" > /tmp/wxeng/voice_tail_s; echo "exact mode ENABLED, tail=$BEST_TAIL"; else echo "exact mode NOT enabled (send failed)"; fi
OK1=$D1; OK2=$D2
step READ_CHAT
sh $L --v10 read "File Transfer" 15 >/dev/null; cp /tmp/wxeng/v10_last.json "$OUT/read.json" 2>/dev/null
step SHOT_AFTER; shot after.png
ffmpeg -nostdin -v error -y -i "$OUT/before.png" -i "$OUT/after.png" -filter_complex "[0]scale=iw/2:-1[a];[1]scale=iw/2:-1[b];[a][b]hstack" "$OUT/montage.png" || cp "$OUT/after.png" "$OUT/montage.png"
step SUMMARY
python3 - "$OUT" "$OK1" "$OK2" <<'PY'
import json, os, re, sys
OUT, OK1, OK2 = sys.argv[1:4]
def load(n):
    try: return json.load(open(OUT + "/" + n))
    except Exception: return {}
def metr(n):
    d = load(n); r = d.get("result") or {}; x = (r.get("results") or [{}])[-1]
    return {"status": r.get("status") or d.get("blocked"), "file": r.get("file"), "file_duration_s": r.get("duration_s"),
            "audio_played_s": x.get("audio_s"), "wechat_bubble_s": x.get("bubble_s"), "diff_s": x.get("bubble_minus_audio_s"),
            "toggle_to_press_s": r.get("toggle_to_press_s"), "mic_open_before_press_s": r.get("mic_open_before_press_s"),
            "press_to_release_s": r.get("press_to_release_s"), "new_row": x.get("new_row"), "direction": x.get("direction"),
            "timeline": r.get("timeline")}
rd = (load("read.json").get("result") or {}).get("messages") or []
voices = []
for m in rd:
    s = json.dumps(m, ensure_ascii=False)
    b = re.search(r'(?:Audio|Voice|\u8bed\u97f3)[^0-9"]{0,6}(\d+)\s*(?:\\"|\u201d|\u2033|s\b|\u79d2)', s)
    if b: voices.append({"wechat_length_s": int(b.group(1)), "row": s[:160]})
s = {"run": "voicecal2 v11.16 exact", "try1": metr("cal1.json"), "try2": metr("cal2.json") if OK2 != "skipped" else "skipped",
     "diff1_s": OK1, "diff2_s": OK2, "strategy_now": open("/tmp/wxeng/voice_strategy").read().strip() if os.path.exists("/tmp/wxeng/voice_strategy") else None,
     "tail_s_now": open("/tmp/wxeng/voice_tail_s").read().strip() if os.path.exists("/tmp/wxeng/voice_tail_s") else None,
     "voice_rows_in_file_transfer": voices, "goal": "WeChat length == real length (diff within +-1 s; WeChat shows whole seconds)"}
json.dump(s, open(OUT + "/SUMMARY.json", "w"), ensure_ascii=False, indent=1)
print(json.dumps({k: v for k, v in s.items() if k != "voice_rows_in_file_transfer"}, ensure_ascii=False, default=str)[:1800])
PY
echo DONE > "$OUT/STATUS"
