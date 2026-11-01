"""Apply the minimal, byte-pinned latest-edge attestation change.

The original WeChat semantic helper is not reconstructed or regenerated.
Only one import and one post-projection call are inserted. No navigation,
scrolling, unread-state changes, or unrelated capabilities are changed.
"""
import hashlib
import sys
from pathlib import Path

BASELINE="acfc8660bafbdd1b1c7632cc835204628d1c6044d72ca60a729144fc1227f246"
CANDIDATE="c3f8ca64f7b322a40e0ea9d4a67a922185f362b36e8648e5c02d97b87b390e64"
IMPORT="from wechat_message_projection_v1 import project_message_rows\n"
PROJECTION="        projection=project_message_rows(after,limit)\n"
NEW_IMPORT=IMPORT+"from wechat_latest_edge_v1 import verify_latest_edge\n"
NEW_PROJECTION=(PROJECTION+
    '        edge=verify_latest_edge(after,projection,[r.get("preview") for r in exact])\n'+
    '        projection["at_latest_edge_verified"]=edge["verified"]\n'+
    '        projection["latest_edge_evidence"]=edge\n')


def patch(source):
    if not isinstance(source,bytes):
        raise TypeError("Expected original helper bytes")
    if hashlib.sha256(source).hexdigest()!=BASELINE:
        raise ValueError("LIVE_HELPER_BASELINE_MISMATCH")
    original=source.decode("utf-8")
    if original.count(IMPORT)!=1 or original.count(PROJECTION)!=1:
        raise ValueError("WECHAT_LATEST_EDGE_PATCH_ANCHOR_MISMATCH")
    result=original.replace(IMPORT,NEW_IMPORT).replace(PROJECTION,NEW_PROJECTION)
    candidate=result.encode("utf-8")
    if hashlib.sha256(candidate).hexdigest()!=CANDIDATE:
        raise ValueError("WECHAT_LATEST_EDGE_PATCH_CANDIDATE_MISMATCH")
    return candidate


def main():
    if len(sys.argv)!=3:
        raise SystemExit("Usage: apply_latest_edge_v1.py input_helper output_helper")
    src,dst=map(Path,sys.argv[1:])
    if src.resolve()==dst.resolve():
        raise ValueError("MUST_STAGE_AND_ATOMICALLY_INSTALL")
    if dst.exists():
        raise ValueError("OUTPUT_MUST_NOT_EXIST")
    dst.write_bytes(patch(src.read_bytes()))


if __name__=="__main__":
    main()
