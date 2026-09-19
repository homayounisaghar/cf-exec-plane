#!/usr/bin/env python3
import hashlib
import importlib
import importlib.util
import json
import math
import os
import shutil
import sys
import types
import zipfile
from itertools import combinations
from pathlib import Path

import numpy as np

import reference_forensics as rf

SENTENCES = [
    "سلام دنیا.",
    "امروز هوا خوب است.",
    "این یک جمله کوتاه برای آزمایش صدا است.",
    "عدد ۱۲۳ را بخوان.",
    "شماره من ۰۹۱۲۳۴۵۶۷۸۹ است.",
    "تماس بین المللی +۹۸۹۱۵۱۰۰۲۰۳۰ است.",
    "قیمت این کالا ۵,۴۰۰ تومان است.",
    "سال 2026 سال خوبی است.",
    "عدد منفی -5 را بخوان.",
    "می‌خواهم نیم‌فاصله درست خوانده شود.",
    "این یک پرسش است؟",
    "سلام، حال شما چطور است؟",
    "این متن کمی طولانی‌تر است تا آهنگ جمله و مکث میان بخش‌ها بررسی شود و رفتار مدل در جمله متوسط مشخص باشد.",
    "الف، ب، پ، ت، ث، ج، چ، ح، خ، د، ذ، ر، ز، ژ، س و ش.",
    "کد تایید ۸۸۹۹۱۱۰۰ است.",
    "شماره ثابت ۰۲۱-۸۸۸۰۳۳۵۴ را بخوان.",
    "ABC در کنار متن فارسی قرار دارد.",
    "واژهٔ آزمایشی با نشانه درصد 50٪.",
    "«این نقل قول گیومه دارد»",
    "این متن شامل نماد € است.",
]

def stable_json(obj):
    return json.dumps(obj,ensure_ascii=False,sort_keys=True,separators=(",",":"))+"\n"

def write_json(path,obj):
    Path(path).write_text(stable_json(obj),encoding="utf-8")

def sha256_file(path):
    return rf.sha256_file(path)

def install_spaces_stub():
    if "spaces" in sys.modules:
        return
    m=types.ModuleType("spaces")
    def GPU(fn=None,*args,**kwargs):
        if callable(fn):
            return fn
        def deco(f):
            return f
        return deco
    m.GPU=GPU
    sys.modules["spaces"]=m

def patch_scipy():
    import scipy.signal
    if not hasattr(scipy.signal,"kaiser"):
        scipy.signal.kaiser=scipy.signal.windows.kaiser

def import_space_synthesis(space):
    install_spaces_stub()
    patch_scipy()
    sys.path.insert(0,str(space))
    sys.path.insert(0,str(space/"pmt2"))
    spec=importlib.util.spec_from_file_location("locked_space_synthesis",space/"synthesis.py")
    mod=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    ok=mod.load_models()
    if ok is False:
        raise RuntimeError("locked Space load_models returned False")
    return mod

def extract_audio(result):
    import soundfile as sf
    def paths(obj):
        out=[]
        if isinstance(obj,str) and os.path.isfile(obj):
            out.append(obj)
        elif isinstance(obj,dict):
            for k,v in obj.items():
                if k in ("path","name") and isinstance(v,str) and os.path.isfile(v):
                    out.append(v)
                else:
                    out.extend(paths(v))
        elif isinstance(obj,(list,tuple)):
            for v in obj:
                out.extend(paths(v))
        return out
    if isinstance(result,(list,tuple)) and len(result)==2:
        a,b=result
        if isinstance(a,(int,np.integer,float,np.floating)) and not isinstance(b,(str,bytes,dict)):
            arr=np.asarray(b,dtype=np.float32)
            if arr.ndim>1:
                arr=np.squeeze(arr)
            return int(a),arr
        if isinstance(b,(int,np.integer,float,np.floating)) and not isinstance(a,(str,bytes,dict)):
            arr=np.asarray(a,dtype=np.float32)
            if arr.ndim>1:
                arr=np.squeeze(arr)
            return int(b),arr
    for p in paths(result):
        data,sr=sf.read(p,dtype="float32",always_2d=False)
        data=np.asarray(data,dtype=np.float32)
        if data.ndim>1:
            data=data.mean(axis=1)
        return int(sr),data
    raise RuntimeError("could not extract waveform from generate_speech result: "+repr(type(result)))

