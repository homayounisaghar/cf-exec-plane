from __future__ import annotations
import json, os, time
from openai import OpenAI

def get_client(key_env="GROQ_API_KEY"):
    key=os.environ.get(key_env,"").strip()
    if not key and key_env!="GROQ_API_KEY":
        key=os.environ.get("GROQ_API_KEY","").strip()
    if not key:
        raise SystemExit(f"{key_env} missing")
    return OpenAI(api_key=key,base_url="https://api.groq.com/openai/v1",timeout=120,max_retries=8)

def parse_json(s):
    s=(s or "").strip()
    if s.startswith("```"):
        lines=s.splitlines()
        if lines and lines[0].startswith("```"): lines=lines[1:]
        if lines and lines[-1].strip()=="```": lines=lines[:-1]
        s="\n".join(lines).strip()
    try: return json.loads(s)
    except Exception:
        a=s.find("{"); b=s.rfind("}")
        if a>=0 and b>a: return json.loads(s[a:b+1])
        raise

def chat_json(client,model,system,user,temperature=0,max_tokens=14000):
    last=None
    for attempt in range(4):
        try:
            r=client.chat.completions.create(
                model=model,
                messages=[{"role":"system","content":system},{"role":"user","content":user}],
                temperature=temperature,
                max_completion_tokens=max_tokens,
                response_format={"type":"json_object"},
            )
            content=r.choices[0].message.content
            return parse_json(content), (r.usage.model_dump() if getattr(r,"usage",None) else {})
        except Exception as e:
            last=e
            if attempt==3: raise
            time.sleep(2+attempt*3)
    raise last

def read_jsonl(path):
    out=[]
    with open(path,encoding="utf-8") as f:
        for line in f:
            if line.strip(): out.append(json.loads(line))
    return out

def write_jsonl(path,rows):
    with open(path,"w",encoding="utf-8") as f:
        for r in rows: f.write(json.dumps(r,ensure_ascii=False,sort_keys=True,separators=(",",":"))+"\n")

def chunks(xs,n):
    for i in range(0,len(xs),n): yield xs[i:i+n]
