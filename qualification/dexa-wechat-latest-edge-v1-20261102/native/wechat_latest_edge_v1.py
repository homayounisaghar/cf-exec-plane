"""Evidence for the current latest text message in native WeChat UI.

Pure Python; no interaction, OCR, scrolling, or generated language.
Accept "latest edge" only when the selected chat preview and bottom-most
visible native message agree, and that message reaches the viewport bottom.
"""
import re
import unicodedata

from wechat_message_projection_v1 import TIME_SEPARATOR


def _shown(row):
    return {"showing", "visible"}.issubset(set(row.get("states") or ()))


def _box(row):
    box=row.get("bounds") or {}
    try:
        x,y,w,h=(int(box[k]) for k in ("x","y","width","height"))
        return (x,y,w,h) if w>0 and h>0 else None
    except (TypeError,ValueError,KeyError):
        return None


def _normalized(text):
    if not isinstance(text,str):
        return ""
    return re.sub(r"\s+","",unicodedata.normalize("NFKC",text)).strip()


def verify_latest_edge(rows,projection,selected_chat_previews):
    """Return bounded proof, never a guess. Never mutate either argument."""
    no=lambda reason: {"verified":False,"basis":"native_chat_preview_and_viewport",
                       "reason":reason}
    if not isinstance(rows,list) or not isinstance(projection,dict):
        return no("NATIVE_SNAPSHOT_UNAVAILABLE")
    if not isinstance(selected_chat_previews,list) or len(selected_chat_previews)!=1:
        return no("SELECTED_CHAT_NOT_UNIQUE")
    messages=projection.get("messages")
    if not isinstance(messages,list) or not messages or not isinstance(messages[-1],dict):
        return no("NO_VISIBLE_TEXT_MESSAGE")
    body=_normalized(messages[-1].get("body"))
    preview=_normalized(selected_chat_previews[0]).rstrip(".…")
    if len(preview)<16 or len(body)<16:
        return no("PREVIEW_TOO_SHORT_OR_UNAVAILABLE")
    # WeChat's chat preview is truncated in the UI. Compare only the
    # leading 48 normalized characters; do not assume sender metadata.
    if not body.startswith(preview[:48]):
        return no("LAST_VISIBLE_MESSAGE_DIFFERS_FROM_CHAT_PREVIEW")
    viewport=[r for r in rows if r.get("role")=="list" and
              str(r.get("name") or "") in ("Messages","消息") and _shown(r)]
    if len(viewport)!=1:
        return no("MESSAGE_VIEWPORT_NOT_UNIQUE")
    pane=viewport[0]; box=_box(pane)
    if not box:
        return no("MESSAGE_VIEWPORT_BOUNDS_UNAVAILABLE")
    parent=str(pane.get("path") or "")+"/"
    children=[r for r in rows if r.get("role")=="list item" and
              r.get("depth")==int(pane.get("depth",-1))+1 and
              str(r.get("path") or "").startswith(parent) and _shown(r) and
              _box(r) and str(r.get("name") or "").strip() and
              not TIME_SEPARATOR.fullmatch(str(r.get("name") or "").strip())]
    if not children:
        return no("MESSAGE_ROW_BOUNDS_UNAVAILABLE")
    children.sort(key=lambda r:(_box(r)[1],str(r.get("path") or "")))
    last=children[-1]; rb=_box(last)
    if not _normalized(str(last.get("name") or "")[:1000])==body:
        return no("VISIBLE_LAST_ROW_NOT_THE_RETURNED_MESSAGE")
    if rb[1]<box[1] or abs((rb[1]+rb[3])-(box[1]+box[3]))>6:
        return no("VISIBLE_LAST_ROW_NOT_AT_VIEWPORT_END")
    return {"verified":True,"basis":"native_chat_preview_and_viewport",
            "selected_chat_unique":True,"preview_matches_last_visible_body":True,
            "bottom_row_at_viewport_end":True}
