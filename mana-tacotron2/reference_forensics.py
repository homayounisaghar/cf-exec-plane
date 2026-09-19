#!/usr/bin/env python3
import ast
import hashlib
import importlib.util
import inspect
import json
import math
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np

SPACE_COMMIT = "3784ae7afc431cf333ad5961900db37a8297e5c6"
SYNTH_SHA256 = "433588014a7c0622e9f3b00faa75d8fa35344f0d61f64fd715f27a096978a21d"
MIRROR_REV = "152eac6fecaa08eea2be25113a21d5eec1631bf2"
MIRROR_BASE = "https://huggingface.co/erfanasgari21/PersianMultiSpeakerTacotron2/resolve/" + MIRROR_REV

def sha256_file(path):
    h=hashlib.sha256()
    with open(path,"rb") as f:
        for chunk in iter(lambda:f.read(1024*1024),b""):
            h.update(chunk)
    return h.hexdigest()

def stable_json(obj):
    return json.dumps(obj,ensure_ascii=False,sort_keys=True,separators=(",",":"))+"\n"

def write_json(path,obj):
    Path(path).write_text(stable_json(obj),encoding="utf-8")

def load_module(path,name):
    spec=importlib.util.spec_from_file_location(name,path)
    mod=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

def extract_top_level_source(path,names):
    src=Path(path).read_text(encoding="utf-8")
    tree=ast.parse(src)
    lines=src.splitlines()
    found={}
    for node in tree.body:
        if isinstance(node,(ast.FunctionDef,ast.AsyncFunctionDef,ast.ClassDef)) and node.name in names:
            found[node.name]="\n".join(lines[node.lineno-1:node.end_lineno])+"\n"
    return found

def find_one(root,name,prefer=()):
    candidates=[p for p in Path(root).rglob(name) if p.is_file() and ".git" not in p.parts]
    if not candidates:
        raise FileNotFoundError(name)
    for token in prefer:
        for p in candidates:
            if token in p.as_posix():
                return p
    return sorted(candidates,key=lambda p:(len(p.parts),p.as_posix()))[0]

def module_table(model):
    import torch
    rows={}
    for name,m in model.named_modules():
        if not name:
            continue
        row={"type":type(m).__name__}
        if isinstance(m,torch.nn.Linear):
            row.update(in_features=int(m.in_features),out_features=int(m.out_features),bias=m.bias is not None)
        elif isinstance(m,torch.nn.Embedding):
            row.update(num_embeddings=int(m.num_embeddings),embedding_dim=int(m.embedding_dim))
        elif isinstance(m,(torch.nn.GRUCell,torch.nn.LSTMCell)):
            row.update(input_size=int(m.input_size),hidden_size=int(m.hidden_size))
        elif isinstance(m,(torch.nn.GRU,torch.nn.LSTM)):
            row.update(input_size=int(m.input_size),hidden_size=int(m.hidden_size),
                       num_layers=int(m.num_layers),bidirectional=bool(m.bidirectional),batch_first=bool(m.batch_first))
        elif isinstance(m,torch.nn.Conv1d):
            row.update(in_channels=int(m.in_channels),out_channels=int(m.out_channels),
                       kernel_size=list(m.kernel_size),stride=list(m.stride),
                       padding=list(m.padding),dilation=list(m.dilation),groups=int(m.groups))
        elif isinstance(m,torch.nn.BatchNorm1d):
            row.update(num_features=int(m.num_features))
        rows[name]=row
    return rows