def symbol_mapping(space):
    sym=rf.load_module(space/"pmt2/synthesizer/persian_utils/symbols.py","v09_symbols")
    symbols=list(sym.symbols)
    return symbols,{s:i for i,s in enumerate(symbols)}

def guarded_input(raw,syn,space,mapping):
    splitter=rf.load_module(space/"sentence_splitter.py","v09_splitter").PersianSentenceSplitter(max_chars=150,min_chars=30)
    normalized=syn.normalize_text_for_synthesis(raw)
    segs=splitter.split(normalized)
    dropped=[]
    safe=[]
    for seg in segs:
        t=seg.strip()
        dropped.extend(ord(c) for c in t if c not in mapping)
        safe.append("".join(c for c in t if c in mapping))
    # OOV test inputs are short. Re-feeding the normalized, filtered text through the
    # locked frontend is idempotent for the removed code points and preserves D-OOV.
    return " ".join(safe),[f"U+{cp:04X}" for cp in dropped]

def metric_encoder(space):
    enc=importlib.import_module("encoder.inference")
    enc_path=rf.find_one(space,"encoder.pt",prefer=("saved_models/final_models","pmt2/saved_models/default"))
    enc.load_model(enc_path,device="cpu")
    return enc

def wave_metrics(y,sr,enc):
    import librosa
    y=np.asarray(y,dtype=np.float32)
    if y.ndim!=1:
        y=np.squeeze(y)
    duration=float(len(y)/sr)
    prep=enc.preprocess_wav(y,source_sr=sr)
    emb=np.asarray(enc.embed_utterance(prep),dtype=np.float64)
    f0=librosa.yin(y.astype(np.float64),fmin=50.0,fmax=600.0,sr=sr,frame_length=2048,hop_length=300)
    f0=f0[np.isfinite(f0)]
    f0=f0[(f0>=50.0)&(f0<=600.0)]
    if len(f0):
        med=float(np.median(f0))
        q1=float(np.percentile(f0,25)); q3=float(np.percentile(f0,75))
        iqr=q3-q1
    else:
        med=float("nan"); iqr=float("nan")
    S=np.abs(librosa.stft(y.astype(np.float64),n_fft=2048,hop_length=300,win_length=1200,center=True))
    ltas=np.mean(S,axis=1)
    ltas_db=20.0*np.log10(np.maximum(ltas,1e-12))
    ltas_db=ltas_db-np.max(ltas_db)
    return {"duration":duration,"sample_rate":int(sr),"embedding":emb,"f0_median_hz":med,"f0_iqr_hz":float(iqr),"ltas_db":ltas_db}

def pair_metrics(a,b):
    ea=a["embedding"]; eb=b["embedding"]
    cos=float(np.dot(ea,eb)/(np.linalg.norm(ea)*np.linalg.norm(eb)))
    da=max(a["duration"],b["duration"])/max(min(a["duration"],b["duration"]),1e-12)
    fmed=abs(a["f0_median_hz"]-b["f0_median_hz"])
    fiqr=abs(a["f0_iqr_hz"]-b["f0_iqr_hz"])
    ltas=float(np.sqrt(np.mean((a["ltas_db"]-b["ltas_db"])**2)))
    return {"speaker_cosine":cos,"speaker_distance":1.0-cos,"duration_ratio":float(da),
            "f0_median_abs_diff_hz":float(fmed),"f0_iqr_abs_diff_hz":float(fiqr),
            "ltas_rmse_db":ltas}

def summarize_within(metrics):
    pairs=[pair_metrics(metrics[i],metrics[j]) for i,j in combinations(range(len(metrics)),2)]
    if not pairs:
        return {"pair_count":0}
    return {"pair_count":len(pairs),
      "max_speaker_distance":max(x["speaker_distance"] for x in pairs),
      "max_duration_ratio":max(x["duration_ratio"] for x in pairs),
      "max_f0_median_abs_diff_hz":max(x["f0_median_abs_diff_hz"] for x in pairs),
      "max_f0_iqr_abs_diff_hz":max(x["f0_iqr_abs_diff_hz"] for x in pairs),
      "max_ltas_rmse_db":max(x["ltas_rmse_db"] for x in pairs),
      "pairs":pairs}

