from __future__ import annotations
import argparse, json
from llm_client import get_client

GENERATOR_PREFS=["openai/gpt-oss-120b"]
JUDGE_PREFS=["openai/gpt-oss-20b"]

def main():
    p=argparse.ArgumentParser(); p.add_argument("--github-env",required=True); p.add_argument("--report",required=True); a=p.parse_args()
    client=get_client("GROQ_API_KEY")
    ids=sorted({m.id for m in client.models.list().data})
    gen=next((m for m in GENERATOR_PREFS if m in ids),None)
    judge=next((m for m in JUDGE_PREFS if m in ids and m!=gen),None)
    ok=bool(gen and judge and gen!=judge)
    report={
      "available_model_ids":ids,
      "generator_preferences":GENERATOR_PREFS,
      "judge_preferences":JUDGE_PREFS,
      "selected_generator":gen,
      "selected_judge_a":judge,
      "selected_judge_b":judge,
      "generator_distinct_from_judges":ok,
      "judge_independence":"separate calls with distinct A/B role prompts; same judge model id",
      "rationale":"Matches V20 design requirement that semantic judges use model ids different from generator; avoids Qwen 1000 OTPM bottleneck."
    }
    open(a.report,"w",encoding="utf-8").write(json.dumps(report,ensure_ascii=False,indent=2))
    if not ok: raise SystemExit("No generator/judge-separated model pair available")
    with open(a.github_env,"a",encoding="utf-8") as f:
        f.write(f"GENERATOR_MODEL={gen}\nJUDGE_MODEL_A={judge}\nJUDGE_MODEL_B={judge}\n")
    print(json.dumps({"generator":gen,"judge_a":judge,"judge_b":judge,"available_count":len(ids)}))

if __name__=="__main__": main()