def build_checkpoint_dims(space,synth,out):
    import torch
    sys.path.insert(0,str(space/"pmt2"))
    hp=load_module(space/"pmt2/synthesizer/hparams.py","v08_hparams").hparams
    symbols=list(load_module(space/"pmt2/synthesizer/persian_utils/symbols.py","v08_symbols").symbols)
    Tacotron=load_module(space/"pmt2/synthesizer/models/tacotron.py","v08_tacotron").Tacotron
    model=Tacotron(embed_dims=hp.tts_embed_dims,num_chars=len(symbols),encoder_dims=hp.tts_encoder_dims,
                   decoder_dims=hp.tts_decoder_dims,n_mels=hp.num_mels,fft_bins=hp.num_mels,
                   postnet_dims=hp.tts_postnet_dims,encoder_K=hp.tts_encoder_K,lstm_dims=hp.tts_lstm_dims,
                   postnet_K=hp.tts_postnet_K,num_highways=hp.tts_num_highways,dropout=hp.tts_dropout,
                   stop_threshold=hp.tts_stop_threshold,speaker_embedding_size=hp.speaker_embedding_size)
    before_r=int(model.decoder.r.item())
    model.load(synth)
    model.eval()
    st=model.state_dict()
    state=[]
    for name,t in sorted(st.items()):
        state.append({"name":name,"shape":[int(x) for x in t.shape],"dtype":str(t.dtype)})
    mods=module_table(model)
    enc_cbhg=int(model.encoder.cbhg.rnn.hidden_size)*(2 if model.encoder.cbhg.rnn.bidirectional else 1)
    derived={
        "checkpoint_sha256":sha256_file(synth),
        "state_entry_count":len(state),
        "decoder_r_before_load":before_r,
        "decoder_r_after_load":int(model.decoder.r.item()),
        "decoder_r_in_state_dict":"decoder.r" in st,
        "checkpoint_step":int(st["step"].item()) if "step" in st else None,
        "num_chars_checkpoint":int(model.encoder.embedding.weight.shape[0]),
        "num_chars_symbols":len(symbols),
        "num_chars_match":int(model.encoder.embedding.weight.shape[0])==len(symbols),
        "max_r":int(model.decoder.max_r),
        "num_mels":int(model.n_mels),
        "speaker_embedding_size":int(model.speaker_embedding_size),
        "encoder_prenet_fc1_out":int(model.encoder.pre_net.fc1.out_features),
        "encoder_prenet_fc2_out":int(model.encoder.pre_net.fc2.out_features),
        "decoder_prenet_fc1_out":int(model.decoder.prenet.fc1.out_features),
        "decoder_prenet_fc2_out":int(model.decoder.prenet.fc2.out_features),
        "encoder_cbhg_output_width":enc_cbhg,
        "encoder_seq_width_with_speaker":enc_cbhg+int(model.speaker_embedding_size),
        "encoder_proj_in_features":int(model.encoder_proj.in_features),
        "encoder_proj_out_features":int(model.encoder_proj.out_features),
        "attn_rnn_input_size":int(model.decoder.attn_rnn.input_size),
        "attn_rnn_hidden_size":int(model.decoder.attn_rnn.hidden_size),
        "rnn_input_in_features":int(model.decoder.rnn_input.in_features),
        "rnn_input_out_features":int(model.decoder.rnn_input.out_features),
        "rnn1_input_size":int(model.decoder.res_rnn1.input_size),
        "rnn1_hidden_size":int(model.decoder.res_rnn1.hidden_size),
        "rnn2_input_size":int(model.decoder.res_rnn2.input_size),
        "rnn2_hidden_size":int(model.decoder.res_rnn2.hidden_size),
        "stop_proj_in_features":int(model.decoder.stop_proj.in_features),
        "stop_proj_out_features":int(model.decoder.stop_proj.out_features),
        "mel_proj_in_features":int(model.decoder.mel_proj.in_features),
        "mel_proj_out_features":int(model.decoder.mel_proj.out_features),
        "postnet_rnn_input_size":int(model.postnet.rnn.input_size),
        "postnet_rnn_hidden_size":int(model.postnet.rnn.hidden_size),
        "postnet_bidirectional":bool(model.postnet.rnn.bidirectional),
        "post_proj_in_features":int(model.post_proj.in_features),
        "post_proj_out_features":int(model.post_proj.out_features),
        "hparams":{
            "sample_rate":int(hp.sample_rate),"hop_size":int(hp.hop_size),"n_fft":int(hp.n_fft),
            "win_size":int(hp.win_size),"num_mels":int(hp.num_mels),"fmin":int(hp.fmin),"fmax":int(hp.fmax),
            "tts_dropout":float(hp.tts_dropout),"tts_stop_threshold":float(hp.tts_stop_threshold)
        }
    }
    tac_src=(space/"pmt2/synthesizer/models/tacotron.py").read_text(encoding="utf-8")
    speaker_concat_source=(
        "x = self.add_speaker_embedding(x, speaker_embedding)" in tac_src and
        "torch.cat((x, e), 2)" in tac_src
    )
    derived["speaker_concat_source_verified"]=speaker_concat_source
    derived["speaker_enters_once_dimensional_check"]=(
        derived["encoder_seq_width_with_speaker"]==derived["encoder_proj_in_features"] and
        derived["attn_rnn_input_size"]==derived["encoder_seq_width_with_speaker"]+derived["decoder_prenet_fc2_out"]
    )
    dim_keys={"in_features","out_features","input_size","hidden_size","num_embeddings","embedding_dim","in_channels","out_channels","num_features"}
    compact_mods={k:v for k,v in mods.items() if any(key in v for key in dim_keys)}
    compact_state=[[x["name"],x["shape"],x["dtype"]] for x in state]
    payload={"schema":"mana.checkpoint-dims.v1","serialization":{"encoding":"utf-8","ensure_ascii":False,
             "sort_keys":True,"separators":[",",":"],"trailing_newline":True,
             "state_entry_format":["name","shape","dtype"]},
             "derived":derived,"modules":compact_mods,"state_dict":compact_state}
    p=out/"checkpoint_dims.json"
    p.write_text(stable_json(payload),encoding="utf-8")
    (out/"checkpoint_dims.sha256").write_text(sha256_file(p)+"  checkpoint_dims.json\n",encoding="utf-8")
    return model,hp,symbols,derived

