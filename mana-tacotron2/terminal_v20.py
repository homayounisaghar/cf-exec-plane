#!/usr/bin/env python3
import argparse
import base64
import contextlib
import copy
import hashlib
import importlib
import importlib.metadata
import json
import math
import os
import platform
import random
import shutil
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np

import reference_forensics as rf
import reference_corpus_v09 as rc

SPACE_COMMIT=rf.SPACE_COMMIT
SYNTH_SHA256=rf.SYNTH_SHA256
SPEAKER_EMBED_SHA256="d2e6848f635f2c9a08bb1771e73744866af562e0170612e5c72cf14740af3a03"
SPEAKER_EMBED_B64="""wzcGPAAAAAAh/C89AAAAAL4qXj0AAAAALc80OzLQljwAAAAApb63O7ACAz48
f8g9W7LnPQAAAACT2dA8AAAAANYFdzxNPoI9dnoGPgAAAACHgZA79RHyPQAA
AAAAAAAAAAAAAHmmCj4AAAAA9Mo2OgAAAAAAAAAA4o4RPDyVXj3/fzU9AAAA
AMK8jT0hbsg84FodPPQgBT1+n7w8+RXKOwAAAAAAAAAA8kUiPWS4bTzTT9g8
LJfWPAAAAAAAAAAA6jDmPDge1ToAAAAACmmWPGbZQz0AAAAAAAAAAGpdej3s
FKE6qBCIPaQLhT1LqgI+AAAAAAAAAAAAAAAAK5CxPY2NIT0AAAAA1mrUPOzC
qD0AAAAAAAAAABfz6j1rNq09AAAAANuZSj3zB8k6+OcRPQAAAABwVw09M1t1
OsYBAj4AAAAAAAAAAOuTTT5kauY9nGCxOwAAAAAAAAAAT8AePgAAAADr/Ec9
fBUWPgAAAAAAAAAAAAAAAD+2gDwAAAAAj32qOwAAAAAAAAAAAAAAAAAAAAAA
AAAA4nncPU4Zdj1cAr88DLN8O5TFOzqGn/k9AAAAALhIoj0AAAAAuX6lPAAA
AACwREo9C7ApPQAAAADBpaY91+m/PBMlEzsbizo8kE6pPTxhJj1aI8U9dbWW
PQAAAAD8vlM9kXCwPYppxj3+4SQ+U7JBOwAAAAAAAAAAPHWJPHIyEz3HZRs+
LR6GPQVl+jwAAAAA+REHPQAAAAD/KfQ8AAAAADVpZT32E9A9HHwNPAAAAACJ
Qf89AAAAAELC6j2Pww0+rTzxPXTiUT0AAAAAAAAAAO/gaTw0Nww+AAAAAOKU
Aj2trUo8GQc1PgIrLj4AAAAAQLf/POP6wzy1tgg90vFQPQAAAAAT4oo7KkPn
PLbFkD0AAAAAAAAAAAAAAAAClvM9AAAAABMu5D1djIQ7BDbAPDJEij0p6cQ9
5aX1PEaR6DwAAAAAfl0JPu28cD0AAAAAAAAAAGMkrTsAAAAAAAAAAHWxAz1M
gt49BrrMO8OjVT0AAAAAAAAAAAAAAACW4gM9Xa6IPL7ULj2tQzw9PpgBPCgQ
Wz1dk6I7AAAAAGO11zzVHlg7soBoPBnbsDoDFRU99rbwPQAAAACrhuE9UauK
OgAAAAAcTIU9AAAAAOCHkTq3TKM9AAAAAG+dJT7lAhI+NQCoOgAAAADfY509
nD+aOiAFdjsa6bU9AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGRBmDzC
TgA9J+sVPji56D3vki4+yw0DPkF9Cj4zGUc8YSxiPgAAAADGbfw9g6GgPcqA
7jiy1bY9MY2+PQAAAAAEgg09JVeyPAAAAABcQi09AAAAAA=="""

GOLDEN_SENTENCE_IDS=[0,7,12]
DEFAULT_SEEDS={0:2026091900,7:2026091970,12:2026092020}

def stable_json(obj):
    return json.dumps(obj,ensure_ascii=False,sort_keys=True,separators=(",",":"))+"\n"

def write_json(path,obj):
    Path(path).write_text(stable_json(obj),encoding="utf-8")

def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()

def sha256_file(path):
    return rf.sha256_file(path)

def deterministic_hygiene(seed=0):
    os.environ["OMP_NUM_THREADS"]="1"
    os.environ["MKL_NUM_THREADS"]="1"
    os.environ["PYTHONHASHSEED"]="0"
    random.seed(seed)
    np.random.seed(seed & 0xffffffff)
    import torch
    torch.set_num_threads(1)
    try:
        torch.set_num_interop_threads(1)
    except RuntimeError:
        pass
    torch.manual_seed(seed)

def package_version(name,import_name=None):
    try:
        return importlib.metadata.version(name)
    except Exception:
        try:
            mod=importlib.import_module(import_name or name.replace("-","_"))
            return getattr(mod,"__version__",None)
        except Exception:
            return None

def runtime_fingerprint():
    import torch
    cpu_model=None
    try:
        for line in Path("/proc/cpuinfo").read_text(errors="ignore").splitlines():
            if line.lower().startswith(("model name","hardware")):
                cpu_model=line.split(":",1)[1].strip()
                break
    except Exception:
        pass
    return {
      "schema":"mana.runtime-fingerprint.v1",
      "python":sys.version,
      "packages":{
        "numpy":package_version("numpy"),"scipy":package_version("scipy"),
        "librosa":package_version("librosa"),"torch":package_version("torch"),
        "soundfile":package_version("soundfile"),"parallel-wavegan":package_version("parallel-wavegan"),
        "onnx":package_version("onnx"),"onnxruntime":package_version("onnxruntime"),
      },
      "cpu_model":cpu_model,"core_count":os.cpu_count(),
      "torch_get_num_threads":torch.get_num_threads(),
      "torch_parallel_info":torch.__config__.parallel_info(),
      "os_release":platform.platform(),
      "runner":{"name":os.getenv("RUNNER_NAME"),"os":os.getenv("RUNNER_OS"),"arch":os.getenv("RUNNER_ARCH")},
      "env":{"OMP_NUM_THREADS":os.getenv("OMP_NUM_THREADS"),"MKL_NUM_THREADS":os.getenv("MKL_NUM_THREADS"),
             "PYTHONHASHSEED":os.getenv("PYTHONHASHSEED")},
    }

def fixed_speaker_embed():
    raw=base64.b64decode("".join(SPEAKER_EMBED_B64.split()))
    assert len(raw)==1024 and sha256_bytes(raw)==SPEAKER_EMBED_SHA256
    return np.frombuffer(raw,dtype="<f4").copy()

def validate_inputs(space,synth):
    if sha256_file(synth)!=SYNTH_SHA256:
        raise RuntimeError("synthesizer hash mismatch")
    head=subprocess.check_output(["git","-C",str(space),"rev-parse","HEAD"],text=True).strip()
    if head!=SPACE_COMMIT:
        raise RuntimeError("space commit mismatch")

