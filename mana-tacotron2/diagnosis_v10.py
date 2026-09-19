#!/usr/bin/env python3
import hashlib
import itertools
import json
import math
import sys
import tempfile
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
import torch

import reference_forensics as rf
import reference_corpus_v09 as rc

METRICS = [
    "speaker_distance",
    "duration_ratio",
    "f0_median_abs_diff_hz",
    "f0_iqr_abs_diff_hz",
    "ltas_rmse_db",
]
BINDING_SHORT = {"duration_ratio", "f0_iqr_abs_diff_hz", "ltas_rmse_db"}
BUCKETS = [(1.0,2.0),(2.0,3.0),(3.0,5.0),(5.0,9.0)]

def stable_json(obj):
    return json.dumps(obj,ensure_ascii=False,sort_keys=True,separators=(",",":"))+"\n"

def sha256_file(p):
    h=hashlib.sha256()
    with open(p,"rb") as f:
        for b in iter(lambda:f.read(1<<20),b""):
            h.update(b)
    return h.hexdigest()

def nearest_rank(vals,q):
    vals=sorted(float(x) for x in vals)
    if not vals:
        return None
    k=max(1,math.ceil(q*len(vals)))
    return vals[k-1]

def pct_rank(vals,x):
    vals=[float(v) for v in vals]
    return 100.0*sum(v<=float(x) for v in vals)/len(vals)

def load_manifest(corpus):
    j=json.load(open(corpus/"reference_corpus_manifest.json",encoding="utf-8"))
    by={}
    for r in j["records"]:
        by.setdefault(int(r["sentence_id"]),[]).append(r)
    for v in by.values():
        v.sort(key=lambda r:int(r["render_index"]))
    return j,by

def build_within(corpus):
    comp=json.load(open(corpus/"p0-11-comparison.json",encoding="utf-8"))
    manifest,by=load_manifest(corpus)
    rows=[]
    for sid in range(20):
        pairs=comp["local_spread"][str(sid)]["pairs"]
        for (i,j),m in zip(itertools.combinations(range(3),2),pairs):
            d=(float(by[sid][i]["duration"])+float(by[sid][j]["duration"]))/2.0
            bucket=next((b for b in BUCKETS if b[0] <= d < b[1]),None)
            rows.append({"sentence_id":sid,"i":i,"j":j,"duration":d,"bucket":bucket,"metrics":m})
    return comp,manifest,by,rows

def d_a(corpus):
    comp,manifest,by,rows=build_within(corpus)
    obs={}
    for b in BUCKETS:
        key=f"[{int(b[0])},{int(b[1])})"
        subset=[r for r in rows if r["bucket"]==b]
        obs[key]={"n":len(subset),"metrics":{}}
        for m in METRICS:
            vals=[r["metrics"][m] for r in subset]
            obs[key]["metrics"][m]={
                "p50_nearest_rank":nearest_rank(vals,0.50),
                "p95_nearest_rank":nearest_rank(vals,0.95) if len(vals)>=20 else None,
                "descriptive_p95_nearest_rank":nearest_rank(vals,0.95),
                "max":max(vals) if vals else None,
                "acceptance_eligible":len(vals)>=20,
            }

    short=obs["[1,2)"]
    if short["n"] < 20:
        return {"verdict":"INCONCLUSIVE","reason":"R-005 minimum 20 observations not met","buckets":obs}
    cross=[]
    for x in comp["hosted_vs_local"]:
        row={"hosted_index":x["hosted_index"],"local_render_index":x["local_render_index"],"metrics":{}}
        binding_exceeds=0
        for m in METRICS:
            vals=[r["metrics"][m] for r in rows if r["bucket"]==(1.0,2.0)]
            p95=short["metrics"][m]["p95_nearest_rank"]
            admissible=m in BINDING_SHORT
            exceeded=float(x[m])>float(p95)
            if admissible and exceeded:
                binding_exceeds += 1
            row["metrics"][m]={
                "value":float(x[m]),
                "percentile_rank_within_local":pct_rank(vals,x[m]),
                "p95":p95,
                "admissible_under_D13":admissible,
                "exceeds_p95":exceeded,
            }
        row["binding_exceed_count"]=binding_exceeds
        row["pair_verdict"]="FAIL" if binding_exceeds>=2 else "PASS"
        cross.append(row)
    verdict="FAIL" if any(r["pair_verdict"]=="FAIL" for r in cross) else "PASS"
    return {
        "verdict":verdict,
        "quantile_method":"nearest-rank empirical percentile",
        "minimum_band_observations":20,
        "buckets":obs,
        "cross":cross,
        "note":"speaker distance and F0 median are diagnostic-only for this ~1.1 s hosted anchor under D13",
    }