def symbol_reconciliation(space,out):
    symbols=list(load_module(space/"pmt2/synthesizer/persian_utils/symbols.py","v08_symbols2").symbols)
    mapping={s:i for i,s in enumerate(symbols)}
    occ={}
    for i,s in enumerate(symbols): occ.setdefault(s,[]).append(i)
    dups={k:v for k,v in occ.items() if len(v)>1}
    canonical_payload={"symbols":symbols,"symbol_to_id":mapping,"duplicates":dups}
    canonical_text=json.dumps(canonical_payload,ensure_ascii=False,sort_keys=True,separators=(",",":"))
    assert len(symbols)==126
    assert mapping["_"]==120 and mapping[" "]==58 and mapping["‌"]==125
    dead=sorted(set(range(len(symbols)))-set(mapping.values()))
    assert dead==[0,57,64]
    result={
      "len":len(symbols),"winning_ids":{"underscore":mapping["_"],"space":mapping[" "],"zwnj":mapping["‌"]},
      "dead_unreachable_ids":dead,
      "canonical_sha256":hashlib.sha256(canonical_text.encode("utf-8")).hexdigest(),
      "serialization_recipe":{"top_level_keys":["duplicates","symbol_to_id","symbols"],"sort_keys":True,
        "ensure_ascii":False,"separators":[",",":"],"trailing_newline":False},
      "independent_hash_from_owner":"0bf546c24f3c4eeea7eb8f57ade62dbacb65afd85c64142be97c0744a8d84656",
      "content_assertion_pass":True
    }
    write_json(out/"p0-4-reconciliation.json",result)
    return symbols,mapping

