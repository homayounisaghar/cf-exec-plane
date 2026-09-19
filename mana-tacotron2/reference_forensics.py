#!/usr/bin/env python3
import hashlib, importlib.util, json, os, sys
from pathlib import Path

def sha256(p):
    h=hashlib.sha256()
    with open(p,"rb") as f:
        for b in iter(lambda:f.read(1024*1024),b""): h.update(b)
    return h.hexdigest()

def tree_hashes(root):
    root=Path(root); out={}
    for p in sorted(root.rglob("*")):
        if p.is_file() and ".git" not in p.parts:
            out[p.relative_to(root).as_posix()]={"sha256":sha256(p),"size":p.stat().st_size}
    return out

def load_module(path,name):
    spec=importlib.util.spec_from_file_location(name,path)
    m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m

def main():
    if len(sys.argv)!=5:
        raise SystemExit("usage: reference_forensics.py SPACE UPSTREAM SYNTH OUT")
    space, upstream, synth, out=map(Path,sys.argv[1:])
    out.mkdir(parents=True,exist_ok=True)

    sf=tree_hashes(space/"pmt2")
    uf=tree_hashes(upstream)
    paths=sorted(set(sf)|set(uf))
    rows=[]
    for p in paths:
        a=sf.get(p); b=uf.get(p)
        rows.append({
            "path":p,
            "space_sha256":a and a["sha256"],
            "upstream_sha256":b and b["sha256"],
            "space_size":a and a["size"],
            "upstream_size":b and b["size"],
            "equal":bool(a and b and a["sha256"]==b["sha256"]),
        })
    infer_prefixes=("encoder/","synthesizer/","vocoder/")
    infer_diffs=[r for r in rows if not r["equal"] and (r["path"]=="inference.py" or r["path"].startswith(infer_prefixes))]

    sys.path.insert(0,str(space/"pmt2"))
    symbols_mod=load_module(space/"pmt2/synthesizer/persian_utils/symbols.py","mana_symbols")
    symbols=list(symbols_mod.symbols)
    mapping={s:i for i,s in enumerate(symbols)}
    occ={}
    for i,s in enumerate(symbols): occ.setdefault(s,[]).append(i)
    duplicates={s:v for s,v in occ.items() if len(v)>1}
    sym_payload={"symbols":symbols,"symbol_to_id":mapping,"duplicates":duplicates}
    sym_text=json.dumps(sym_payload,ensure_ascii=False,sort_keys=True,separators=(",",":"))
    (out/"symbol_table.json").write_text(sym_text,encoding="utf-8")

    import torch
    hparams_mod=load_module(space/"pmt2/synthesizer/hparams.py","mana_hparams")
    hp=hparams_mod.hparams
    tac_mod=load_module(space/"pmt2/synthesizer/models/tacotron.py","mana_tacotron")
    Tacotron=tac_mod.Tacotron
    model=Tacotron(embed_dims=hp.tts_embed_dims,
        num_chars=len(symbols), encoder_dims=hp.tts_encoder_dims,
        decoder_dims=hp.tts_decoder_dims, n_mels=hp.num_mels,
        fft_bins=hp.num_mels, postnet_dims=hp.tts_postnet_dims,
        encoder_K=hp.tts_encoder_K, lstm_dims=hp.tts_lstm_dims,
        postnet_K=hp.tts_postnet_K, num_highways=hp.tts_num_highways,
        dropout=hp.tts_dropout, stop_threshold=hp.tts_stop_threshold,
        speaker_embedding_size=hp.speaker_embedding_size)
    r_before=int(model.decoder.r.item())
    model.load(synth)
    model.eval()
    r_after=int(model.decoder.r.item())
    st=model.state_dict()
    ck={
      "synthesizer_sha256":sha256(synth),
      "r_before_load":r_before,
      "r_after_load":r_after,
      "load_overwrote_r":r_before!=r_after,
      "prenet_fc1_out":model.decoder.prenet.fc1.out_features,
      "prenet_fc2_out":model.decoder.prenet.fc2.out_features,
      "attn_rnn_input_size":model.decoder.attn_rnn.input_size,
      "rnn_input_in_features":model.decoder.rnn_input.in_features,
      "stop_proj_in_features":model.decoder.stop_proj.in_features,
      "mel_proj_out_features":model.decoder.mel_proj.out_features,
      "checkpoint_num_chars":int(model.encoder.embedding.weight.shape[0]),
      "symbols_len":len(symbols),
      "num_chars_match":int(model.encoder.embedding.weight.shape[0])==len(symbols),
      "checkpoint_step":int(st["step"].item()) if "step" in st else None,
      "decoder_r_in_state": "decoder.r" in st,
      "hparams":{
        "tts_embed_dims":hp.tts_embed_dims,"tts_encoder_dims":hp.tts_encoder_dims,
        "tts_decoder_dims":hp.tts_decoder_dims,"tts_lstm_dims":hp.tts_lstm_dims,
        "speaker_embedding_size":hp.speaker_embedding_size,"num_mels":hp.num_mels,
        "sample_rate":hp.sample_rate,"hop_size":hp.hop_size,
        "tts_dropout":hp.tts_dropout,"tts_stop_threshold":hp.tts_stop_threshold
      }
    }

    tac_src=(space/"pmt2/synthesizer/models/tacotron.py").read_text(encoding="utf-8")
    inf_src=(space/"pmt2/synthesizer/inference.py").read_text(encoding="utf-8")
    static={
      "space_pmt2_files":len(sf),"upstream_files":len(uf),
      "diff_count":sum(1 for r in rows if not r["equal"]),
      "inference_diff_count":len(infer_diffs),
      "inference_diffs":infer_diffs,
      "symbol_table_sha256":hashlib.sha256(sym_text.encode("utf-8")).hexdigest(),
      "symbols_len":len(symbols),"duplicates":duplicates,
      "persian_cleaners_module_exists":any(p.name in ("cleaner.py","cleaners.py") for p in (space/"pmt2/synthesizer/persian_utils").iterdir()),
      "stop_token_sigmoid":"torch.sigmoid(s)" in tac_src,
      "stop_threshold_half":"stop_tokens > 0.5" in tac_src,
      "stop_t_gt_10":"t > 10" in tac_src,
      "trim_threshold_in_inference":"tts_stop_threshold" in inf_src,
      "encoder_prenet_is_same_stochastic_prenet": "self.pre_net = PreNet" in tac_src and "training=True" in tac_src
    }
    (out/"p0-2-diff.json").write_text(json.dumps({"rows":rows,"summary":static},ensure_ascii=False,indent=2),encoding="utf-8")
    (out/"p0-5-checkpoint.json").write_text(json.dumps(ck,ensure_ascii=False,indent=2),encoding="utf-8")

    md=[
      "# Mana Phase 0 forensics result",
      "",
      f"- pmt2 file differences: {static['diff_count']} total; {static['inference_diff_count']} inference-path.",
      f"- symbols: {len(symbols)}; table SHA-256 \`{static['symbol_table_sha256']}\`.",
      f"- duplicates: \`{json.dumps(duplicates,ensure_ascii=False)}\`.",
      f"- synthesizer SHA-256: \`{ck['synthesizer_sha256']}\`.",
      f"- decoder.r: before load {r_before}; after load {r_after}; overwritten={ck['load_overwrote_r']}.",
      f"- prenet fc1/fc2: {ck['prenet_fc1_out']}/{ck['prenet_fc2_out']}.",
      f"- attn_rnn input: {ck['attn_rnn_input_size']}; rnn_input: {ck['rnn_input_in_features']}; stop_proj: {ck['stop_proj_in_features']}; mel_proj: {ck['mel_proj_out_features']}.",
      f"- checkpoint num_chars: {ck['checkpoint_num_chars']}; symbols len: {len(symbols)}; match={ck['num_chars_match']}.",
      f"- checkpoint step: {ck['checkpoint_step']}.",
      f"- encoder uses the same stochastic PreNet class: {static['encoder_prenet_is_same_stochastic_prenet']}.",
      "",
      "## Inference-path differing files"
    ]
    md += [f"- {x['path']}" for x in infer_diffs] or ["- none"]
    (out/"phase0-forensics.md").write_text("\n".join(md)+"\n",encoding="utf-8")

    # Hard machine-readable stop signal for owner directive S1.
    if not ck["num_chars_match"]:
        (out/"STOP_S1.txt").write_text("S1 num_chars != len(symbols)\n",encoding="utf-8")
    expected_contract={"prenet_fc1_out":256,"prenet_fc2_out":128}
    contract_mismatch={k:{"expected":v,"actual":ck[k]} for k,v in expected_contract.items() if ck[k]!=v}
    if contract_mismatch:
        (out/"CONTRACT_MISMATCH.json").write_text(json.dumps(contract_mismatch,indent=2),encoding="utf-8")

if __name__=="__main__": main()