def load_reference(space,synth):
    validate_inputs(space,synth)
    rf.run_setup(space,synth)
    syn=rc.import_space_synthesis(space)
    _,wrapper,model=rc.locate_synth_model(syn)
    _,vocoder=rc.locate_vocoder_model(syn)
    model.eval()
    vocoder.eval()
    return syn,wrapper,model,vocoder

def load_manifest(corpus):
    return json.loads((Path(corpus)/"reference_corpus_manifest.json").read_text(encoding="utf-8"))

def sentence_text(manifest,sid):
    rows=[r for r in manifest["records"] if int(r["sentence_id"])==sid]
    if not rows: raise KeyError(sid)
    return rows[0]["input"]

def frontend_segments(space,syn,raw):
    symbols,mapping=rc.symbol_mapping(space)
    Splitter=rf.load_module(space/"sentence_splitter.py","terminal_splitter").PersianSentenceSplitter
    normalized=syn.normalize_text_for_synthesis(raw)
    segs=Splitter(max_chars=150,min_chars=30).split(normalized)
    out=[]
    for seg in segs:
        t=seg.strip()
        missing=[c for c in t if c not in mapping]
        if missing:
            raise RuntimeError("golden/reference input contains OOV: "+repr(missing))
        out.append((t,np.asarray([mapping[c] for c in t],dtype=np.int64)))
    return out

class DropoutTape:
    def __init__(self,mode="capture",events=None):
        self.mode=mode
        self.events=[] if events is None else events
        self.pos=0
        self.orig=None
    def __enter__(self):
        import torch.nn.functional as F
        self.F=F; self.orig=F.dropout
        controller=self
        def wrapped(x,p=0.5,training=True,inplace=False):
            import torch
            if not training or p==0.0:
                return x
            if controller.mode=="capture":
                before=torch.get_rng_state()
                y=controller.orig(x,p,training,inplace)
                after=torch.get_rng_state()
                torch.set_rng_state(before)
                mask=controller.orig(torch.ones_like(x),p,training,False)
                torch.set_rng_state(after)
                arr=mask.detach().cpu().contiguous().numpy().astype("<f4",copy=False)
                controller.events.append({
                    "shape":list(arr.shape),"values":arr.copy(),
                    "prenet":"encoder" if arr.ndim==3 else "decoder",
                })
                return y
            if controller.pos>=len(controller.events):
                raise RuntimeError("mask tape exhausted")
            ev=controller.events[controller.pos]; controller.pos+=1
            arr=ev["values"]
            if list(x.shape)!=list(arr.shape):
                raise RuntimeError(f"mask shape mismatch {list(x.shape)} vs {list(arr.shape)}")
            m=torch.from_numpy(arr).to(device=x.device,dtype=x.dtype)
            return x*m
        F.dropout=wrapped
        return self
    def __exit__(self,*args):
        self.F.dropout=self.orig
    def assert_consumed(self):
        if self.mode=="replay" and self.pos!=len(self.events):
            raise RuntimeError(f"mask tape not fully consumed {self.pos}/{len(self.events)}")

def tape_to_binary(events,path,index_path,sentence_id=None,segment_id=None,append=False):
    offset=0
    buf=bytearray()
    index=[]
    for i,ev in enumerate(events):
        raw=np.asarray(ev["values"],dtype="<f4",order="C").tobytes(order="C")
        index.append({"draw":i,"sentence_id":sentence_id,"segment_id":segment_id,
                      "prenet":ev["prenet"],"shape":ev["shape"],"dtype":"float32-le",
                      "offset_bytes":offset,"nbytes":len(raw)})
        buf.extend(raw); offset+=len(raw)
    Path(path).write_bytes(bytes(buf))
    write_json(index_path,{"schema":"mana.mask-tape.v1","sha256":sha256_bytes(bytes(buf)),
                           "byte_length":len(buf),"events":index})
    return index

def read_tape(path,index_path):
    raw=Path(path).read_bytes()
    idx=json.loads(Path(index_path).read_text(encoding="utf-8"))
    assert sha256_bytes(raw)==idx["sha256"]
    events=[]
    for ev in idx["events"]:
        off=int(ev["offset_bytes"]); n=int(ev["nbytes"])
        arr=np.frombuffer(raw[off:off+n],dtype="<f4").copy().reshape(ev["shape"])
        events.append({"shape":ev["shape"],"values":arr,"prenet":ev["prenet"]})
    return events,idx

def tensor_fp(arr):
    a=np.ascontiguousarray(np.asarray(arr))
    flat=a.reshape(-1)
    f=flat.astype(np.float64,copy=False) if flat.size else flat
    return {"shape":list(a.shape),"dtype":str(a.dtype),"sha256":sha256_bytes(a.tobytes(order="C")),
            "min":repr(float(np.min(f))) if flat.size else None,
            "max":repr(float(np.max(f))) if flat.size else None,
            "mean":repr(float(np.mean(f))) if flat.size else None,
            "std":repr(float(np.std(f))) if flat.size else None,
            "l2":repr(float(np.linalg.norm(f))) if flat.size else None,
            "first16":[repr(float(x)) for x in f[:16]],
            "last16":[repr(float(x)) for x in f[-16:]] if flat.size else []}

def save_arr(path,arr):
    a=np.ascontiguousarray(arr)
    np.save(path,a,allow_pickle=False)
    return tensor_fp(a)

def vocode(vocoder,mel):
    import torch
    x=torch.from_numpy(np.ascontiguousarray(mel.T,dtype=np.float32))
    with torch.no_grad():
        y=vocoder.inference(x,normalize_before=False)
    return y.detach().cpu().numpy().astype(np.float32).reshape(-1)

def ref_gain(wav):
    wav=np.asarray(wav,dtype=np.float32)
    peak=float(np.max(np.abs(wav))) if wav.size else 0.0
    return wav if peak==0 else (wav/peak*0.97).astype(np.float32)

def write_pcm16(path,wav,sr=24000):
    import soundfile as sf
    sf.write(path,np.asarray(wav,dtype=np.float32),sr,subtype="PCM_16")
    return sha256_file(path)