def frontend_capture(space,symbols,mapping,out):
    synthesis_defs=extract_top_level_source(space/"synthesis.py",{"normalize_text_for_synthesis"})
    splitter_text=(space/"sentence_splitter.py").read_text(encoding="utf-8")
    number_text=(space/"persian_numbers.py").read_text(encoding="utf-8")
    normalize_text=synthesis_defs["normalize_text_for_synthesis"]
    port=(
      "# Verbatim public-source capture from abreza/mana-tts @ "+SPACE_COMMIT+"\n"
      "# Sections below are copied without semantic edits.\n\n"
      "### persian_numbers.py\n"+number_text+"\n"
      "### sentence_splitter.py\n"+splitter_text+"\n"
      "### synthesis.py::normalize_text_for_synthesis\n"+normalize_text
    )
    (out/"frontend_verbatim_capture.txt").write_text(port,encoding="utf-8")

    nums=load_module(space/"persian_numbers.py","v08_numbers")
    splitter_mod=load_module(space/"sentence_splitter.py","v08_splitter")
    ns={"re":re,"find_and_normalize_numbers":nums.find_and_normalize_numbers}
    exec(normalize_text,ns)
    normalize=ns["normalize_text_for_synthesis"]
    Splitter=splitter_mod.PersianSentenceSplitter

    tests=[
      "سلام دنیا.","عدد ۱۲۳ را بخوان.","شماره من ۰۹۱۲۳۴۵۶۷۸۹ است.",
      "تماس بین المللی: +۹۸۹۱۵۱۰۰۲۰۳۰","قیمت ۵,۴۰۰ تومان است.",
      "كیفیت يکسان باشد.","نیم_فاصله آزمایش.","فاصله    زیاد   جمع شود.",
      "این یک پرسش است؟","این هم پرسش است?","سلام، حال شما چطور است؟",
      "یکی؛ دو؛ سه.","ABC فارسی test.","سال 2026 خوب است.","عدد -5 را بخوان.",
      "۰۲۱-۸۸۸۰۳۳۵۴","کد 88991100","1001 شب","صفر 0","درصد 50٪",
      "می‌خواهم متن نیم‌فاصله داشته باشد.","«سلام دنیا»","\"سلام دنیا\"","'سلام دنیا'",
      "واژهٔ ناشناخته € باید بررسی شود.","نشانه 🙂 باید حذف شود.",
      "این جمله کمی بلندتر است تا رفتار تقسیم متن و مرزهای ضعیف، ویرگول و نقطه بررسی شود. سپس جمله دوم آغاز می‌شود.",
      "الف، ب، پ، ت، ث، ج، چ، ح، خ، د، ذ، ر، ز، ژ، س، ش.",
      "شماره 09120000000 و عدد 12345 کنار هم.","+1 (212) 555-0100",
      "آیا «نقل قول» و \"quote\" باقی می‌مانند؟","خط اول\nخط دوم\tبا فاصله."
    ]
    splitter=Splitter(max_chars=150,min_chars=30)
    fixtures=[]
    quote_probe={}
    for raw in tests:
        normalized=normalize(raw)
        segments=splitter.split(normalized)
        seg_rows=[]
        for seg in segments:
            stripped=seg.strip()
            oov=[c for c in stripped if c not in mapping]
            filtered="".join(c for c in stripped if c in mapping)
            ids=[mapping[c] for c in filtered]
            seg_rows.append({"text":stripped,"oov_codepoints":[f"U+{ord(c):04X}" for c in oov],
                             "filtered":filtered,"ids":ids})
        fixtures.append({"input":raw,"normalized":normalized,"segments":seg_rows})
        if any(q in raw for q in ["«","»",'"',"'"]):
            quote_probe[raw]={"normalized":normalized,
                              "present_after_frontend":{q:(q in normalized) for q in ["«","»",'"',"'"]},
                              "in_symbols":{q:(q in mapping) for q in ["«","»",'"',"'"]}}
    write_json(out/"frontend_fixtures.json",{"schema":"mana.frontend-fixtures.v1","count":len(fixtures),"fixtures":fixtures})
    write_json(out/"frontend_quote_probe.json",quote_probe)
    return fixtures

def run_setup(space,synth):
    final=space/"saved_models/final_models"
    final.mkdir(parents=True,exist_ok=True)
    target=final/"synthesizer.pt"
    if not target.exists():
        shutil.copy2(synth,target)
    sys.path.insert(0,str(space))
    setup=load_module(space/"setup.py","v08_setup")
    ok=setup.setup_environment()
    if ok is False:
        raise RuntimeError("setup_environment returned false")