def locate_synth_model(syn):
    import torch
    for name,obj in vars(syn).items():
        if obj.__class__.__name__ == "Synthesizer" and hasattr(obj,"load"):
            if hasattr(obj,"is_loaded") and not obj.is_loaded():
                obj.load()
            m=getattr(obj,"_model",None)
            if isinstance(m,torch.nn.Module) and all(hasattr(m,k) for k in ("encoder","decoder","postnet","post_proj")):
                return name,obj,m
    raise RuntimeError("could not locate/load Tacotron Synthesizer model in locked Space module")

def locate_vocoder_model(syn):
    import torch
    cands=[]
    for name,obj in vars(syn).items():
        if isinstance(obj,torch.nn.Module):
            cands.append((name,obj))
    # prefer a module exposing inference and not the synthesizer's internal model
    for name,obj in cands:
        if hasattr(obj,"inference"):
            return name,obj
    raise RuntimeError("could not locate loaded vocoder generator in locked Space module")

def module_param_budget(module):
    import torch
    params=sum(int(p.numel()) for p in module.parameters())
    buffers=sum(int(b.numel()) for b in module.buffers())
    return {"parameter_count":params,"fp32_parameter_bytes":params*4,
            "buffer_count":buffers,"fp32_buffer_bytes":buffers*4}

def asset_budget(space,syn,out):
    _,wrapper,tac=locate_synth_model(syn)
    vname,vocoder=locate_vocoder_model(syn)
    # The hosted loader normally removes weight norm. If not, do it here for the
    # read-only deployment-size accounting required by P0-12.
    names=[n for n,_ in vocoder.named_parameters()]
    had_wn=any(("weight_g" in n or "weight_v" in n) for n in names)
    if had_wn and hasattr(vocoder,"remove_weight_norm"):
        vocoder.remove_weight_norm()
    groups={
      "tacotron_encoder_plus_proj":module_param_budget(tac.encoder),
      "decoder_step":module_param_budget(tac.decoder),
      "postnet_plus_post_proj":module_param_budget(tac.postnet),
      "vocoder_generator_after_remove_weight_norm":module_param_budget(vocoder),
    }
    # Add the projections that belong to future graph boundaries.
    encproj=module_param_budget(tac.encoder_proj)
    groups["tacotron_encoder_plus_proj"]["parameter_count"]+=encproj["parameter_count"]
    groups["tacotron_encoder_plus_proj"]["fp32_parameter_bytes"]+=encproj["fp32_parameter_bytes"]
    groups["tacotron_encoder_plus_proj"]["buffer_count"]+=encproj["buffer_count"]
    groups["tacotron_encoder_plus_proj"]["fp32_buffer_bytes"]+=encproj["fp32_buffer_bytes"]
    postproj=module_param_budget(tac.post_proj)
    groups["postnet_plus_post_proj"]["parameter_count"]+=postproj["parameter_count"]
    groups["postnet_plus_post_proj"]["fp32_parameter_bytes"]+=postproj["fp32_parameter_bytes"]
    groups["postnet_plus_post_proj"]["buffer_count"]+=postproj["buffer_count"]
    groups["postnet_plus_post_proj"]["fp32_buffer_bytes"]+=postproj["fp32_buffer_bytes"]
    voc_path=rf.find_one(space,"vocoder_HiFiGAN.pkl",prefer=("saved_models/final_models",))
    result={"schema":"mana.p0-12-asset-budget.v1","groups":groups,
      "vocoder_global_name":vname,"weight_norm_present_before_budget_removal":had_wn,
      "training_checkpoint_bytes":int(voc_path.stat().st_size),
      "training_checkpoint_sha256":sha256_file(voc_path),
      "note":"vocoder_HiFiGAN.pkl is a full training checkpoint and is not the deployable generator size"}
    write_json(out/"p0-12-asset-budget.json",result)
    return result

