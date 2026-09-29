#!/usr/bin/env python3
"""Compile the Onshape feature-spec matrix on the VPS host.

Talks to the local Onshape execution service over its loopback MCP endpoint
(127.0.0.1:8788), which owns the authenticated browser session. The raw
feature-spec catalogue is never emitted; only the compiled classification index
is written, because the raw catalogue is too large to move through a chat or a
log surface.

Usage: build_feature_matrix.py <did> <wid> <eid> <outFile>
"""

import json
import sys
import urllib.request

TOKEN_FILE = "/etc/capability-fabric/secrets/mcp-token"
ENDPOINT = "http://127.0.0.1:8788/mcp/{token}"


def call(token, name, arguments):
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": name, "arguments": arguments},
    }
    req = urllib.request.Request(
        ENDPOINT.format(token=token),
        data=json.dumps(payload).encode(),
        headers={
            "content-type": "application/json",
            "accept": "application/json, text/event-stream",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=900) as res:
        raw = res.read().decode()

    # Streamable HTTP transport may answer as JSON or as SSE.
    if raw.lstrip().startswith("{"):
        msg = json.loads(raw)
    else:
        msg = None
        for line in raw.splitlines():
            if line.startswith("data:"):
                candidate = json.loads(line[5:].strip())
                if "result" in candidate or "error" in candidate:
                    msg = candidate
        if msg is None:
            raise SystemExit("no JSON-RPC payload in transport response")

    if "error" in msg:
        raise SystemExit(f"jsonrpc error: {msg['error']}")
    text = msg["result"]["content"][0]["text"]
    return json.loads(text)


def unwrap(node):
    """Onshape spec nodes are BT-typed envelopes with a `message` payload."""
    while isinstance(node, dict) and "message" in node and isinstance(node["message"], dict):
        node = node["message"]
    return node


def classify(params):
    if len(params) <= 1:
        return "F1"
    nested = any(
        isinstance(p.get("btType"), str)
        and any(k in p["btType"] for k in ("Enum", "Array", "ParameterArray", "Boolean"))
        and p.get("parameterId") not in (None, "")
        and isinstance(p.get("parameters"), list)
        for p in params
    )
    if nested:
        return "F3"
    return "F2" if len(params) <= 5 else "F3"


def main():
    if len(sys.argv) != 5:
        raise SystemExit("usage: build_feature_matrix.py <did> <wid> <eid> <outFile>")
    did, wid, eid, out_file = sys.argv[1:5]

    with open(TOKEN_FILE, encoding="utf8") as fh:
        token = fh.read().strip()

    envelope = call(
        token,
        "onshape_operation_execute",
        {
            "operation": "getPartStudioFeatureSpecs",
            "target": {"document_id": did, "workspace_id": wid, "element_id": eid},
            "request_id": "vps-feature-matrix-build",
        },
    )

    if envelope.get("status") == "FAILED":
        raise SystemExit(f"service error: {envelope.get('error')}")

    body = envelope["result"]["evidence"]["body"]
    specs = body.get("featureSpecs", body) if isinstance(body, dict) else body
    if not isinstance(specs, list):
        raise SystemExit(f"unexpected feature-spec shape: {type(specs).__name__}")

    index = []
    for spec in specs:
        node = unwrap(spec)
        feature_type = node.get("featureType") or node.get("featureName")
        if not feature_type:
            continue
        params = [unwrap(p) for p in (node.get("parameters") or [])]
        param_ids = [p.get("parameterId") for p in params if p.get("parameterId")]
        index.append({
            "featureType": feature_type,
            "class": classify(params),
            "parameterCount": len(params),
            "parameterIds": param_ids,
            "parameterTypes": {
                p["parameterId"]: p.get("btType", "")
                for p in params
                if p.get("parameterId")
            },
        })

    index.sort(key=lambda e: e["featureType"])
    counts = {}
    for entry in index:
        counts[entry["class"]] = counts.get(entry["class"], 0) + 1

    out = {
        "schema": "onshape.feature-matrix.v1",
        "buildId": envelope.get("build_id"),
        "featureTypeCount": len(index),
        "counts": counts,
        "index": index,
    }
    with open(out_file, "w", encoding="utf8") as fh:
        json.dump(out, fh, indent=1, sort_keys=False)

    print(f"ONSHAPE_FEATURE_MATRIX_TYPES={len(index)}")
    print(f"ONSHAPE_FEATURE_MATRIX_COUNTS={json.dumps(counts, sort_keys=True)}")


if __name__ == "__main__":
    main()