def speaker_probe(space,out):
    import torch
    import soundfile as sf
    sys.path.insert(0,str(space/"pmt2"))
    Synthesizer=load_module(space/"pmt2/synthesizer/inference.py","v08_syninf").Synthesizer
    enc=load_module(space/"pmt2/encoder/inference.py","v08_encinf")
    params=load_module(space/"pmt2/encoder/params_data.py","v08_encparams")
    sample=find_one(space,"sample.wav",prefer=("sample.wav",))
    encoder=find_one(space,"encoder.pt",prefer=("saved_models/final_models","pmt2/saved_models/default"))
    info=sf.info(str(sample))
    loaded=Synthesizer.load_preprocess_wav(sample)
    ref_pre=enc.preprocess_wav(loaded)
    enc.load_model(encoder,device="cpu")
    embeds=[]
    for _ in range(10):
        e=np.asarray(enc.embed_utterance(ref_pre),dtype="<f4")
        embeds.append(e)
    byte_identical=all(e.tobytes()==embeds[0].tobytes() for e in embeds[1:])
    maxdiff=max(float(np.max(np.abs(e-embeds[0]))) for e in embeds)
    emb=embeds[0]
    emb_path=out/"speaker_embed.f32"
    emb_path.write_bytes(emb.tobytes(order="C"))
    alt=None
    try:
        # Compare the reference's omitted source_sr against the intended 24k->16k path.
        # The locked encoder helper uses the legacy positional librosa.resample API;
        # call modern librosa explicitly here so this diagnostic remains environment-stable.
        corrected=librosa.resample(np.asarray(loaded,dtype=np.float32),orig_sr=24000,target_sr=int(params.sampling_rate))
        corrected=enc.preprocess_wav(corrected,source_sr=None)
        corr=np.asarray(enc.embed_utterance(corrected),dtype=np.float32)
        cosine=float(np.dot(emb,corr)/(np.linalg.norm(emb)*np.linalg.norm(corr)))
        alt={"corrected_resample_samples":int(len(corrected)),"cosine_similarity":cosine,
             "max_abs_diff":float(np.max(np.abs(emb-corr)))}
    except Exception as e:
        alt={"error":repr(e)}
    src=inspect.getsource(enc.preprocess_wav)
    result={
      "sample_path":str(sample.relative_to(space)),"sample_file_sha256":sha256_file(sample),
      "sample_container_samplerate":int(info.samplerate),"sample_frames":int(info.frames),
      "synth_load_preprocess_target_rate":24000,"loaded_samples":int(len(loaded)),
      "encoder_expected_sampling_rate":int(params.sampling_rate),
      "reference_encoder_preprocess_source_sr_argument":None,
      "reference_preprocess_resample_condition_present":"source_sr is not None" in src,
      "reference_path_resamples_between_24000_and_encoder":False,
      "partials_n_frames":int(params.partials_n_frames),"partial_default_min_pad_coverage":0.75,
      "partial_default_overlap":0.5,"embedding_shape":list(emb.shape),
      "repeat_count":10,"byte_identical":byte_identical,"max_abs_repeat_diff":maxdiff,
      "embedding_sha256":sha256_file(emb_path),"embedding_base64":__import__("base64").b64encode(emb.tobytes(order="C")).decode("ascii"),
      "corrected_resample_comparison":alt,
      "encoder_checkpoint_path":str(encoder.relative_to(space)),"encoder_checkpoint_sha256":sha256_file(encoder)
    }
    write_json(out/"p0-6-speaker.json",result)
    return result