def setup_reference(space,synth):
    if sha256_file(synth)!=rf.SYNTH_SHA256:
        raise RuntimeError("synthesizer hash mismatch")
    if rf.subprocess.check_output(["git","-C",str(space),"rev-parse","HEAD"],text=True).strip()!=rf.SPACE_COMMIT:
        raise RuntimeError("space commit mismatch")
    rf.run_setup(space,synth)
    syn=rc.import_space_synthesis(space)
    return syn

def rerender_hash(space,syn,record):
    _,mapping=rc.symbol_mapping(space)
    raw=record["input"]
    safe,dropped=rc.guarded_input(raw,syn,space,mapping)
    render_input=safe if dropped else raw
    seed=int(record["seed"])
    torch.manual_seed(seed)
    np.random.seed(seed & 0xffffffff)
    result=syn.generate_speech(render_input)
    sr,y=rc.extract_audio(result)
    if int(sr)!=int(record["sample_rate"]):
        raise RuntimeError("sample rate mismatch")
    with tempfile.NamedTemporaryFile(suffix=".wav",delete=False) as tmp:
        p=Path(tmp.name)
    try:
        sf.write(p,np.asarray(y,dtype=np.float32),int(sr),subtype="PCM_16")
        return {
            "sentence_id":int(record["sentence_id"]),
            "seed":seed,
            "expected_sha256":record["sha256"],
            "actual_sha256":sha256_file(p),
            "match":sha256_file(p)==record["sha256"],
            "generated_size":p.stat().st_size,
        }
    finally:
        p.unlink(missing_ok=True)

def speaker_embedding(y,sr,enc):
    y=np.asarray(y,dtype=np.float32)
    if y.ndim>1:
        y=y.mean(axis=1)
    if int(sr)!=16000:
        y=librosa.resample(y,orig_sr=int(sr),target_sr=16000)
    prep=enc.preprocess_wav(np.asarray(y,dtype=np.float32),source_sr=None)
    return np.asarray(enc.embed_utterance(prep),dtype=np.float64)

def cosine_distance(a,b):
    return float(1.0 - np.dot(a,b)/(np.linalg.norm(a)*np.linalg.norm(b)))

def quantiles(vals):
    vals=[float(x) for x in vals]
    return {
        "n":len(vals),
        "p50":nearest_rank(vals,0.50),
        "p95":nearest_rank(vals,0.95),
        "min":min(vals),
        "max":max(vals),
    }

