from __future__ import annotations
import argparse, json, os
from llm_client import get_client

GENERATOR_PREFS=[
    "allam-2-7b",
]
JUDGE_PREFS=[
    "openai/gpt-oss-20b",
]

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--github-env",required=True)
    p.add_argument("--report",required=True)
    a=p.parse_args()
    client=get_client("GROQ_API_KEY")
    ids=sorted({m.id for m in client.models.list().data})
    judge=next((m for m in JUDGE_PREFS if m in ids),None)
    generator=next((m for m in GENERATOR_PREFS if m in ids and m!=judge),None)
    report={
        "available_model_ids":ids,
        "generator_preferences":GENERATOR_PREFS,
        "judge_preferences":JUDGE_PREFS,
        "selected_generator":generator,
        "selected_judge":judge,
        "independent_model_ids":bool(generator and judge and generator!=judge),
    }
    open(a.report,"w",encoding="utf-8").write(json.dumps(report,ensure_ascii=False,indent=2))
    if not report["independent_model_ids"]:
        raise SystemExit("No independent generator/judge model pair is available to this Groq key")
    with open(a.github_env,"a",encoding="utf-8") as f:
        f.write(f"GENERATOR_MODEL={generator}\n")
        f.write(f"JUDGE_MODEL={judge}\n")
    print(json.dumps({"selected_generator":generator,"selected_judge":judge,"available_count":len(ids)}))

if __name__=="__main__": main()