def vocoder_probe(space,out):
    import yaml
    import librosa
    import scipy.signal
    if not hasattr(scipy.signal,"kaiser"):
        scipy.signal.kaiser=scipy.signal.windows.kaiser
    from parallel_wavegan.utils import load_model
    from parallel_wavegan.bin.preprocess import logmelfilterbank
    sys.path.insert(0,str(space/"pmt2"))
    Synthesizer=load_module(space/"pmt2/synthesizer/inference.py","v08_syninf2").Synthesizer
    voc=find_one(space,"vocoder_HiFiGAN.pkl",prefer=("saved_models/final_models",))
    cfg=find_one(space,"config.yml",prefer=("saved_models/final_models",))
    sample=find_one(space,"sample.wav",prefer=("sample.wav",))
    with open(cfg,encoding="utf-8") as f:
        config=yaml.safe_load(f)
    model=load_model(str(voc),str(cfg))
    sig=str(inspect.signature(model.inference))
    norm_default=None
    if "normalize_before" in inspect.signature(model.inference).parameters:
        norm_default=inspect.signature(model.inference).parameters["normalize_before"].default
    stats=[p.name for p in voc.parent.iterdir() if p.name in ("stats.h5","stats.npy")]
    wav,_=librosa.load(str(sample),sr=int(config["sampling_rate"]))
    synth=Synthesizer.make_spectrogram(sample).T
    pwg=logmelfilterbank(
        wav,sampling_rate=int(config["sampling_rate"]),fft_size=int(config["fft_size"]),
        hop_size=int(config["hop_size"]),win_length=int(config["win_length"]),
        window=config.get("window","hann"),num_mels=int(config["num_mels"]),
        fmin=float(config["fmin"]),fmax=float(config["fmax"]),log_base=10.0)
    n=min(len(synth),len(pwg))
    x=synth[:n].reshape(-1).astype(np.float64)
    y=pwg[:n].reshape(-1).astype(np.float64)
    a,b=np.polyfit(x,y,1)
    pred=a*x+b
    ss_res=float(np.sum((y-pred)**2)); ss_tot=float(np.sum((y-y.mean())**2))
    r2=1.0-ss_res/ss_tot if ss_tot else float("nan")
    bands=[]
    for i in range(min(synth.shape[1],pwg.shape[1])):
        xi=synth[:n,i].astype(np.float64); yi=pwg[:n,i].astype(np.float64)
        ai,bi=np.polyfit(xi,yi,1); pi=ai*xi+bi
        den=float(np.sum((yi-yi.mean())**2))
        r2i=1.0-float(np.sum((yi-pi)**2))/den if den else float("nan")
        bands.append({"band":i,"a":float(ai),"b":float(bi),"r2":r2i})
    result={
      "vocoder_path":str(voc.relative_to(space)),"vocoder_sha256":sha256_file(voc),
      "config_path":str(cfg.relative_to(space)),"config_sha256":sha256_file(cfg),
      "inference_signature":sig,"normalize_before_default":norm_default,
      "stats_files_present":stats,"register_stats_expected":bool(stats),
      "generator_type":config.get("generator_type"),"sampling_rate":config.get("sampling_rate"),
      "fft_size":config.get("fft_size"),"hop_size":config.get("hop_size"),
      "win_length":config.get("win_length"),"num_mels":config.get("num_mels"),
      "fmin":config.get("fmin"),"fmax":config.get("fmax"),
      "upsample_kernel_sizes":config.get("upsample_kernel_sizes"),
      "aux_context_window":config.get("aux_context_window"),
      "affine_fit_pwg_log10_equals_a_times_reference_D_plus_b":{
        "a":float(a),"b":float(b),"r2":r2,"reference_ideal_if_no_preemphasis":{"a":0.625,"b":-1.5},
        "aligned_frames":n,"per_band":bands
      }
    }
    write_json(out/"p0-7-vocoder.json",result)
    return result

def asset_probe(space,synth,out):
    import requests
    names={
      "synthesizer.pt":find_one(space,"synthesizer.pt",prefer=("saved_models/final_models",)),
      "encoder.pt":find_one(space,"encoder.pt",prefer=("saved_models/final_models","pmt2/saved_models/default")),
      "vocoder_HiFiGAN.pkl":find_one(space,"vocoder_HiFiGAN.pkl",prefer=("saved_models/final_models",)),
      "config.yml":find_one(space,"config.yml",prefer=("saved_models/final_models",)),
      "sample.wav":find_one(space,"sample.wav",prefer=("sample.wav",))
    }
    setup_text=(space/"setup.py").read_text(encoding="utf-8")
    urls=sorted(set(re.findall(r'https?://[^\"\'\s)]+',setup_text)))
    mirror_paths={
      "encoder.pt":"saved_models/final_models/encoder.pt",
      "vocoder_HiFiGAN.pkl":"saved_models/final_models/vocoder_HiFiGAN.pkl",
      "config.yml":"saved_models/final_models/config.yml",
      "sample.wav":"sample.wav"
    }
    mirror={}
    mirror_dir=out/"mirror_compare"; mirror_dir.mkdir(exist_ok=True)
    for name,rel in mirror_paths.items():
        url=f"{MIRROR_BASE}/{rel}?download=true"
        dest=mirror_dir/name
        try:
            with requests.get(url,stream=True,timeout=120) as resp:
                resp.raise_for_status()
                with open(dest,"wb") as f:
                    for chunk in resp.iter_content(1024*1024):
                        if chunk: f.write(chunk)
            mirror[name]={"url":url,"sha256":sha256_file(dest),
                          "matches_reference":sha256_file(dest)==sha256_file(names[name])}
            dest.unlink()
        except Exception as e:
            mirror[name]={"url":url,"error":repr(e),"matches_reference":False}
    result={"space_setup_urls":urls,"assets":{},"non_google_drive_mirror":mirror,
            "synthesizer_non_google_route":"https://huggingface.co/MahtaFetrat/Persian-Tacotron2-on-ManaTTS"}
    for name,p in names.items():
        result["assets"][name]={"path":str(p.relative_to(space)),"sha256":sha256_file(p),"size":p.stat().st_size}
    write_json(out/"p0-8-assets.json",result)
    return result