def d_c(space,corpus):
    comp,manifest,by,rows=build_within(corpus)
    curves={}
    for b in BUCKETS:
        key=f"[{int(b[0])},{int(b[1])})"
        subset=[r for r in rows if r["bucket"]==b]
        curves[key]={"n":len(subset),"acceptance_eligible":len(subset)>=20,"metrics":{}}
        for m in METRICS:
            vals=[r["metrics"][m] for r in subset]
            curves[key]["metrics"][m]={
                "p50":nearest_rank(vals,0.50),
                "p95_descriptive":nearest_rank(vals,0.95),
                "p95_binding":nearest_rank(vals,0.95) if len(vals)>=20 else None,
            }

    enc=rc.metric_encoder(space)
    embs=[]
    meta=[]
    for r in manifest["records"]:
        p=corpus/"local_reference_audio"/r["wav"]
        y,sr=sf.read(p,dtype="float32",always_2d=False)
        e=speaker_embedding(y,sr,enc)
        embs.append(e)
        meta.append((int(r["sentence_id"]),int(r["render_index"]),r["wav"]))

    within=[]
    cross=[]
    for i,j in itertools.combinations(range(len(embs)),2):
        d=cosine_distance(embs[i],embs[j])
        if meta[i][0]==meta[j][0]:
            within.append(d)
        else:
            cross.append(d)

    sample=space/"sample.wav"
    if sha256_file(sample)!="6952cd2cc42167f6f9f6968cebda51ab47deda254229b194a1f206c989380ae6":
        raise RuntimeError("sample.wav hash mismatch")
    sy,sr=sf.read(sample,dtype="float32",always_2d=False)
    se=speaker_embedding(sy,sr,enc)
    to_sample=[cosine_distance(e,se) for e in embs]

    # Mechanism facts are already frozen in P0-6. Re-read the pinned source values
    # without changing preprocessing/reference behavior.
    partial_frames=None
    step_ms=None
    try:
        params=__import__("encoder.params_data",fromlist=["*"])
        partial_frames=getattr(params,"partials_n_frames",None)
        step_ms=getattr(params,"mel_window_step",None)
    except Exception:
        pass

    return {
        "duration_curves":curves,
        "speaker_distance_scales":{
            "within_sentence_same_text":quantiles(within),
            "cross_sentence_same_speaker":quantiles(cross),
            "local_render_to_pinned_sample_wav":quantiles(to_sample),
        },
        "encoder_mechanism":{
            "partials_n_frames":partial_frames,
            "mel_window_step_ms":step_ms,
            "nominal_partial_window_seconds":(float(partial_frames)*float(step_ms)/1000.0) if partial_frames and step_ms else None,
            "D13_speaker_binding_floor_seconds":3.2,
            "D13_f0_voiced_binding_floor_seconds":2.0,
        },
    }

def main():
    if len(sys.argv)!=5:
        raise SystemExit("usage: diagnosis_v10.py SPACE SYNTH CORPUS OUT")
    space=Path(sys.argv[1]); synth=Path(sys.argv[2]); corpus=Path(sys.argv[3]); out=Path(sys.argv[4])
    out.mkdir(parents=True,exist_ok=True)
    da=d_a(corpus)
    if da["verdict"]=="FAIL":
        # D-D/D-E are deliberately not implemented on the PASS path. A FAIL must
        # stop the driver before Phase 1 and use the separately authorized bounded
        # ablation, never mutate reference behavior.
        pass
    syn=setup_reference(space,synth)
    manifest,by=load_manifest(corpus)
    db=[
        rerender_hash(space,syn,by[0][0]),
        rerender_hash(space,syn,by[12][0]),
    ]
    db_all=all(x["match"] for x in db)
    if not db_all:
        result={
            "schema":"mana.phase0-diagnosis.v1.0",
            "d_a":da,
            "d_b":{"results":db,"all_match":False},
            "d_c":None,
            "d_d_triggered":False,
            "d_e_triggered":False,
            "d12_untouched":True,
            "s17_untouched":True,
            "stop":"S15",
        }
        (out/"phase0-diagnosis-v10.json").write_text(stable_json(result),encoding="utf-8")
        print(stable_json(result),end="")
        raise SystemExit(15)
    dc=d_c(space,corpus)
    result={
        "schema":"mana.phase0-diagnosis.v1.0",
        "d_a":da,
        "d_b":{"results":db,"all_match":True},
        "d_c":dc,
        "d_d_triggered":da["verdict"]=="FAIL",
        "d_e_triggered":da["verdict"]=="FAIL",
        "d12_untouched":True,
        "s17_untouched":True,
    }
    (out/"phase0-diagnosis-v10.json").write_text(stable_json(result),encoding="utf-8")
    print(stable_json(result),end="")

if __name__=="__main__":
    main()
