#!/usr/bin/env python3
"""Run exactly one 2-part native WeChat voice canary to the owner's self chat."""
import hashlib, json, os, pathlib, subprocess, sys, time, urllib.request
UID=1000
ROOT=pathlib.Path("/tmp/wxeng")
PREPARED=pathlib.Path("/home/cfserver/wechat-media-tools-candidate-20261030/wechat_59s_multipart_qa_20261031.prepared.json")
STARTED=pathlib.Path("/home/cfserver/wechat-media-tools-candidate-20261030/wechat_59s_multipart_qa_20261031.started")
REPORT=pathlib.Path("/home/cfserver/wechat-media-tools-candidate-20261030/wechat_59s_multipart_qa_20261031.result.json")
ENV=dict(os.environ,XDG_RUNTIME_DIR="/run/user/1000",DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/1000/bus",PULSE_SERVER="unix:/run/user/1000/pulse/native")
def run(args,*,cwd=None,timeout=40,check=True):
 p=subprocess.run(args,cwd=cwd,env=ENV,capture_output=True,text=True,timeout=timeout)
 if check and p.returncode:raise RuntimeError("COMMAND_FAILED "+str(args[:4])+" rc="+str(p.returncode)+" "+p.stderr[-500:])
 return p
def state():
 p=run(["systemd-run","--user","--scope","--collect","--quiet","/bin/bash","./with_wechat_env.sh","/usr/bin/python3","./wx_v10.py","state"],cwd=ROOT,timeout=22)
 d=json.loads(p.stdout[p.stdout.find("{"):]);r=d.get("result",{})
 ok=d.get("ok") and r.get("selected")=="File Transfer" and r.get("header_ok") is True and r.get("composer_empty") is True and r.get("send_enabled") is False and r.get("search_empty") is True and r.get("no_extra_window") is True
 if not ok:raise RuntimeError("SELF_CHAT_PREFLIGHT_FAILED "+json.dumps(r))
 return r
def main():
 if os.getuid()!=UID:raise RuntimeError("RUN_AS_CFServer_UID_1000_NO_SUDO")
 if not PREPARED.is_file() or STARTED.exists() or REPORT.exists():raise RuntimeError("NO_PREPARED_CANARY_OR_ALREADY_STARTED_NO_RETRY")
 d=json.loads(PREPARED.read_text());src=pathlib.Path(d["source"])
 if d.get("state")!="PREPARED_NO_SEND" or d.get("target")!="File Transfer" or d.get("chunks")!=[59.0,53.0]:raise RuntimeError("PREPARED_PLAN_CHANGED")
 if not src.is_file() or hashlib.sha256(src.read_bytes()).hexdigest()!=d["source_sha256"]:raise RuntimeError("SOURCE_BYTES_CHANGED")
 with urllib.request.urlopen("http://127.0.0.1:9337/status",timeout=5) as r:auth=json.loads(r.read())
 if auth.get("authenticated") is not True:raise RuntimeError("WECHAT_NOT_AUTHENTICATED")
 if "Default Source: cf_wechat_preboot_mic" not in run(["pactl","info"]).stdout:raise RuntimeError("PREBOOT_MIC_NOT_DEFAULT")
 state()
 # Re-check every per-part one-shot marker immediately before the single dispatch.
 sys.path.insert(0,str(ROOT))
 import wx_voice,wx_common
 digest=wx_voice._file_digest(str(src.resolve()))
 parts=wx_voice.plan_chunks(float(d["duration_s"]))
 if len(parts)!=2:raise RuntimeError("CHUNK_PLAN_CHANGED")
 for i in range(1,3):
  payload="voice:%s:%s:%d/%d"%(str(src.resolve()),digest,i,2)
  if wx_common.already_attempted("File Transfer",payload):raise RuntimeError("PART_ALREADY_ATTEMPTED_NO_RETRY")
 receipt_path=ROOT/"v10_last.json"
 archive=ROOT/"v10_last_before_qa_20261031.json"
 if archive.exists():raise RuntimeError("OLD_RECEIPT_ARCHIVE_EXISTS_NO_OVERWRITE")
 fd=os.open(STARTED,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,"w") as f:f.write("ONE_SHOT_STARTED_NO_RETRY\n");f.flush();os.fsync(f.fileno())
 if receipt_path.exists():os.replace(receipt_path,archive)
 pathhash=hashlib.sha256(str(src.resolve()).encode()).hexdigest()
 cmd=["systemd-run","--user","--scope","--collect","--quiet","/bin/bash","./with_wechat_env.sh",
      "/usr/bin/env","WXV_STRATEGY=complete","PULSE_SERVER=unix:/run/user/1000/pulse/native",
      "/usr/bin/python3","./wx_voice_fix.py","send-voice","File Transfer",str(src.resolve()),pathhash,"2"]
 started=time.monotonic()
 dispatch_started=time.time_ns()
 proc=run(cmd,cwd=ROOT,timeout=300,check=False)
 if not receipt_path.is_file() or receipt_path.stat().st_mtime_ns < dispatch_started:raise RuntimeError("NO_FRESH_ENGINE_RECEIPT_OUTCOME_UNKNOWN_DO_NOT_RETRY")
 result=json.loads(receipt_path.read_text())
 rep=result.get("result") or {}
 rows=rep.get("results") or []
 parts_verified=(result.get("ok") is True and rep.get("status")=="VOICE_ALL_SENT" and len(rows)==2 and
           [x.get("chunk") for x in rows]==[1,2] and
           all(x.get("status")=="VOICE_SENT_VERIFIED" and x.get("direction")=="out" and
               x.get("capture_seen") is True and x.get("pacat_rc")==0 and
               x.get("pacat_finished_before_release") is True and
               x.get("held_s") is not None and float(x["held_s"])<=60.0 and
               x.get("bubble_s") is not None and 1<=int(x["bubble_s"])<=60 and
               abs(float(x.get("bubble_s"))-float(x.get("audio_s")))<=1.0
               for x in rows))
 post={}
 try:
  post["ui"]=state()
  with urllib.request.urlopen("http://127.0.0.1:9337/status",timeout=5) as r:post["auth"]=json.loads(r.read())
  post["pulse_default"]="cf_wechat_preboot_mic" if "Default Source: cf_wechat_preboot_mic" in run(["pactl","info"]).stdout else "MISMATCH"
  mods=run(["pactl","list","short","modules"]).stdout
  post["temporary_wechat_audio_modules_remaining"]=("wxv11_" in mods)
  post["elapsed_s"]=round(time.monotonic()-started,2)
 except Exception as e:post["postflight_error"]=type(e).__name__+":"+str(e)[:250]
 post_ok=(not post.get("postflight_error") and post.get("auth",{}).get("authenticated") is True and
          post.get("pulse_default")=="cf_wechat_preboot_mic" and
          post.get("temporary_wechat_audio_modules_remaining") is False)
 verified=parts_verified and post_ok
 report={"state":"TWO_PARTS_VERIFIED" if verified else "PARTIAL_OR_IN_DOUBT_NO_RETRY",
         "engine_exit":proc.returncode,"overall":rep.get("status"),"fix":rep.get("fix_version"),
         "strategy":rep.get("strategy"),"source_duration_s":rep.get("duration_s"),
         "parts":[{k:x.get(k) for k in ("chunk","status","direction","audio_s","held_s","pacat_rc",
                    "pacat_finished_before_release","bubble_s","bubble_minus_audio_s","capture_seen",
                    "recording_hint","new_row")} for x in rows],
         "postflight":post,"retry_performed":False}
 fd=os.open(REPORT,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,"w") as f:json.dump(report,f,ensure_ascii=False,indent=2);f.write("\n");f.flush();os.fsync(f.fileno())
 print(json.dumps(report,ensure_ascii=False))
 if not verified:raise RuntimeError("CANARY_NOT_FULLY_VERIFIED; DO NOT RETRY")
if __name__=="__main__":
 try:main()
 except Exception as e:
  print("STOPPED_OR_IN_DOUBT_NO_RETRY:",type(e).__name__,str(e)[:1000],file=sys.stderr)
  raise
