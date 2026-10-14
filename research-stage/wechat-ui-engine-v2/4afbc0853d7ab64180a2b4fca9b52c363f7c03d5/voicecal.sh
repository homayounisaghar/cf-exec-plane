#!/bin/bash
# WeChat voice timing check + fix v11.15 (owner requested 2026-10-14).
# 1) reads the File Transfer chat (read-only) and lists the length WeChat shows
#    for earlier voice messages; 2) sends ONE 6.0 s test tone with the fix
#    (mic suspended until the press) and compares WeChat's length to the real
#    length; 3) only if that is correct: sends the latest Telegram voice that is
#    already on the server ONCE more with the fix and compares again;
#    4) if correct, makes the fix the default for sendvoice.sh. Mouse only.
set -u
OUT=/tmp/wxeng/voicecal
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
curl -fsSL "https://raw.githubusercontent.com/homayounisaghar/cf-exec-plane/8398daa744410c0c9dc618c986d8e10482e2a451/research-stage/wechat-ui-engine-v2/4afbc0853d7ab64180a2b4fca9b52c363f7c03d5/wx_voice_fix.py" -o /tmp/wxeng/wx_voice_fix.py
[ "$(git hash-object /tmp/wxeng/wx_voice_fix.py)" = "1ccfe3093b9d5d61c3b0b6cc58288948951ee417" ] || stop FIX_HASH
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
  ( cd /tmp/wxeng && timeout 300 bash ./with_wechat_env.sh env WXV_STRATEGY=suspend PULSE_SERVER="${PULSE_SERVER:-}" python3 ./wx_voice_fix.py send-voice "File Transfer" "$RF" "$SHA" 1 >/dev/null ); echo "send_exit=$?"
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
step TEST_TONE_6S_WITH_FIX
T=/tmp/wxeng/in/caltone_$(date +%m%d_%H%M%S).wav; mkdir -p /tmp/wxeng/in
ffmpeg -nostdin -v error -y -f lavfi -i "sine=frequency=660:duration=6" -af "volume=0.35" -ar 48000 -ac 1 "$T"
send cal1 "$T"
OK1=$(ok cal1); echo "tone_ok=$OK1"
OK2=skipped
if [ "$OK1" = 1 ]; then
  step TELEGRAM_VOICE_AGAIN_WITH_FIX
  V=$(ls -t /tmp/wxeng/in/voice_* 2>/dev/null | head -1)
  if [ -n "$V" ]; then
    C=/tmp/wxeng/in/fixcheck_$(date +%m%d_%H%M%S)_$(basename "$V")
    cp -f "$V" "$C"; echo "telegram voice: $(basename "$V") duration=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$C")"
    sleep 3; send cal2 "$C"; OK2=$(ok cal2)
  else OK2=no_telegram_file_on_server; fi
fi
echo "telegram_ok=$OK2"
if [ "$OK1" = 1 ] && [ "$OK2" != 0 ]; then echo suspend > /tmp/wxeng/voice_strategy; echo "FIX ENABLED for sendvoice"; else echo legacy > /tmp/wxeng/voice_strategy; echo "fix NOT enabled"; fi
step READ_CHAT
sh $L --v10 read "File Transfer" 15 >/dev/null; cp /tmp/wxeng/v10_last.json "$OUT/read.json" 2>/dev/null
step SHOT_AFTER; shot after.png
ffmpeg -nostdin -v error -y -i "$OUT/before.png" -i "$OUT/after.png" -filter_complex "[0]scale=iw/2:-1[a];[1]scale=iw/2:-1[b];[a][b]hstack" "$OUT/montage.png" || cp "$OUT/after.png" "$OUT/montage.png"
step SUMMARY
python3 - "$OUT" "$OK1" "$OK2" <<'PY'
import json, re, sys
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
s = {"run": "voicecal v11.15", "test_tone_6s": metr("cal1.json"), "telegram_voice_again": metr("cal2.json") if OK1 == "1" else "skipped",
     "tone_ok": OK1 == "1", "telegram_ok": OK2, "fix_enabled_for_sendvoice": open("/tmp/wxeng/voice_strategy").read().strip() == "suspend",
     "voice_rows_in_file_transfer": voices,
     "expected": "diff_s within +-1.5 s (audio_played_s includes 0.8 s of added lead/tail silence)"}
json.dump(s, open(OUT + "/SUMMARY.json", "w"), ensure_ascii=False, indent=1)
print(json.dumps({k: v for k, v in s.items() if k != "voice_rows_in_file_transfer"}, ensure_ascii=False, default=str)[:1800])
PY
echo DONE > "$OUT/STATUS"