def hosted_inputs(hosted_dir):
    import soundfile as sf
    rows=[]
    if hosted_dir is None or not Path(hosted_dir).exists():
        return rows
    for p in sorted(Path(hosted_dir).glob("*.wav")):
        y,sr=sf.read(p,dtype="float32",always_2d=False)
        y=np.asarray(y,dtype=np.float32)
        if y.ndim>1: y=y.mean(axis=1)
        rows.append((p.name,int(sr),y,sha256_file(p)))
    return rows

def main():
    if len(sys.argv) not in (4,5):
        raise SystemExit("usage: reference_corpus_v09.py SPACE SYNTH OUT [HOSTED_DIR]")
    space=Path(sys.argv[1]); synth=Path(sys.argv[2]); out=Path(sys.argv[3]); out.mkdir(parents=True,exist_ok=True)
    hosted_dir=Path(sys.argv[4]) if len(sys.argv)==5 else None
    if sha256_file(synth)!=rf.SYNTH_SHA256:
        raise SystemExit("synthesizer hash mismatch")
    if os.popen(f"git -C {space} rev-parse HEAD").read().strip()!=rf.SPACE_COMMIT:
        raise SystemExit("space commit mismatch")

    # Fetch/pin the same public assets used by the locked Space, then load the exact hosted code.
    rf.run_setup(space,synth)
    syn=import_space_synthesis(space)
    _,mapping=symbol_mapping(space)
    enc=metric_encoder(space)
    budget=asset_budget(space,syn,out)

    import soundfile as sf
    import torch
    local_dir=out/"local_reference_audio"; local_dir.mkdir(exist_ok=True)
    primary_dir=out/"primary_audio"; primary_dir.mkdir(exist_ok=True)
    records=[]; local_metrics={}
    for idx,raw in enumerate(SENTENCES):
        safe,dropped=guarded_input(raw,syn,space,mapping)
        render_input=safe if dropped else raw
        local_metrics[idx]=[]
        for r in range(3):
            seed=2026091900+idx*10+r
            torch.manual_seed(seed)
            np.random.seed(seed & 0xffffffff)
            result=syn.generate_speech(render_input)
            sr,y=extract_audio(result)
            if sr!=24000:
                raise RuntimeError(f"unexpected sample rate {sr} for sentence {idx}")
            if not np.all(np.isfinite(y)):
                raise RuntimeError(f"nonfinite waveform for sentence {idx}")
            name=f"s{idx:02d}-r{r}.wav"
            path=local_dir/name
            sf.write(path,y,sr,subtype="PCM_16")
            # Re-read the exact persisted PCM used for hashes and metrics.
            yy,ssr=sf.read(path,dtype="float32",always_2d=False)
            yy=np.asarray(yy,dtype=np.float32)
            m=wave_metrics(yy,int(ssr),enc)
            local_metrics[idx].append(m)
            rec={"sentence_id":idx,"input":raw,"render_index":r,"seed":seed,
                 "frontend_mode":"declared_oov_guard" if dropped else "reference_exact",
                 "dropped_codepoints":dropped,"input_to_synthesis":render_input,
                 "wav":name,"sha256":sha256_file(path),"duration":m["duration"],
                 "sample_rate":m["sample_rate"],"size":int(path.stat().st_size),
                 "f0_median_hz":m["f0_median_hz"],"f0_iqr_hz":m["f0_iqr_hz"]}
            records.append(rec)
            if r==0:
                shutil.copy2(path,primary_dir/name)

    total=sum((local_dir/r["wav"]).stat().st_size for r in records)
    manifest={"schema":"mana.reference-corpus.v09","space_commit":rf.SPACE_COMMIT,
              "render_count":len(records),"sentence_count":len(SENTENCES),
              "renders_per_sentence":3,"audio_format":"mono PCM16 WAV 24000 Hz",
              "d10":"stochastic Prenet dropout; fixed independent seeds are recorded for reproducibility",
              "d12":"no mel correction, rescaling, stats normalization, or normalize_before=true",
              "records":records,"total_audio_bytes":int(total)}
    write_json(out/"reference_corpus_manifest.json",manifest)

    # Pairwise local spread for all 20 sentences.
    local_spread={str(i):summarize_within(ms) for i,ms in local_metrics.items()}

    # Existing legitimate hosted captures are both sentence 0. They establish the hosted noise floor.
    hosted=hosted_inputs(hosted_dir)
    hosted_metrics=[]
    hosted_meta=[]
    for name,sr,y,h in hosted:
        m=wave_metrics(y,sr,enc); hosted_metrics.append(m)
        hosted_meta.append({"name":name,"sha256":h,"duration":m["duration"],"sample_rate":sr,
                            "f0_median_hz":m["f0_median_hz"],"f0_iqr_hz":m["f0_iqr_hz"]})
    comp={"schema":"mana.p0-11-comparison.v1","anchor_sentence_id":0,"anchor_input":SENTENCES[0],
          "hosted":hosted_meta,"local_spread":local_spread,
          "hosted_anchor_sentence_count":1,"hosted_render_count":len(hosted_metrics)}
    if len(hosted_metrics)>=2:
        within_hosted=summarize_within(hosted_metrics)
        within_local=local_spread["0"]
        bands={
          "speaker_distance":max(within_hosted["max_speaker_distance"],within_local["max_speaker_distance"]),
          "duration_ratio":max(within_hosted["max_duration_ratio"],within_local["max_duration_ratio"]),
          "f0_median_abs_diff_hz":max(within_hosted["max_f0_median_abs_diff_hz"],within_local["max_f0_median_abs_diff_hz"]),
          "f0_iqr_abs_diff_hz":max(within_hosted["max_f0_iqr_abs_diff_hz"],within_local["max_f0_iqr_abs_diff_hz"]),
          "ltas_rmse_db":max(within_hosted["max_ltas_rmse_db"],within_local["max_ltas_rmse_db"])
        }
        cross=[]
        for hi,hm in enumerate(hosted_metrics):
            for li,lm in enumerate(local_metrics[0]):
                q=pair_metrics(hm,lm)
                q["hosted_index"]=hi; q["local_render_index"]=li
                q["pass"]=(q["speaker_distance"]<=bands["speaker_distance"]+1e-12 and
                           q["duration_ratio"]<=bands["duration_ratio"]+1e-12 and
                           q["f0_median_abs_diff_hz"]<=bands["f0_median_abs_diff_hz"]+1e-9 and
                           q["f0_iqr_abs_diff_hz"]<=bands["f0_iqr_abs_diff_hz"]+1e-9 and
                           q["ltas_rmse_db"]<=bands["ltas_rmse_db"]+1e-9)
                cross.append(q)
        comp.update({"within_hosted":within_hosted,"within_local_anchor":within_local,
                     "tolerance_band":bands,"hosted_vs_local":cross,
                     "anchor_pass":all(x["pass"] for x in cross),
                     "band_rule":"per metric: max observed within-hosted spread and within-local spread for the same anchor sentence"})
    else:
        comp["anchor_pass"]=None
        comp["band_rule"]="insufficient hosted repeats; use within-local spread only when directive permits"
    write_json(out/"p0-11-comparison.json",comp)

    # Package all 60 WAVs plus manifest for later private canonical Release publication.
    zip_path=out/"mana-reference-corpus-v09.zip"
    with zipfile.ZipFile(zip_path,"w",compression=zipfile.ZIP_DEFLATED) as z:
        z.write(out/"reference_corpus_manifest.json","reference_corpus_manifest.json")
        for p in sorted(local_dir.glob("*.wav")):
            z.write(p,"audio/"+p.name)
    summary={"render_count":len(records),"sentence_count":len(SENTENCES),"total_audio_bytes":int(total),
             "zip_sha256":sha256_file(zip_path),"zip_size":int(zip_path.stat().st_size),
             "primary_audio_bytes":sum(p.stat().st_size for p in primary_dir.glob("*.wav")),
             "p0_12":budget,"anchor_pass":comp.get("anchor_pass"),
             "hosted_anchor_sentence_count":comp["hosted_anchor_sentence_count"],
             "hosted_render_count":comp["hosted_render_count"]}
    write_json(out/"corpus-summary.json",summary)
    print(stable_json(summary),end="")

if __name__=="__main__":
    main()