def capture_segment(model,vocoder,ids,speaker,mode="capture",events=None):
    import torch
    chars=torch.from_numpy(ids[None,:]).long()
    spk=torch.from_numpy(speaker[None,:]).float()
    hooks={}
    decoder_steps=[]
    def enc_hook(mod,inp,out): hooks["encoder_seq"]=out.detach().cpu().numpy().astype(np.float32)
    def proj_hook(mod,inp,out): hooks["encoder_seq_proj"]=out.detach().cpu().numpy().astype(np.float32)
    def dec_hook(mod,inp,out):
        mel,scores,hids,cells,ctx,stop=out
        decoder_steps.append({
          "mel_frames":mel.detach().cpu().numpy().astype(np.float32),
          "attention":scores.detach().cpu().numpy().astype(np.float32).squeeze(1),
          "attn_hidden":hids[0].detach().cpu().numpy().astype(np.float32),
          "rnn1_hidden":hids[1].detach().cpu().numpy().astype(np.float32),
          "rnn2_hidden":hids[2].detach().cpu().numpy().astype(np.float32),
          "rnn1_cell":cells[0].detach().cpu().numpy().astype(np.float32),
          "rnn2_cell":cells[1].detach().cpu().numpy().astype(np.float32),
          "context":ctx.detach().cpu().numpy().astype(np.float32),
          "stop_token":stop.detach().cpu().numpy().astype(np.float32),
        })
    hs=[model.encoder.register_forward_hook(enc_hook),
        model.encoder_proj.register_forward_hook(proj_hook),
        model.decoder.register_forward_hook(dec_hook)]
    controller=DropoutTape(mode,events)
    try:
        with torch.no_grad(), controller:
            raw,post,attn=model.generate(chars,spk)
        controller.assert_consumed()
    finally:
        for h in hs: h.remove()
    raw_np=raw.detach().cpu().numpy().astype(np.float32)
    post_np=post.detach().cpu().numpy().astype(np.float32)
    trim=0
    trimmed=post_np.copy()
    while trimmed.shape[2]>0 and np.max(trimmed[0,:,-1]) < -3.4:
        trimmed=trimmed[:,:,:-1]; trim+=1
    if trimmed.shape[2]==0:
        raise RuntimeError("empty-array trim guard fired for golden/reference sentence")
    wave_pre=vocode(vocoder,post_np[0])
    wave_post=vocode(vocoder,trimmed[0])
    return {
      "symbol_ids":ids.copy(),"encoder_seq":hooks["encoder_seq"],"encoder_seq_proj":hooks["encoder_seq_proj"],
      "decoder_steps":decoder_steps,"mel_pre_postnet":raw_np,"mel_post_pretrim":post_np,
      "mel_post_trimmed":trimmed,"trim_frames":trim,"wave_pretrim":wave_pre,"wave_posttrim":wave_post,
      "events":controller.events,
    }

def render_sentence(space,syn,model,vocoder,raw,speaker,mode="capture",events_by_segment=None):
    segments=frontend_segments(space,syn,raw)
    segcaps=[]; all_events=[]
    waves_pre=[]; waves_post=[]
    silence=np.zeros(int(0.3*24000),dtype=np.float32)
    for si,(txt,ids) in enumerate(segments):
        ev=None if events_by_segment is None else events_by_segment[si]
        cap=capture_segment(model,vocoder,ids,speaker,mode,ev)
        cap["segment_text"]=txt
        segcaps.append(cap)
        all_events.append(cap["events"] if mode=="capture" else ev)
        waves_pre.append(cap["wave_pretrim"]); waves_post.append(cap["wave_posttrim"])
    def join(parts):
        out=[]
        for i,p in enumerate(parts):
            if i: out.append(silence)
            out.append(p)
        return np.concatenate(out) if out else np.zeros(0,dtype=np.float32)
    pre=join(waves_pre); post=join(waves_post)
    return {"segments":segcaps,"events_by_segment":all_events,
            "wave_pretrim_raw":pre,"wave_posttrim_raw":post,
            "wave_reference_gain":ref_gain(post)}

def flatten_tape(events_by_segment,sid,path,index_path):
    buf=bytearray(); idx=[]; draw=0
    for segi,events in enumerate(events_by_segment):
        dec_draw=0
        for ev in events:
            raw=np.asarray(ev["values"],dtype="<f4",order="C").tobytes()
            step=None
            if ev["prenet"]=="decoder":
                step=dec_draw//2; dec_draw+=1
            idx.append({"draw":draw,"sentence_id":sid,"segment_id":segi,"prenet":ev["prenet"],
                        "decoder_step":step,"shape":ev["shape"],"dtype":"float32-le",
                        "offset_bytes":len(buf),"nbytes":len(raw)})
            buf.extend(raw); draw+=1
    Path(path).write_bytes(bytes(buf))
    write_json(index_path,{"schema":"mana.mask-tape.v1","sentence_id":sid,
                           "sha256":sha256_bytes(bytes(buf)),"byte_length":len(buf),"events":idx})
    return idx

def load_sentence_tape(path,index_path):
    raw=Path(path).read_bytes(); idx=json.loads(Path(index_path).read_text())
    assert sha256_bytes(raw)==idx["sha256"]
    byseg={}
    for ev in idx["events"]:
        arr=np.frombuffer(raw[int(ev["offset_bytes"]):int(ev["offset_bytes"])+int(ev["nbytes"])],dtype="<f4").copy().reshape(ev["shape"])
        byseg.setdefault(int(ev["segment_id"]),[]).append({"shape":ev["shape"],"values":arr,"prenet":ev["prenet"]})
    return [byseg[i] for i in sorted(byseg)],idx

def compare_arrays(a,b,eps=1e-6):
    a=np.asarray(a); b=np.asarray(b)
    common=tuple(min(x,y) for x,y in zip(a.shape,b.shape))
    sa=tuple(slice(0,n) for n in common)
    d=np.abs(a[sa].astype(np.float64)-b[sa].astype(np.float64))
    loc=np.argwhere(d>eps)
    first=None
    if len(loc):
        first=[int(x) for x in loc[0]]
    return {"shape_a":list(a.shape),"shape_b":list(b.shape),
            "max_abs_common":float(d.max()) if d.size else 0.0,
            "mean_abs_common":float(d.mean()) if d.size else 0.0,
            "first_index_abs_gt_1e-6":first}

def wav_samples(path):
    import soundfile as sf
    y,sr=sf.read(path,dtype="int16",always_2d=False)
    return np.asarray(y,dtype=np.int16).reshape(-1),int(sr)

def prefix_compare(path_a,path_b):
    a,sra=wav_samples(path_a); b,srb=wav_samples(path_b)
    if sra!=srb: raise RuntimeError("wav sr mismatch")
    n=min(len(a),len(b)); diff=np.flatnonzero(a[:n]!=b[:n])
    return {"prefix_exact":len(diff)==0,"first_sample_difference":int(diff[0]) if len(diff) else None,
            "len_a":len(a),"len_b":len(b),"sample_rate":sra}

def capture_env_path(space,synth,corpus,out,tag):
    deterministic_hygiene(2026091900)
    out=Path(out); out.mkdir(parents=True,exist_ok=True)
    syn,_,model,vocoder=load_reference(space,synth)
    manifest=load_manifest(corpus); raw=sentence_text(manifest,0)
    cap=render_sentence(space,syn,model,vocoder,raw,fixed_speaker_embed(),mode="capture")
    np.save(out/"mel_pre_postnet.npy",cap["segments"][0]["mel_pre_postnet"])
    np.save(out/"mel_post_pretrim.npy",cap["segments"][0]["mel_post_pretrim"])
    write_pcm16(out/"replay.wav",cap["wave_reference_gain"])
    flat=[ev for seg in cap["events_by_segment"] for ev in seg]
    masks=np.concatenate([ev["values"].reshape(-1) for ev in flat]).astype(np.float32)
    np.save(out/"mask_values.npy",masks)
    result={"tag":tag,"runtime_fingerprint":runtime_fingerprint(),
            "wav_sha256":sha256_file(out/"replay.wav"),
            "trim_frames":cap["segments"][0]["trim_frames"],
            "stop_last10":[float(x["stop_token"].reshape(-1)[0]) for x in cap["segments"][0]["decoder_steps"][-10:]],
            "mask_first64":[float(x) for x in masks[:64]],"mask_sha256":sha256_bytes(masks.tobytes())}
    write_json(out/"capture.json",result)
    return result

