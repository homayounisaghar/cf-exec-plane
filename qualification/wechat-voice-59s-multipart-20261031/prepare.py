#!/usr/bin/env python3
"""Prepare a one-time, owner-self 2-part WeChat voice qualification. NO SEND."""
import hashlib, json, math, os, pathlib, re, shutil, subprocess, sys, urllib.request, wave
UID = 1000
ROOT = pathlib.Path("/tmp/wxeng")
IN = ROOT / "in"
SOURCE = IN / "wechat_59s_multipart_qa_20261031.wav"
PREPARED = pathlib.Path("/home/cfserver/wechat-media-tools-candidate-20261030/wechat_59s_multipart_qa_20261031.prepared.json")
BASE = "https://raw.githubusercontent.com/homayounisaghar/cf-exec-plane"
LOADER_COMMIT = "f56eb4f94e3b2d1ac2c7ef0795670ae266f52f47"
LOADER_BLOB = "ead2c4abff9b469dd429fe63ea32d04b6744ac17"
MANIFEST_BLOB = "f2483bbd1e52f725085528966296786adc38a6ef"
FIX_COMMIT = "70375de0b56531f520882b9668c1264d2db1c439"
FIX_BLOB = "b9ba12628b2cf7c36476192f5e36f78fb64a3e0d"
VOICE_BLOB = "e924f1c5792d1d8f0bfb0c78bc03ab3ff271cbc8"
ENV = dict(os.environ, XDG_RUNTIME_DIR="/run/user/1000",
           DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/1000/bus",
           PULSE_SERVER="unix:/run/user/1000/pulse/native")

def run(args, *, cwd=None, timeout=45, check=True):
    p = subprocess.run(args, cwd=cwd, env=ENV, capture_output=True, text=True, timeout=timeout)
    if check and p.returncode:
        raise RuntimeError("COMMAND_FAILED " + str(args[:4]) + " rc=" + str(p.returncode) + " " + p.stderr[-500:])
    return p

def fetch(url, path, expected_blob):
    run(["curl","-fsSL","--retry","3","--retry-all-errors","--max-time","45",url,"-o",str(path)], timeout=60)
    got = run(["git","hash-object",str(path)]).stdout.strip()
    if got != expected_blob:
        raise RuntimeError("PIN_MISMATCH " + str(path.name) + " " + got)
    return got

def replace_once(src, old, new, label):
    if src.count(old) != 1:
        raise RuntimeError("PATCH_SOURCE_DRIFT " + label + " count=" + str(src.count(old)))
    return src.replace(old, new)

