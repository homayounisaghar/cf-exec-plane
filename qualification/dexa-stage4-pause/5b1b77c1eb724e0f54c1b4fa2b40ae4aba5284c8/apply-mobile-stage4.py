#!/usr/bin/env python3
"""Apply exactly the reviewed, secret-free Stage4 mobile allowlist delta.

This reads the PRIVATE source on the authorized owner VPS. Never copy source,
credential files, cookies, or private notes to the public execution plane.
"""
from pathlib import Path
import sys

if len(sys.argv) != 3:
    raise SystemExit("usage: apply-mobile.py PRIVATE_SOURCE OUTPUT")
source = Path(sys.argv[1])
output = Path(sys.argv[2])
old = (
    ' // Owner-authenticated, journal-only mission status; no control writes.\n'
    ' if(/^\\/api\\/missions\\/[0-9a-f-]{36}\\/status$/i.test(route)&&method==="GET")return true;'
)
new = old + (
    '\n // Stage 4: exact owner control POST only. The existing Basic gate and\n'
    ' // public-origin check run BEFORE this route; the Dexa main reusable\n'
    ' // owner-form token, controlVersion CAS and typed Rana checks run AFTER.\n'
    ' if(/^\\/api\\/missions\\/[0-9a-f-]{36}\\/control$/i.test(route)&&method==="POST")return true;'
)
data = source.read_text()
if data.count(old) != 1 or 'Stage 4: exact owner control POST only.' in data:
    raise SystemExit("MOBILE_POLICY_ANCHOR_CHANGED")
output.write_text(data.replace(old, new, 1))
output.chmod(0o600)