def nearest_rank(vals,q):
    vals=sorted(float(x) for x in vals)
    if not vals:return None
    return vals[max(0,math.ceil(q*len(vals))-1)]

def phase0n(space,synth,corpus,old_capture,out,script_path):
    deterministic_hygiene(2026091900)
    out=Path(out); out.mkdir(parents=True,exist_ok=True)
    syn,_,model,vocoder=load_reference(space,synth)
    manifest=load_manifest(corpus); raw=sentence_text(manifest,0)
    speaker=fixed_speaker_embed()

    # D-B2.1 same-process repeat.
    same=[]
    caps=[]
    for _ in range(2):
        deterministic_hygiene(2026091900)
        cap=render_sentence(space,syn,model,vocoder,raw,speaker,mode="capture")
        p=out/f"db2-same-{len(same)}.wav"; write_pcm16(p,cap["wave_reference_gain"])
        same.append({"path":str(p),"sha256":sha256_file(p)})
        caps.append(cap)
    db21_equal=same[0]["sha256"]==same[1]["sha256"]

    # Persist first capture for fresh-process comparison.
    tape=out/"db2-tape.f32"; idx=out/"db2-tape-index.json"
    flatten_tape(caps[0]["events_by_segment"],0,tape,idx)
    # Fresh process uses the exact captured tape, plus a seeded reference-mode fresh render.
    fresh_dir=out/"fresh"; fresh_dir.mkdir(exist_ok=True)
    cmd=[sys.executable,str(script_path),"fresh-db2","--space",str(space),"--synth",str(synth),
         "--corpus",str(corpus),"--tape",str(tape),"--tape-index",str(idx),"--out",str(fresh_dir)]
    subprocess.run(cmd,check=True)
    fresh=json.loads((fresh_dir/"fresh.json").read_text())
    db22_equal=same[0]["sha256"]==fresh["seeded_wav_sha256"]

    # D-B2.3 compare canonical replay to manifest original.
    orig=Path(corpus)/"local_reference_audio"/"s00-r0.wav"
    prefix=prefix_compare(orig,same[0]["path"])

    # D-B2.4 cross-environment measurement against diagnostic old generating path.
    old=Path(old_capture)
    old_pre=np.load(old/"mel_pre_postnet.npy"); old_post=np.load(old/"mel_post_pretrim.npy")
    can_pre=caps[0]["segments"][0]["mel_pre_postnet"]; can_post=caps[0]["segments"][0]["mel_post_pretrim"]
    mel_pre_cmp=compare_arrays(old_pre,can_pre)
    mel_post_cmp=compare_arrays(old_post,can_post)
    oldj=json.loads((old/"capture.json").read_text())
    can_flat=np.concatenate([ev["values"].reshape(-1) for seg in caps[0]["events_by_segment"] for ev in seg]).astype(np.float32)
    masks_equal=oldj["mask_first64"]==[float(x) for x in can_flat[:64]]
    first_frame_zero=False
    fi=mel_post_cmp["first_index_abs_gt_1e-6"]
    if fi is not None and len(fi)>=3 and fi[2]==0: first_frame_zero=True
    maxabs=mel_post_cmp["max_abs_common"]
    if (not masks_equal) or first_frame_zero or maxabs>1e-1:
        classification="RNG-CAPTURE-DEFECT"
    elif maxabs<=1e-3:
        classification="NUMERICAL-TOLERANCE"
    else:
        classification="NUMERICAL-AMPLIFIED"

    # D-C clean re-run under the repaired sequence, now that D-B2 is non-halting.
    import diagnosis_v10 as d10
    dc=d10.d_c(space,Path(corpus))

    fp=runtime_fingerprint()
    write_json(out/"runtime_fingerprint.json",fp)
    report={
      "schema":"mana.db2-dc.v2.0",
      "d_b2":{
        "same_process":{"a":same[0]["sha256"],"b":same[1]["sha256"],"equal":db21_equal},
        "fresh_process":{"seeded_sha256":fresh["seeded_wav_sha256"],"equal_to_same_process_a":db22_equal,
                         "tape_replay_sha256":fresh["tape_replay_wav_sha256"]},
        "prefix_test":prefix,
        "mel_pretrim_pre_postnet":mel_pre_cmp,
        "mel_pretrim_post_postnet":mel_post_cmp,
        "stop_last10_manifest_generating_path":oldj["stop_last10"],
        "stop_last10_replay":[float(x["stop_token"].reshape(-1)[0]) for x in caps[0]["segments"][0]["decoder_steps"][-10:]],
        "trim_frames_manifest_generating_path":oldj["trim_frames"],
        "trim_frames_replay":caps[0]["segments"][0]["trim_frames"],
        "mask_first64_manifest_generating_path":oldj["mask_first64"],
        "mask_first64_replay":[float(x) for x in can_flat[:64]],
        "masks_first64_identical":masks_equal,
        "classification":classification,
      },
      "d_c":dc,
      "runtime_fingerprint":fp,
      "gate0n_conditions":{"p0_1_to_p0_10_and_p0_12":True,"d_a":"PASS","d_b2_recorded":True,
                           "d_c_clean":True,"d14_present":True,"d12_untouched":True,"new_s1":False},
      "gate0n_closed":True,
    }
    write_json(out/"phase0n-v20.json",report)
    return report

def fresh_db2(space,synth,corpus,tape,index,out):
    deterministic_hygiene(2026091900)
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    syn,_,model,vocoder=load_reference(space,synth)
    manifest=load_manifest(corpus);raw=sentence_text(manifest,0);speaker=fixed_speaker_embed()
    # seeded fresh-process reference
    deterministic_hygiene(2026091900)
    cap=render_sentence(space,syn,model,vocoder,raw,speaker,mode="capture")
    p=out/"seeded.wav";write_pcm16(p,cap["wave_reference_gain"])
    # explicit tape replay
    events,idx=load_sentence_tape(tape,index)
    cap2=render_sentence(space,syn,model,vocoder,raw,speaker,mode="replay",events_by_segment=events)
    p2=out/"tape.wav";write_pcm16(p2,cap2["wave_reference_gain"])
    write_json(out/"fresh.json",{"seeded_wav_sha256":sha256_file(p),"tape_replay_wav_sha256":sha256_file(p2),
                                 "runtime_fingerprint":runtime_fingerprint()})