def main():
    if os.getuid() != UID:
        raise RuntimeError("RUN_AS_CFServer_UID_1000_NO_SUDO")
    if PREPARED.exists() or SOURCE.exists():
        raise RuntimeError("QA_ARTIFACT_ALREADY_EXISTS_NO_RETRY")
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    IN.mkdir(mode=0o700, parents=True, exist_ok=True)
    loader = pathlib.Path("/tmp/wx-v11.sh")
    fetch(BASE + "/" + LOADER_COMMIT + "/research-stage/wechat-ui-engine-v2/4afbc0853d7ab64180a2b4fca9b52c363f7c03d5/stage-and-run.sh", loader, LOADER_BLOB)
    stage = run(["sh",str(loader),"--stage-only"],cwd=ROOT,timeout=100)
    if "WX_V11_STAGE_OK files=23 hashes=23" not in stage.stdout:
        raise RuntimeError("PINNED_V11_STAGE_NOT_VERIFIED " + stage.stdout[-700:])
    manifest = ROOT / "MANIFEST"
    if not manifest.is_file() or run(["git","hash-object",str(manifest)]).stdout.strip() != MANIFEST_BLOB:
        raise RuntimeError("V11_MANIFEST_PIN_MISMATCH")
    entries = []
    for line in manifest.read_text().splitlines():
        if not line or line.startswith("#"):
            continue
        sha, name = line.split(" ",1)
        f = ROOT / name
        if not f.is_file() or f.is_symlink() or run(["git","hash-object",str(f)]).stdout.strip() != sha:
            raise RuntimeError("V11_SOURCE_FILE_HASH_MISMATCH " + name)
        entries.append(name)
    if len(entries) != 23:
        raise RuntimeError("V11_SOURCE_COUNT_MISMATCH")
    voice = ROOT / "wx_voice.py"
    if run(["git","hash-object",str(voice)]).stdout.strip() != VOICE_BLOB:
        raise RuntimeError("VOICE_ENGINE_BASELINE_HASH_MISMATCH")
    backup = ROOT / "wx_voice_v11_pinned_original.py"
    if backup.exists():
        raise RuntimeError("VOICE_BACKUP_ALREADY_EXISTS_NO_OVERWRITE")
    shutil.copy2(voice, backup)
    if run(["git","hash-object",str(backup)]).stdout.strip() != VOICE_BLOB:
        raise RuntimeError("VOICE_BACKUP_HASH_MISMATCH")
    s = voice.read_text()
    s = replace_once(s,
        '"""Voice messages v11: send ANY audio file as WeChat voice message(s).',
        '"""Unreleased fail-closed native voice engine candidate based on pinned v11.7.\n\nNOT a deployed or live-qualified CF capability. Original 59-second planner retained.\n\nVoice messages v11: send ANY audio file as WeChat voice message(s).',
        "candidate-docstring")
    s = replace_once(s,
        '                    if c.already_attempted(name, payload):\n                        rep["results"].append({"chunk": i + 1, "status": "SKIPPED_ALREADY_ATTEMPTED"})\n                        continue',
        '                    if c.already_attempted(name, payload):\n                        rep["results"].append({"chunk": i + 1, "status": "STOPPED_PRIOR_ATTEMPT_NEEDS_RECONCILIATION"})\n                        break',
        "stop-after-prior-chunk")
    s = replace_once(s,
        '                    if r["status"] != "RELEASED":\n                        # Nothing recorded: if no new row appears, free the marker.\n                        _, grew, _ = c.wait_until(backend, lambda s: _rows_names(s) != before, 2.0, 0.15)\n                        if not grew:\n                            mk = c.MARKER_DIR / (c.send_key(name, payload) + ".attempt")\n                            try:\n                                mk.unlink()\n                                r["marker_released"] = True\n                            except OSError:\n                                pass\n                        break',
        '                    if r["status"] != "RELEASED":\n                        # Never remove an attempt marker after a press or uncertain result.\n                        break\n                    if r.get("pacat_rc") != 0 or r.get("pacat_finished_before_release") is not True:\n                        r["status"] = "IN_DOUBT_FULL_PLAYBACK_NOT_VERIFIED"\n                        break\n                    if r.get("held_s") is None or r["held_s"] > 60.0:\n                        r["status"] = "IN_DOUBT_CAPTURE_OVER_PROVIDER_LIMIT"\n                        break',
        "retain-one-shot-markers-and-full-playback")
    s = replace_once(s,
        '                    r["status"] = "VOICE_SENT_VERIFIED" if r["direction"] == "out" else "VOICE_SENT_UNVERIFIED"\n                    time.sleep(0.8)',
        '                    r["status"] = "VOICE_SENT_VERIFIED" if r["direction"] == "out" else "VOICE_SENT_UNVERIFIED"\n                    if r["status"] != "VOICE_SENT_VERIFIED":\n                        break\n                    time.sleep(0.8)',
        "stop-after-unverified-receipt")
    s = replace_once(s,
        '    sent = sum(1 for r in rep["results"] if str(r.get("status", "")).startswith("VOICE_SENT"))',
        '    sent = sum(1 for r in rep["results"] if r.get("status") == "VOICE_SENT_VERIFIED")',
        "count-only-exactly-verified")
    if "mk.unlink()" in s or "marker_released" in s:
        raise RuntimeError("UNSAFE_MARKER_REMOVAL_REMAINS")
    voice.write_text(s)
    candidate_blob = run(["git","hash-object",str(voice)]).stdout.strip()
    if candidate_blob != "d99995233af193a95740b26503457572c9674017":
        raise RuntimeError("FAIL_CLOSED_CANDIDATE_BLOB_MISMATCH " + candidate_blob)
    fix_pin = ROOT / "wx_voice_fix_v1116.py"
    fetch(BASE + "/" + FIX_COMMIT + "/research-stage/wechat-ui-engine-v2/4afbc0853d7ab64180a2b4fca9b52c363f7c03d5/wx_voice_fix_v1116.py", fix_pin, FIX_BLOB)
    fix = fix_pin.read_text()
    fix = replace_once(fix,
        'STRATEGY = os.environ.get("WXV_STRATEGY", "suspend")',
        'STRATEGY = os.environ.get("WXV_STRATEGY", "complete")\nif STRATEGY != "complete":\n    raise SystemExit("ONLY_FULL_PLAYBACK_COMPLETE_STRATEGY_ADMITTED")',
        "complete-only-strategy")
    fix = replace_once(fix,
        'SUSPEND = STRATEGY in ("suspend", "exact")',
        'SUSPEND = STRATEGY == "complete"',
        "suspend-before-capture")
    fix = replace_once(fix,
        'if STRATEGY == "exact":\n    wv.LEAD_S, wv.TAIL_S = 0.0, 0.0',
        'if STRATEGY == "complete":\n    wv.LEAD_S, wv.TAIL_S = 0.0, 0.0',
        "zero-padding-complete-mode")
    fix = replace_once(fix,
        '        else:\n            mark("play_start")\n            r["pacat_rc"] = mic.play(raw, seconds)\n            mark("play_end")\n            time.sleep(0.15)',
        '        else:\n            mark("play_start")\n            r["pacat_rc"] = mic.play(raw, seconds)\n            r["pacat_finished_before_release"] = r["pacat_rc"] == 0\n            mark("play_end")\n            time.sleep(0.15)',
        "wait-for-full-pacat-drain")
    fix = replace_once(fix,
        '    r["status"] = "RELEASED"\n    return r',
        '    r["status"] = ("RELEASED" if r.get("pacat_rc") == 0 and r.get("pacat_finished_before_release") is True else "IN_DOUBT_FULL_PLAYBACK_FAILED")\n    return r',
        "fail-closed-playback-result")
    fix = replace_once(fix,
        '    rep["fix_version"] = "v11.16"',
        '    rep["fix_version"] = "v11.18-complete-local-candidate"',
        "candidate-version")
    active_fix = ROOT / "wx_voice_fix.py"
    fix_backup = ROOT / "wx_voice_fix_v1116_original.py"
    if active_fix.exists():
        if run(["git","hash-object",str(active_fix)]).stdout.strip() != FIX_BLOB:
            raise RuntimeError("ACTIVE_FIX_NOT_PINNED_V11_16_NO_OVERWRITE")
        if fix_backup.exists():
            raise RuntimeError("FIX_BACKUP_ALREADY_EXISTS_NO_OVERWRITE")
        shutil.copy2(active_fix,fix_backup)
    else:
        if fix_backup.exists():
            raise RuntimeError("FIX_BACKUP_ALREADY_EXISTS_NO_OVERWRITE")
        shutil.copy2(fix_pin,fix_backup)
    if run(["git","hash-object",str(fix_backup)]).stdout.strip() != FIX_BLOB:
        raise RuntimeError("FIX_BACKUP_HASH_MISMATCH")
    active_fix.write_text(fix)
    for f in (voice, active_fix):
        run(["python3","-m","py_compile",str(f)])
    # Build a unique 112s, two-tone/tail-marker sample: 59s + 53s.
    cmd = ["ffmpeg","-nostdin","-v","error","-y",
           "-f","lavfi","-i","sine=frequency=523:duration=58.2",
           "-f","lavfi","-i","sine=frequency=1500:duration=0.8",
           "-f","lavfi","-i","sine=frequency=880:duration=52.2",
           "-f","lavfi","-i","sine=frequency=1700:duration=0.8",
           "-filter_complex","[0:a][1:a][2:a][3:a]concat=n=4:v=0:a=1,aresample=48000",
           "-ac","1","-c:a","pcm_s16le",str(SOURCE)]
    run(cmd,timeout=40)
    dur = float(run(["ffprobe","-v","error","-show_entries","format=duration","-of","default=nw=1:nk=1",str(SOURCE)]).stdout.strip())
    if abs(dur-112.0)>0.02:
        raise RuntimeError("QA_AUDIO_DURATION_MISMATCH " + str(dur))
    import sys
    sys.path.insert(0,str(ROOT))
    import wx_voice, wx_common
    chunks = wx_voice.plan_chunks(dur)
    if len(chunks)!=2 or abs(chunks[0][1]-59.0)>0.002 or abs(chunks[1][1]-53.0)>0.002:
        raise RuntimeError("ORIGINAL_59S_PLANNER_CHANGED " + repr(chunks))
    digest=wx_voice._file_digest(str(SOURCE.resolve()))
    real=str(SOURCE.resolve())
    for i in range(1,3):
        payload="voice:%s:%s:%d/%d"%(real,digest,i,2)
        if wx_common.already_attempted("File Transfer",payload):
            raise RuntimeError("QA_PART_ALREADY_ATTEMPTED_NO_RETRY")
    with urllib.request.urlopen("http://127.0.0.1:9337/status",timeout=5) as r:
        auth=json.loads(r.read())
    if auth.get("authenticated") is not True or auth.get("conversation_count",0)<1:
        raise RuntimeError("WECHAT_NOT_AUTHENTICATED")
    pulse=run(["pactl","info"]).stdout
    if "Default Source: cf_wechat_preboot_mic" not in pulse:
        raise RuntimeError("PREBOOT_MIC_NOT_DEFAULT")
    sources=run(["pactl","list","short","sources"]).stdout
    if "cf_wechat_preboot_mic" not in sources:
        raise RuntimeError("PREBOOT_MIC_NOT_PRESENT")
    state_cmd=["systemd-run","--user","--scope","--collect","--quiet",
               "/bin/bash","./with_wechat_env.sh","/usr/bin/python3","./wx_v10.py","state"]
    st=run(state_cmd,cwd=ROOT,timeout=22)
    state=json.loads(st.stdout[st.stdout.find("{"):])
    rstate=state.get("result",{})
    if not (state.get("ok") and rstate.get("selected")=="File Transfer" and
            rstate.get("header_ok") is True and rstate.get("composer_empty") is True and
            rstate.get("send_enabled") is False and rstate.get("search_empty") is True and
            rstate.get("no_extra_window") is True):
        raise RuntimeError("SELF_CHAT_UI_PREFLIGHT_FAILED " + json.dumps(rstate))
    if PREPARED.exists():
        raise RuntimeError("PREPARED_RECORD_EXISTS_NO_OVERWRITE")
    report={"state":"PREPARED_NO_SEND","source":real,"source_sha256":hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
            "source_bytes":SOURCE.stat().st_size,"duration_s":dur,"chunks":[float(x[1]) for x in chunks],
            "max_source_chunk_s":59,"full_playback_strategy":"complete","target":"File Transfer",
            "auth_conversations":auth.get("conversation_count"),"pulse_default":"cf_wechat_preboot_mic",
            "pinned_v11_modules":23,"fix_blob":FIX_BLOB,"provider_send_performed":False}
    PREPARED.write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n")
    os.chmod(PREPARED,0o600)
    print(json.dumps(report,ensure_ascii=False))
    print("PREPARED_NO_SEND: run the separate one-shot canary command only once.")
if __name__=="__main__":
    try: main()
    except Exception as e:
        print("STOPPED_NO_SEND:",type(e).__name__,str(e)[:1200],file=sys.stderr)
        raise
