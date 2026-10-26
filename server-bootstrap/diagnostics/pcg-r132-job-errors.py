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