def environment_probe(out):
    freeze=subprocess.check_output([sys.executable,"-m","pip","freeze"],text=True)
    (out/"requirements.lock").write_text(freeze,encoding="utf-8")
    wanted=["torch","librosa","numpy","scipy","numba","parallel-wavegan","soundfile","gdown","h5py","pyyaml"]
    versions={}
    for line in freeze.splitlines():
        low=line.lower()
        for key in wanted:
            if low.startswith(key+"==") or low.startswith(key.replace("-","_")+"=="):
                versions[key]=line.split("==",1)[1]
    write_json(out/"p0-9-environment.json",{"python":sys.version,"packages":versions,
      "lock_sha256":sha256_file(out/"requirements.lock")})
    return versions

def stop_probe(space,out):
    tac=(space/"pmt2/synthesizer/models/tacotron.py").read_text(encoding="utf-8")
    inf=(space/"pmt2/synthesizer/inference.py").read_text(encoding="utf-8")
    result={
      "stop_proj_then_sigmoid":"s = self.stop_proj(s)" in tac and "stop_tokens = torch.sigmoid(s)" in tac,
      "generate_break":"if (stop_tokens > 0.5).all() and t > 10: break" in tac,
      "generate_steps_default_2000":"def generate(self, x, speaker_embedding=None, steps=2000)" in tac,
      "posthoc_trim":"while np.max(m[:, -1]) < hparams.tts_stop_threshold" in inf,
      "stop_threshold_value_source":"hparams.tts_stop_threshold",
      "stop_token_contract":"post-sigmoid"
    }
    write_json(out/"p0-10-stop.json",result)
    return result

def hosted_reference_attempt(out):
    sentences=[
      "سلام دنیا.","امروز هوا خوب است.","این یک جمله کوتاه برای آزمایش صدا است.",
      "عدد ۱۲۳ را بخوان.","شماره من ۰۹۱۲۳۴۵۶۷۸۹ است.","تماس بین المللی +۹۸۹۱۵۱۰۰۲۰۳۰ است.",
      "قیمت این کالا ۵,۴۰۰ تومان است.","سال 2026 سال خوبی است.","عدد منفی -5 را بخوان.",
      "می‌خواهم نیم‌فاصله درست خوانده شود.","این یک پرسش است؟","سلام، حال شما چطور است؟",
      "این متن کمی طولانی‌تر است تا آهنگ جمله و مکث میان بخش‌ها بررسی شود و رفتار مدل در جمله متوسط مشخص باشد.",
      "الف، ب، پ، ت، ث، ج، چ، ح، خ، د، ذ، ر، ز، ژ، س و ش.",
      "کد تایید ۸۸۹۹۱۱۰۰ است.","شماره ثابت ۰۲۱-۸۸۸۰۳۳۵۴ را بخوان.",
      "ABC در کنار متن فارسی قرار دارد.","واژهٔ آزمایشی با نشانه درصد 50٪.",
      "«این نقل قول گیومه دارد»","این متن شامل نماد € است."
    ]
    result={"endpoint":"https://abreza-mana-tts.hf.space/","sentences":sentences,"attempted":False,
            "success_count":0,"error":None,"records":[]}
    try:
        from gradio_client import Client
        client=Client("https://abreza-mana-tts.hf.space/",verbose=False)
        result["attempted"]=True
        try:
            api=client.view_api(all_endpoints=True,print_info=False)
            result["api"]=str(api)
        except Exception as e:
            result["api_error"]=repr(e)
        # Try the first endpoint signatures commonly exposed by this Space; stop on quota/access failure.
        for i,text in enumerate(sentences):
            try:
                prediction=None
                last=None
                for api_name in ["/generate_speech","/synthesize","/predict"]:
                    try:
                        prediction=client.predict(text,api_name=api_name)
                        last=None
                        break
                    except Exception as e:
                        last=e
                if prediction is None:
                    raise last if last else RuntimeError("no callable endpoint")
                rec={"index":i,"text":text,"result":str(prediction)}
                result["records"].append(rec); result["success_count"]+=1
            except Exception as e:
                result["records"].append({"index":i,"text":text,"error":repr(e)})
                msg=repr(e).lower()
                if "quota" in msg or "gpu" in msg or "rate" in msg:
                    result["error"]="quota_or_gpu_gate"
                    break
    except Exception as e:
        result["error"]=repr(e)
    write_json(out/"p0-11-hosted-attempt.json",result)
    return result

