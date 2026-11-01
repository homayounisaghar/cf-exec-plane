"""Provider-native, read-only projection of *visible* WeChat message rows.

No network, OCR, provider database or volatile message ID. Never synthesize
sender, direction, timestamps or completeness from an unseen UI element.
"""
import re

MESSAGES_NAMES = frozenset(("Messages", "\u6d88\u606f"))
TIME_SEPARATOR = re.compile(
    r"(?i)^(?:today|yesterday|monday|tuesday|wednesday|thursday|friday|"
    r"saturday|sunday|\u4eca\u5929|\u6628\u5929|"
    r"\d{1,2}:\d{2}(?:\s?[ap]m)?|"
    r"\d{4}[-/.]\d{1,2}[-/.]\d{1,2})"
    r"(?:\s+\d{1,2}:\d{2}(?:\s?[ap]m)?)?$"
)


def _visible(item):
    return {"visible", "showing"}.issubset(set(item.get("states") or []))


def _bounds(item):
    b=item.get("bounds") or {}
    try:
        x=int(b["x"]);y=int(b["y"])
        w=int(b["width"]);h=int(b["height"])
        return (x,y,w,h) if w>0 and h>0 else None
    except (ValueError, KeyError, TypeError):
        return None


def _direction(item, viewport):
    """Only when the *whole* accessible row fits clearly on one side."""
    b=_bounds(item);box=_bounds(viewport)
    if not b or not box or box[2]<420:
        return ("unknown","no_spatial_evidence")
    x,_,w,_=b
    mid=box[0]+box[2]/2
    if x+w<mid-45:
        return ("incoming","native_row_wholly_left_of_midline")
    if x>mid+45:
        return ("outgoing","native_row_wholly_right_of_midline")
    return ("unknown","row_spans_or_crosses_midline")


def project_message_rows(rows,limit=10):
    if not isinstance(limit,int) or isinstance(limit,bool) or not 1<=limit<=50:
        raise ValueError("WECHAT_MESSAGE_LIMIT_INVALID")
    candidates=[r for r in rows if r.get("role")=="list" and
                str(r.get("name") or "") in MESSAGES_NAMES and _visible(r)]
    if len(candidates)!=1:
        raise ValueError("WECHAT_MESSAGES_VIEWPORT_NOT_UNIQUE")
    lst=candidates[0]
    path=str(lst.get("path") or "")
    if not path:
        raise ValueError("WECHAT_MESSAGES_VIEWPORT_PATH_MISSING")
    prefix=path+"/"
    depth=int(lst.get("depth",-1))+1
    items=[r for r in rows if r.get("role")=="list item" and
           r.get("depth")==depth and str(r.get("path") or "").startswith(prefix)
           and _visible(r)]
    # Accessibility paths and top-down UI geometry, never the order in which
    # the OS enumerates unrelated nodes.
    items.sort(key=lambda r:((_bounds(r) or (0,10**7,0,0))[1],
                             str(r.get("path") or "")))
    out=[];separator=None
    for r in items:
        raw=str(r.get("name") or "").strip()
        if not raw:
            continue
        if TIME_SEPARATOR.fullmatch(raw):
            separator=raw
            continue
        direction,why=_direction(r,lst)
        out.append({
            "body":raw[:1000],
            "body_may_be_truncated":len(raw)>=1000,
            "sender":None,
            "direction":direction,
            "direction_evidence":why,
            "time":None,
            "after_separator":separator,
            "source":"visible_native_accessibility_list_item",
        })
    result=out[-limit:]
    return {
        "scope":"bounded_visible_messages_only",
        "complete":False,
        "at_latest_edge_verified":False,
        "stable_message_ids":False,
        "sender_identity_verified":False,
        "messages":result,
        "visible_message_count":len(out),
        "returned":len(result),
        "truncated_to_limit":len(out)>limit,
        "observation_state":"ROWS_OBSERVED" if result else "NO_VISIBLE_MESSAGE_BODIES",
        "read_state_changed":False,
    }