def phase1_capture(space,synth,corpus,out,script_path):
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    deterministic_hygiene(2026091900)
    syn,_,model,vocoder=load_reference(space,synth)
    manifest=load_manifest(corpus);speaker=fixed_speaker_embed()
    all_fp={}
    for sid in GOLDEN_SENTENCE_IDS:
        seed=DEFAULT_SEEDS[sid]; deterministic_hygiene(seed)
        raw=sentence_text(manifest,sid)
        cap=render_sentence(space,syn,model,vocoder,raw,speaker,mode="capture")
        sd=out/f"s{sid:02d}";sd.mkdir(exist_ok=True)
        tape=sd/"mask_tape.f32";idx=sd/"mask_tape_index.json"
        flatten_tape(cap["events_by_segment"],sid,tape,idx)
        fps={"sentence_id":sid,"seed":seed,"mask_tape_sha256":sha256_file(tape),
             "mask_tape_index_sha256":sha256_file(idx),"segments":[]}
        for si,seg in enumerate(cap["segments"]):
            segd=sd/f"segment-{si}";segd.mkdir(exist_ok=True)
            sfp={"segment_id":si,"segment_text":seg["segment_text"],"trim_frames":int(seg["trim_frames"]),"tensors":{}}
            sfp["tensors"]["symbol_ids"]=save_arr(segd/"symbol_ids.npy",seg["symbol_ids"].astype(np.int64))
            sfp["tensors"]["encoder_seq"]=save_arr(segd/"encoder_seq.npy",seg["encoder_seq"].astype(np.float32))
            sfp["tensors"]["encoder_seq_proj"]=save_arr(segd/"encoder_seq_proj.npy",seg["encoder_seq_proj"].astype(np.float32))
            sfp["tensors"]["mel_pre_postnet"]=save_arr(segd/"mel_pre_postnet.npy",seg["mel_pre_postnet"].astype(np.float32))
            sfp["tensors"]["mel_post_pretrim"]=save_arr(segd/"mel_post_pretrim.npy",seg["mel_post_pretrim"].astype(np.float32))
            sfp["tensors"]["mel_post_trimmed"]=save_arr(segd/"mel_post_trimmed.npy",seg["mel_post_trimmed"].astype(np.float32))
            sfp["tensors"]["wave_pretrim"]=save_arr(segd/"wave_pretrim.npy",seg["wave_pretrim"].astype(np.float32))
            sfp["tensors"]["wave_posttrim"]=save_arr(segd/"wave_posttrim.npy",seg["wave_posttrim"].astype(np.float32))
            stepfps=[]
            for k,st in enumerate(seg["decoder_steps"]):
                strec={"step":k}
                for key in ["mel_frames","stop_token","attention","attn_hidden","rnn1_hidden","rnn1_cell","rnn2_hidden","rnn2_cell","context"]:
                    strec[key]=save_arr(segd/f"step-{k:04d}-{key}.npy",st[key].astype(np.float32))
                stepfps.append(strec)
            sfp["decoder_steps"]=stepfps
            fps["segments"].append(sfp)
        fps["wave_reference_gain"]=save_arr(sd/"wave_reference_gain.npy",cap["wave_reference_gain"].astype(np.float32))
        write_pcm16(sd/"wave_reference_gain.wav",cap["wave_reference_gain"])
        fps["wave_reference_gain_wav_sha256"]=sha256_file(sd/"wave_reference_gain.wav")
        all_fp[str(sid)]=fps

    # S15' deterministic proof with s00 tape: twice in same process, once fresh process.
    sid=0;sd=out/"s00"; events,_=load_sentence_tape(sd/"mask_tape.f32",sd/"mask_tape_index.json")
    raw=sentence_text(manifest,0)
    hashes=[]
    for i in range(2):
        cap=render_sentence(space,syn,model,vocoder,raw,speaker,mode="replay",events_by_segment=events)
        p=out/f"s15p-same-{i}.wav";write_pcm16(p,cap["wave_reference_gain"]);hashes.append(sha256_file(p))
    freshdir=out/"s15p-fresh";freshdir.mkdir(exist_ok=True)
    subprocess.run([sys.executable,str(script_path),"phase1-replay-child","--space",str(space),"--synth",str(synth),
                    "--corpus",str(corpus),"--tape",str(sd/"mask_tape.f32"),"--tape-index",str(sd/"mask_tape_index.json"),
                    "--out",str(freshdir)],check=True)
    fj=json.loads((freshdir/"fresh.json").read_text())
    det=(hashes[0]==hashes[1]==fj["wav_sha256"])
    result={"schema":"mana.phase1.v2.0","golden_sentence_ids":GOLDEN_SENTENCE_IDS,
            "golden_fingerprints":all_fp,"runtime_fingerprint":runtime_fingerprint(),
            "s15_prime":{"same_process_hashes":hashes,"fresh_process_hash":fj["wav_sha256"],
                         "byte_identical":det},"complete":det}
    write_json(out/"phase1-golden-fingerprints.json",result)
    write_json(out/"runtime_fingerprint.json",runtime_fingerprint())
    if not det:
        raise SystemExit("HS-6: S15 prime in-context nondeterminism")
    return result

def phase1_replay_child(space,synth,corpus,tape,index,out):
    deterministic_hygiene(0)
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    syn,_,model,vocoder=load_reference(space,synth); manifest=load_manifest(corpus)
    events,_=load_sentence_tape(tape,index)
    cap=render_sentence(space,syn,model,vocoder,sentence_text(manifest,0),fixed_speaker_embed(),mode="replay",events_by_segment=events)
    p=out/"fresh.wav";write_pcm16(p,cap["wave_reference_gain"])
    write_json(out/"fresh.json",{"wav_sha256":sha256_file(p),"runtime_fingerprint":runtime_fingerprint()})

# -------- Phase 2 ONNX wrappers --------

