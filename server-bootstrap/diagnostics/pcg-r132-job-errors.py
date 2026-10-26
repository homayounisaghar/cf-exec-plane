#!/usr/bin/env python3
# Diagnostic for owner-approved PCG r132 release: metadata only, no audio/text or credentials.
import json, pathlib, datetime
state=pathlib.Path('/var/lib/capability-fabric/pcg/run/perplexity-asr-state')
if not state.is_dir():
    print("PCG_DIAG_STATE_DIR_MISSING")
else:
    files=sorted(state.glob('*.json'),key=lambda p:p.stat().st_mtime,reverse=True)[:22]
    for p in files:
        try:
            d=json.loads(p.read_text(encoding='utf-8'))
            out={'state':d.get('state'),'error':str(d.get('error') or '')[:240],
                 'ms':d.get('inference_ms'),'parallelism_requested':d.get('parallelism_requested'),
                 'parts_total':d.get('parts_total'),'created_time':datetime.datetime.fromtimestamp(d.get('created_at_ms',0)/1000,datetime.timezone.utc).isoformat() if d.get('created_at_ms') else None}
            print('PCG_DIAG_JOB_META '+json.dumps(out,ensure_ascii=True))
        except Exception as e:
            print('PCG_DIAG_FILE_ERROR '+type(e).__name__)

# Confirm whether the active Playwright container has a native audio decoder.
import subprocess
for args in [
 ['docker','exec','capability-fabric-pcg-perplexity-asr','sh','-lc','if command -v ffmpeg >/dev/null; then command -v ffmpeg; ffmpeg -version | head -n 1; else echo FFMPEG_NOT_INSTALLED; fi; if command -v ffprobe >/dev/null; then command -v ffprobe; else echo FFPROBE_NOT_INSTALLED; fi'],
 ['docker','inspect','--format','MEMORY_LIMIT={{.HostConfig.Memory}} OOM_KILLED={{.State.OOMKilled}}','capability-fabric-pcg-perplexity-asr']
]:
 try:
  r=subprocess.run(args,check=False,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,timeout=15)
  print('PCG_DIAG_CONTAINER '+r.stdout.strip()[:700]+' STATUS='+str(r.returncode))
 except Exception as e:
  print('PCG_DIAG_CONTAINER_ERROR '+type(e).__name__)
