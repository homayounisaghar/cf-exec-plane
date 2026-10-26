#!/usr/bin/env python3
import json,sys
from pathlib import Path
target=Path(sys.argv[1]);delta=Path(sys.argv[2])
base=json.loads(target.read_text())
d=json.loads(delta.read_text())
assert base["schema"]=="dexa.connector-schemas.v1"
assert len(base["cf"])==188
assert d["removed"]==["telegram_transcribe"]
assert set(d["updated"])=={"audio_transcribe","audio_upload","telegram_reaction_get"}
assert set(d["updated"]).issubset(base["cf"])
assert "telegram_transcribe" in base["cf"]
base["cf"].pop("telegram_transcribe")
base["cf"].update(d["updated"])
assert len(base["cf"])==187
assert set(base["cf"]["audio_transcribe"]["inputSchema"]["properties"])=={"files","batch_id"}
assert "speed_factor" not in base["cf"]["telegram_reaction_get"]["inputSchema"]["properties"]
target.write_text(json.dumps(base,ensure_ascii=False,separators=(",",":"))+"\n")
print("EXACT_CF_SCHEMA_DELTA_APPLIED",len(base["cf"]))