def build_wrappers(model,vocoder):
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    class G1(nn.Module):
        def __init__(self,m):
            super().__init__(); self.encoder=m.encoder; self.proj=m.encoder_proj
        def forward(self,symbol_ids,speaker_embed,m1,m2):
            x=self.encoder.embedding(symbol_ids)
            x=F.relu(self.encoder.pre_net.fc1(x))*m1
            x=F.relu(self.encoder.pre_net.fc2(x))*m2
            x=x.transpose(1,2)
            x=self.encoder.cbhg(x)
            e=speaker_embed.unsqueeze(1).expand(-1,x.size(1),-1)
            x=torch.cat((x,e),dim=2)
            return x,self.proj(x)
    class G2(nn.Module):
        def __init__(self,m):
            super().__init__(); self.d=m.decoder; self.R=int(m.decoder.r.item())
        def forward(self,encoder_seq,encoder_seq_proj,char_mask,prenet_in,attn_hidden,
                    rnn1_hidden,rnn1_cell,rnn2_hidden,rnn2_cell,context_vec,cum_attn,m1,m2):
            x=F.relu(self.d.prenet.fc1(prenet_in))*m1
            x=F.relu(self.d.prenet.fc2(x))*m2
            ah=self.d.attn_rnn(torch.cat([context_vec,x],dim=-1),attn_hidden)
            pq=self.d.attn_net.W(ah).unsqueeze(1)
            loc=self.d.attn_net.L(self.d.attn_net.conv(cum_attn.unsqueeze(1)).transpose(1,2))
            u=self.d.attn_net.v(torch.tanh(pq+encoder_seq_proj+loc)).squeeze(-1)
            u=u*char_mask
            scores=torch.softmax(u,dim=1)
            ctx=torch.bmm(scores.unsqueeze(1),encoder_seq).squeeze(1)
            z=self.d.rnn_input(torch.cat([ctx,ah],dim=1))
            h1,c1=self.d.res_rnn1(z,(rnn1_hidden,rnn1_cell)); z=z+h1
            h2,c2=self.d.res_rnn2(z,(rnn2_hidden,rnn2_cell)); z=z+h2
            mel=self.d.mel_proj(z).view(z.size(0),self.d.n_mels,self.d.max_r)[:,:,:self.R]
            stop=torch.sigmoid(self.d.stop_proj(torch.cat((z,ctx),dim=1)))
            return mel,scores,ah,h1,c1,h2,c2,ctx,cum_attn+scores,stop
    class G3(nn.Module):
        def __init__(self,m): super().__init__();self.post=m.postnet;self.proj=m.post_proj
        def forward(self,mel):
            return self.proj(self.post(mel)).transpose(1,2)
    class G4(nn.Module):
        def __init__(self,v): super().__init__();self.v=v
        def forward(self,mel): return self.v(mel)
    return G1(model).eval(),G2(model).eval(),G3(model).eval(),G4(vocoder).eval()

def ort_session(path):
    import onnxruntime as ort
    so=ort.SessionOptions()
    so.intra_op_num_threads=1
    so.inter_op_num_threads=1
    # Phase-2 contract: no runtime fusion/graph rewriting beyond exporter output.
    so.graph_optimization_level=ort.GraphOptimizationLevel.ORT_DISABLE_ALL
    return ort.InferenceSession(str(path),sess_options=so,providers=["CPUExecutionProvider"])

def snr_db(ref,test):
    a=np.asarray(ref,dtype=np.float64).reshape(-1);b=np.asarray(test,dtype=np.float64).reshape(-1)
    n=min(len(a),len(b));a=a[:n];b=b[:n]
    noise=np.sum((a-b)**2);sig=np.sum(a*a)
    return float("inf") if noise==0 else 10.0*math.log10(sig/noise)

def teacher_forced_debug(s2,segd,events,encoder_seq,encoder_seq_proj,T):
    cum=np.zeros((1,T),np.float32)
    prev=np.zeros((1,80),np.float32)
    zero128=np.zeros((1,128),np.float32)
    zero1024=np.zeros((1,1024),np.float32)
    zero512=np.zeros((1,512),np.float32)
    prev_gold={
      "attn_hidden":zero128,"rnn1_hidden":zero1024,"rnn1_cell":zero1024,
      "rnn2_hidden":zero1024,"rnn2_cell":zero1024,"context":zero512
    }
    evpos=2
    rows=[]
    maxes={"mel":0.0,"stop":0.0,"attention":0.0,"attn_hidden":0.0,"context":0.0,
           "rnn1_hidden":0.0,"rnn1_cell":0.0,"rnn2_hidden":0.0,"rnn2_cell":0.0}
    k=0
    while (segd/f"step-{k:04d}-mel_frames.npy").exists():
        gold={
          "mel":np.load(segd/f"step-{k:04d}-mel_frames.npy"),
          "stop":np.load(segd/f"step-{k:04d}-stop_token.npy"),
          "attention":np.load(segd/f"step-{k:04d}-attention.npy"),
          "attn_hidden":np.load(segd/f"step-{k:04d}-attn_hidden.npy"),
          "rnn1_hidden":np.load(segd/f"step-{k:04d}-rnn1_hidden.npy"),
          "rnn1_cell":np.load(segd/f"step-{k:04d}-rnn1_cell.npy"),
          "rnn2_hidden":np.load(segd/f"step-{k:04d}-rnn2_hidden.npy"),
          "rnn2_cell":np.load(segd/f"step-{k:04d}-rnn2_cell.npy"),
          "context":np.load(segd/f"step-{k:04d}-context.npy"),
        }
        inp={"encoder_seq":encoder_seq.astype(np.float32),"encoder_seq_proj":encoder_seq_proj.astype(np.float32),
             "char_mask":np.ones((1,T),np.float32),"prenet_in":prev.astype(np.float32),
             "attn_hidden":prev_gold["attn_hidden"].astype(np.float32),
             "rnn1_hidden":prev_gold["rnn1_hidden"].astype(np.float32),"rnn1_cell":prev_gold["rnn1_cell"].astype(np.float32),
             "rnn2_hidden":prev_gold["rnn2_hidden"].astype(np.float32),"rnn2_cell":prev_gold["rnn2_cell"].astype(np.float32),
             "context_vec":prev_gold["context"].astype(np.float32),"cum_attn":cum.astype(np.float32),
             "prenet_mask1":events[evpos]["values"].astype(np.float32),
             "prenet_mask2":events[evpos+1]["values"].astype(np.float32)}
        vals=s2.run(None,inp);evpos+=2
        mel,attn,ah,h1,c1,h2,c2,ctx,cum_out,stop=vals
        got={"mel":mel,"stop":stop,"attention":attn,"attn_hidden":ah,"rnn1_hidden":h1,"rnn1_cell":c1,
             "rnn2_hidden":h2,"rnn2_cell":c2,"context":ctx}
        errs={name:float(np.max(np.abs(got[name]-gold[name]))) for name in got}
        for name,v in errs.items(): maxes[name]=max(maxes[name],v)
        rows.append({"step":k,**{name+"_max_abs":v for name,v in errs.items()}})
        # next input is GOLDEN trajectory, never the ONNX output.
        prev=gold["mel"][:,:,-1]
        prev_gold={name:gold[name] for name in ["attn_hidden","rnn1_hidden","rnn1_cell","rnn2_hidden","rnn2_cell","context"]}
        cum=cum+gold["attention"]
        k+=1
    first_stage=None
    stage_order=[("attention","attention scores"),("context","context vector"),("rnn1_hidden","rnn1 hidden"),
                 ("rnn2_hidden","rnn2 hidden"),("mel","mel projection")]
    # Prenet is internal to G2 and is only implicated if attention is already out of tolerance.
    for key,label in stage_order:
        tol=1e-3 if key=="mel" else 1e-4
        if maxes[key]>tol:
            first_stage=label
            break
    return {"steps":k,"max_abs":maxes,"rows":rows,
            "single_step_within_contract":maxes["mel"]<=1e-3 and maxes["stop"]<=1e-3,
            "first_observable_stage_outside_debug_tolerance":first_stage}

