from __future__ import annotations
import argparse, json
from llm_client import get_client

GENERATOR_PREFS=["qwen/qwen3.8-27b"]
JUDGE_A_PREFS=["openai/gpt-oss-20b"]
JUDGE_B_PREFS=["openai/gpt-oss-120b"]

def pick(prefs,ids,forbidden):
    return next((m for m in prefs if m in ids and m not in forbidden),None)

def main():
    p=argparse.ArgumentParser(); p.add_argument("--github-env",required=True); p.add_argument("--report",required=True); a=p.parse_args()
    client=get_client("GROQ_API_KEY")
    ids=sorted({m.id for m in client.models.list().data})
    gen=pick(GENERATOR_PREFS,ids,set())
    ja=pick(JUDGE_A_PREFS,ids,{gen})
    jb=pick(JUDGE_B_PREFS,ids,{gen,ja})
    ok=bool(gen and ja and jb and len({gen,ja,jb})==3)
    report={"available_model_ids":ids,"generator_preferences":GENERATOR_PREFS,
            "judge_a_preferences":JUDGE_A_PREFS,"judge_b_preferences":JUDGE_B_PREFS,
            "selected_generator":gen,"selected_judge_a":ja,"selected_judge_b":jb,
            "three_distinct_model_ids":ok}
    open(a.report,"w",encoding="utf-8").write(json.dumps(report,ensure_ascii=False,indent=2))
    if not ok: raise SystemExit("No three-model generator/judge separation available")
    with open(a.github_env,"a",encoding="utf-8") as f:
        f.write(f"GENERATOR_MODEL={gen}\nJUDGE_MODEL_A={ja}\nJUDGE_MODEL_B={jb}\n")
    print(json.dumps({"generator":gen,"judge_a":ja,"judge_b":jb,"available_count":len(ids)}))

if __name__=="__main__": main()