def licenses(out):
    text="""# License fact sheet

- ManaTTS dataset: CC0-1.0 (Hugging Face dataset metadata/card).
- Persian-MultiSpeaker-Tacotron2 / RTVC-derived implementation: MIT (repository LICENSE/README).
- ParallelWaveGAN code: MIT.
- VCTK-derived HiFi-GAN checkpoint: model code/checkpoint distributed by ParallelWaveGAN; underlying VCTK corpus requires attribution. v1 project scope is personal-device/no redistribution, so this is recorded as a fact sheet rather than a Phase 0-5 redistribution gate.
"""
    (out/"licenses.md").write_text(text,encoding="utf-8")

def summary(out,derived,speaker,vocoder,assets,versions,hosted):
    result={
      "checkpoint_dims_sha256":sha256_file(out/"checkpoint_dims.json"),
      "speaker_embedding_stable":speaker["byte_identical"],
      "speaker_embedding_sha256":speaker["embedding_sha256"],
      "speaker_concat_source_verified":derived["speaker_concat_source_verified"],
      "speaker_enters_once_dimensional_check":derived["speaker_enters_once_dimensional_check"],
      "vocoder_normalize_before_default":vocoder["normalize_before_default"],
      "vocoder_stats_present":vocoder["stats_files_present"],
      "asset_hashes":{k:v["sha256"] for k,v in assets["assets"].items()},
      "environment_versions":versions,
      "hosted_success_count":hosted["success_count"],
      "hosted_error":hosted["error"]
    }
    write_json(out/"phase0-resume-summary.json",result)

def main():
    if len(sys.argv)!=4:
        raise SystemExit("usage: reference_forensics.py SPACE SYNTH OUT")
    space=Path(sys.argv[1]); synth=Path(sys.argv[2]); out=Path(sys.argv[3]); out.mkdir(parents=True,exist_ok=True)
    if sha256_file(synth)!=SYNTH_SHA256:
        raise SystemExit("synthesizer hash mismatch")
    if subprocess.check_output(["git","-C",str(space),"rev-parse","HEAD"],text=True).strip()!=SPACE_COMMIT:
        raise SystemExit("space commit mismatch")

    run_setup(space,synth)
    model,hp,symbols,derived=build_checkpoint_dims(space,synth,out)
    symbols,mapping=symbol_reconciliation(space,out)
    frontend_capture(space,symbols,mapping,out)
    speaker=speaker_probe(space,out)
    vocoder=vocoder_probe(space,out)
    assets=asset_probe(space,synth,out)
    versions=environment_probe(out)
    stop_probe(space,out)
    licenses(out)
    hosted=hosted_reference_attempt(out)
    summary(out,derived,speaker,vocoder,assets,versions,hosted)

    if not derived["num_chars_match"]:
        raise SystemExit("S1: num_chars mismatch")
    # v0.3 contract checks: checkpoint is authority.
    expected={
      "decoder_prenet_fc1_out":256,"decoder_prenet_fc2_out":256,
      "attn_rnn_input_size":768,"rnn_input_in_features":640,
      "stop_proj_in_features":1536,"mel_proj_out_features":1600,
      "num_chars_checkpoint":126,"decoder_r_after_load":2,"max_r":20
    }
    mism={k:{"expected":v,"actual":derived.get(k)} for k,v in expected.items() if derived.get(k)!=v}
    if mism:
        write_json(out/"STOP_S1_NEW_CONTRACT_MISMATCH.json",mism)
        raise SystemExit("S1: new checkpoint/contract mismatch")
    if not (derived["speaker_concat_source_verified"] and derived["speaker_enters_once_dimensional_check"]):
        (out/"STOP_S13.txt").write_text("S13 speaker embedding graph-boundary finding false\n",encoding="utf-8")
        raise SystemExit("S13")

if __name__=="__main__":
    main()