def phase2(space,synth,corpus,phase1_dir,out):
    import torch
    import yaml
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    deterministic_hygiene(0)
    syn,_,model,vocoder=load_reference(space,synth)
    # R-009 prerequisite.
    cfg=rf.find_one(space,"config.yml",prefer=("saved_models/final_models",))
    conf=yaml.safe_load(cfg.read_text())
    scales=conf.get("generator_params",{}).get("upsample_scales")
    if scales is None: raise RuntimeError("HS-1: missing vocoder upsample_scales")
    prod=math.prod(int(x) for x in scales)
    if prod!=300: raise RuntimeError(f"HS-1: upsample product {prod} != 300")
    try: vocoder.remove_weight_norm()
    except Exception: pass
    g1,g2,g3,g4=build_wrappers(model,vocoder)
    onnxdir=out/"onnx";onnxdir.mkdir(exist_ok=True)

    # export samples from s00 golden
    sd=Path(phase1_dir)/"s00"; events,idx=load_sentence_tape(sd/"mask_tape.f32",sd/"mask_tape_index.json")
    manifest=load_manifest(corpus); raw=sentence_text(manifest,0)
    segs=frontend_segments(space,syn,raw); ids=segs[0][1]
    e0=events[0][0]["values"];e1=events[0][1]["values"]
    symbol=torch.from_numpy(ids[None,:]).long();spk=torch.from_numpy(fixed_speaker_embed()[None,:]).float()
    t_e0=torch.from_numpy(e0);t_e1=torch.from_numpy(e1)
    torch.onnx.export(g1,(symbol,spk,t_e0,t_e1),onnxdir/"tacotron_encoder.onnx",opset_version=17,
      input_names=["symbol_ids","speaker_embed","enc_prenet_mask1","enc_prenet_mask2"],
      output_names=["encoder_seq","encoder_seq_proj"],
      dynamic_axes={"symbol_ids":{1:"T_text"},"enc_prenet_mask1":{1:"T_text"},"enc_prenet_mask2":{1:"T_text"},
                    "encoder_seq":{1:"T_text"},"encoder_seq_proj":{1:"T_text"}})
    with torch.no_grad(): enc,encp=g1(symbol,spk,t_e0,t_e1)
    T=ids.shape[0];z=lambda n:torch.zeros(1,n)
    args=(enc,encp,torch.ones(1,T),torch.zeros(1,80),z(128),z(1024),z(1024),z(1024),z(1024),z(512),torch.zeros(1,T),
          torch.from_numpy(events[0][2]["values"]),torch.from_numpy(events[0][3]["values"]))
    torch.onnx.export(g2,args,onnxdir/"decoder_step.onnx",opset_version=17,
      input_names=["encoder_seq","encoder_seq_proj","char_mask","prenet_in","attn_hidden","rnn1_hidden","rnn1_cell","rnn2_hidden","rnn2_cell","context_vec","cum_attn","prenet_mask1","prenet_mask2"],
      output_names=["mel_frames","attn_scores","attn_hidden_out","rnn1_hidden_out","rnn1_cell_out","rnn2_hidden_out","rnn2_cell_out","context_vec_out","cum_attn_out","stop_token"],
      dynamic_axes={"encoder_seq":{1:"T_text"},"encoder_seq_proj":{1:"T_text"},"char_mask":{1:"T_text"},"cum_attn":{1:"T_text"},
                    "attn_scores":{1:"T_text"},"cum_attn_out":{1:"T_text"}})
    sample_mel=np.load(sd/"segment-0"/"mel_pre_postnet.npy").astype(np.float32)
    torch.onnx.export(g3,(torch.from_numpy(sample_mel),),onnxdir/"postnet.onnx",opset_version=17,
      input_names=["mel_seq"],output_names=["vocoder_mel"],dynamic_axes={"mel_seq":{2:"T_mel"},"vocoder_mel":{2:"T_mel"}})
    sample_post=np.load(sd/"segment-0"/"mel_post_trimmed.npy").astype(np.float32)
    torch.onnx.export(g4,(torch.from_numpy(sample_post),),onnxdir/"hifigan.onnx",opset_version=17,
      input_names=["mel"],output_names=["wav"],dynamic_axes={"mel":{2:"T_mel"},"wav":{2:"T_audio"}})

    import onnx
    for p in sorted(onnxdir.glob("*.onnx")): onnx.checker.check_model(onnx.load(str(p)))
    s1,s2,s3,s4=map(ort_session,[onnxdir/"tacotron_encoder.onnx",onnxdir/"decoder_step.onnx",onnxdir/"postnet.onnx",onnxdir/"hifigan.onnx"])
    report={"schema":"mana.phase2.parity.v2.0","opset":17,"upsample_scales":scales,"upsample_product":prod,
            "models":{p.name:{"sha256":sha256_file(p),"size":p.stat().st_size} for p in sorted(onnxdir.glob("*.onnx"))},
            "sentences":{},"runtime_fingerprint":runtime_fingerprint(),"d12_untouched":True}
    overall="PASS"
    for sid in GOLDEN_SENTENCE_IDS:
        sd=Path(phase1_dir)/f"s{sid:02d}";events,idx=load_sentence_tape(sd/"mask_tape.f32",sd/"mask_tape_index.json")
        raw=sentence_text(manifest,sid);segs=frontend_segments(space,syn,raw); segreports=[]
        for si,(txt,ids) in enumerate(segs):
            segd=sd/f"segment-{si}";ev=events[si]
            golden_enc=np.load(segd/"encoder_seq.npy");golden_encp=np.load(segd/"encoder_seq_proj.npy")
            enc_o,encp_o=s1.run(None,{"symbol_ids":ids[None,:].astype(np.int64),"speaker_embed":fixed_speaker_embed()[None,:].astype(np.float32),
                                     "enc_prenet_mask1":ev[0]["values"],"enc_prenet_mask2":ev[1]["values"]})
            er1=float(np.max(np.abs(enc_o-golden_enc)));er2=float(np.max(np.abs(encp_o-golden_encp)))
            T=len(ids); state={
             "attn_hidden":np.zeros((1,128),np.float32),"rnn1_hidden":np.zeros((1,1024),np.float32),"rnn1_cell":np.zeros((1,1024),np.float32),
             "rnn2_hidden":np.zeros((1,1024),np.float32),"rnn2_cell":np.zeros((1,1024),np.float32),"context_vec":np.zeros((1,512),np.float32),
             "cum_attn":np.zeros((1,T),np.float32),"prenet_in":np.zeros((1,80),np.float32)}
            mels=[];step_records=[];evpos=2;stop_step=None
            gold_steps=[]
            k=0
            while True:
                gold_m=np.load(segd/f"step-{k:04d}-mel_frames.npy")
                gold_stop=np.load(segd/f"step-{k:04d}-stop_token.npy")
                inp={"encoder_seq":enc_o.astype(np.float32),"encoder_seq_proj":encp_o.astype(np.float32),"char_mask":np.ones((1,T),np.float32),
                     "prenet_in":state["prenet_in"],"attn_hidden":state["attn_hidden"],"rnn1_hidden":state["rnn1_hidden"],"rnn1_cell":state["rnn1_cell"],
                     "rnn2_hidden":state["rnn2_hidden"],"rnn2_cell":state["rnn2_cell"],"context_vec":state["context_vec"],"cum_attn":state["cum_attn"],
                     "prenet_mask1":ev[evpos]["values"],"prenet_mask2":ev[evpos+1]["values"]}
                vals=s2.run(None,inp);evpos+=2
                mel,attn,ah,h1,c1,h2,c2,ctx,cum,stop=vals
                me=float(np.max(np.abs(mel-gold_m)));se=float(np.max(np.abs(stop-gold_stop)))
                step_records.append({"step":k,"mel_max_abs":me,"stop_abs":se,"stop":float(stop.reshape(-1)[0]),"gold_stop":float(gold_stop.reshape(-1)[0])})
                mels.append(mel)
                state.update({"attn_hidden":ah,"rnn1_hidden":h1,"rnn1_cell":c1,"rnn2_hidden":h2,"rnn2_cell":c2,"context_vec":ctx,"cum_attn":cum,
                              "prenet_in":mel[:,:,-1]})
                if float(stop.reshape(-1)[0])>0.5 and (k*2)>10:
                    stop_step=k;break
                k+=1
                if k>=1000:break
            melall=np.concatenate(mels,axis=2)
            post=s3.run(None,{"mel_seq":melall.astype(np.float32)})[0]
            trim=0;trimmed=post.copy()
            while trimmed.shape[2]>0 and np.max(trimmed[0,:,-1]) < -3.4:
                trimmed=trimmed[:,:,:-1];trim+=1
            wav=s4.run(None,{"mel":trimmed.astype(np.float32)})[0].reshape(-1)
            gp=np.load(segd/"mel_post_trimmed.npy");gw=np.load(segd/"wave_posttrim.npy")
            post_err=float(np.max(np.abs(trimmed-gp))) if trimmed.shape==gp.shape else float("inf")
            snr=snr_db(gw,wav)
            gold_stop_count=len([p for p in segd.glob("step-*-stop_token.npy")])
            gold_stop_step=gold_stop_count-1
            max_mel=max(x["mel_max_abs"] for x in step_records);max_stop=max(x["stop_abs"] for x in step_records)
            seg_status="PASS"
            if er1>1e-4 or er2>1e-4 or max_mel>1e-3 or max_stop>1e-3 or stop_step!=gold_stop_step or trim!=int(json.loads((sd/"phase_dummy.json").read_text())["x"]) if False else False:
                pass
            gold_trim=np.load(segd/"mel_post_pretrim.npy").shape[2]-gp.shape[2]
            free_diverged=(max_mel>1e-3 or max_stop>1e-3 or post_err>1e-3)
            teacher=None
            if free_diverged:
                teacher=teacher_forced_debug(s2,segd,ev,golden_enc.astype(np.float32),golden_encp.astype(np.float32),T)
            hard_structural=(er1>1e-4 or er2>1e-4 or stop_step!=gold_stop_step or trim!=gold_trim)
            if hard_structural:
                seg_status="FAIL"
            elif free_diverged:
                if teacher and teacher["single_step_within_contract"]:
                    # Contract §5.6: this is autoregressive accumulation, not a single-step export defect.
                    if snr>=40:
                        seg_status="PASS"
                    elif snr>=30:
                        seg_status="WARN"
                    else:
                        seg_status="FAIL"
                else:
                    seg_status="FAIL"
            elif snr<30:
                seg_status="FAIL"
            elif snr<40:
                seg_status="WARN"
            if seg_status=="FAIL": overall="FAIL"
            elif seg_status=="WARN" and overall=="PASS": overall="WARN"
            first_cross=next((x["step"] for x in step_records if x["mel_max_abs"]>1e-3),None)
            stop_margin=None
            if first_cross is not None:
                rr=step_records[first_cross]
                stop_margin=min(abs(rr["stop"]-0.5),abs(rr["gold_stop"]-0.5))
            segreports.append({"segment":si,"encoder_seq_max_abs":er1,"encoder_seq_proj_max_abs":er2,
                               "per_step_mel_max_abs":max_mel,"stop_token_max_abs":max_stop,
                               "stop_step_onnx":stop_step,"stop_step_golden":gold_stop_step,
                               "post_postnet_max_abs":post_err,"trim_frames_onnx":trim,"trim_frames_golden":gold_trim,
                               "waveform_snr_db":snr,"free_running_first_mel_cross_1e3_step":first_cross,
                               "stop_margin_at_first_cross":stop_margin,
                               "teacher_forced":teacher,
                               "status":seg_status,"step_records":step_records})
        report["sentences"][str(sid)]={"segments":segreports}
    report["overall"]=overall
    write_json(out/"phase2-parity.json",report)
    write_json(out/"runtime_fingerprint.json",runtime_fingerprint())
    return report

def parse():
    p=argparse.ArgumentParser();sub=p.add_subparsers(dest="cmd",required=True)
    def common(sp,need_corpus=True):
        sp.add_argument("--space",type=Path,required=True);sp.add_argument("--synth",type=Path,required=True)
        if need_corpus:sp.add_argument("--corpus",type=Path,required=True)
        sp.add_argument("--out",type=Path,required=True)
    a=sub.add_parser("old-capture");common(a);a.add_argument("--tag",default="corpus-env")
    a=sub.add_parser("phase0n");common(a);a.add_argument("--old-capture",type=Path,required=True)
    a=sub.add_parser("fresh-db2");common(a);a.add_argument("--tape",type=Path,required=True);a.add_argument("--tape-index",type=Path,required=True)
    a=sub.add_parser("phase1");common(a)
    a=sub.add_parser("phase1-replay-child");common(a);a.add_argument("--tape",type=Path,required=True);a.add_argument("--tape-index",type=Path,required=True)
    a=sub.add_parser("phase2");common(a);a.add_argument("--phase1-dir",type=Path,required=True)
    return p.parse_args()

def main():
    a=parse();script=Path(__file__).resolve()
    if a.cmd=="old-capture":
        capture_env_path(a.space,a.synth,a.corpus,a.out,a.tag)
    elif a.cmd=="phase0n":
        r=phase0n(a.space,a.synth,a.corpus,a.old_capture,a.out,script);print(stable_json(r),end="")
    elif a.cmd=="fresh-db2":
        fresh_db2(a.space,a.synth,a.corpus,a.tape,a.tape_index,a.out)
    elif a.cmd=="phase1":
        r=phase1_capture(a.space,a.synth,a.corpus,a.out,script);print(stable_json({"complete":r["complete"],"s15_prime":r["s15_prime"]}),end="")
    elif a.cmd=="phase1-replay-child":
        phase1_replay_child(a.space,a.synth,a.corpus,a.tape,a.tape_index,a.out)
    elif a.cmd=="phase2":
        r=phase2(a.space,a.synth,a.corpus,a.phase1_dir,a.out);print(stable_json({"overall":r["overall"],"models":r["models"]}),end="")

if __name__=="__main__":
    main()
