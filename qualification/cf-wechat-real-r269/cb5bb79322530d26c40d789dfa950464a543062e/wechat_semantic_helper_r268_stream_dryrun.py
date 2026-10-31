#!/usr/bin/env python3
import json
import os
import subprocess
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer

import gi
gi.require_version("Atspi", "2.0")
from gi.repository import Atspi

HOST = "127.0.0.1"
PORT = int(os.environ.get("PCG_WECHAT_SEMANTIC_PORT", "9337"))
DISPLAY = os.environ.get("DISPLAY", ":97")
XAUTHORITY = os.environ.get("XAUTHORITY", "/var/lib/capability-fabric/pcg/wechat/Xauthority")
LOCK = threading.Lock()
MAX_NODES = 3000
MAX_DEPTH = 24

def safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default

def states(obj):
    out=[]
    for value in safe(lambda: obj.get_state_set().get_states(), []) or []:
        out.append(safe(lambda value=value: value.value_nick, str(value)))
    return out

def bounds(obj):
    try:
        ext=obj.get_extents(Atspi.CoordType.SCREEN)
        return {"x":int(ext.x),"y":int(ext.y),"width":int(ext.width),"height":int(ext.height)}
    except Exception:
        return None

def tree_rows():
    desktop=Atspi.get_desktop(0)
    stack=[]
    count=safe(lambda: desktop.get_child_count(),0) or 0
    for i in range(min(count,64)-1,-1,-1):
        child=safe(lambda i=i: desktop.get_child_at_index(i))
        if child is not None:
            stack.append((child,0,f"/{i}"))
    rows=[]
    while stack and len(rows)<MAX_NODES:
        obj,depth,path=stack.pop()
        name=safe(lambda: obj.get_name(),"") or ""
        role=safe(lambda: obj.get_role_name(),"") or ""
        st=states(obj)
        child_count=int(safe(lambda: obj.get_child_count(),0) or 0)
        text=None
        if role=="text":
            try:
                length=obj.get_character_count()
                text=obj.get_text(0,min(length,512)) if length else ""
            except Exception:
                text=None
        rows.append({
            "path":path,"depth":depth,"role":role,"name":name[:1000],
            "states":st,"child_count":child_count,"bounds":bounds(obj),"text":text,
        })
        if depth<MAX_DEPTH:
            for i in range(min(child_count,250)-1,-1,-1):
                child=safe(lambda i=i: obj.get_child_at_index(i))
                if child is not None:
                    stack.append((child,depth+1,f"{path}/{i}"))
    return rows

def visible(row):
    st=set(row.get("states") or [])
    return "showing" in st and "visible" in st

def parse_chat(row):
    lines=[x.strip() for x in str(row.get("name") or "").split("\n") if x.strip()]
    if not lines:
        return None
    name=lines[0]
    unread=0
    cursor=1
    preview_prefix=""
    if cursor<len(lines):
        import re
        m=re.match(r"^\[(\d{1,6})\](.*)$",lines[cursor])
        if m:
            unread=int(m.group(1))
            preview_prefix=m.group(2).strip()
            cursor+=1
    rest=lines[cursor:]
    muted="Mute Notifications" in rest
    stamp=None
    import re
    for item in reversed(rest):
        if re.match(r"^\d{1,2}:\d{2}$",item) or item.lower() in ("today","yesterday"):
            stamp=item
            break
    preview=[]
    if preview_prefix:
        preview.append(preview_prefix)
    for item in rest:
        if item=="Mute Notifications" or item==stamp:
            continue
        preview.append(item)
    return {
        "name":name[:256],
        "unread_count":unread,
        "has_unread":unread>0,
        "selected":"selected" in set(row.get("states") or []),
        "muted":muted,
        "timestamp":stamp,
        "preview":"\n".join(preview)[:1000] or None,
    }

def conversations(rows):
    lists=[r for r in rows if r.get("role")=="list" and r.get("name")=="Chats" and visible(r)]
    if len(lists)!=1:
        raise RuntimeError("WECHAT_CHATS_LIST_NOT_UNIQUE")
    base=lists[0]
    prefix=base["path"]+"/"
    depth=int(base["depth"])+1
    out=[]
    for row in rows:
        if row.get("role")=="list item" and int(row.get("depth",-1))==depth and str(row.get("path","")).startswith(prefix) and visible(row):
            parsed=parse_chat(row)
            if parsed:
                out.append(parsed)
    return out

def authenticated(rows):
    blockers={"Log In","Confirm on Phone","Scan to log in","Scan again"}
    names={str(r.get("name")) for r in rows if r.get("name") and visible(r)}
    if blockers & names:
        return False
    return any(r.get("role")=="list" and r.get("name")=="Chats" and visible(r) for r in rows)

def object_from_path(path):
    parts=[p for p in str(path or "").split("/") if p!=""]
    obj=Atspi.get_desktop(0)
    for raw in parts:
        try:
            idx=int(raw)
        except Exception:
            raise RuntimeError("WECHAT_ACCESSIBILITY_PATH_INVALID")
        obj=safe(lambda obj=obj,idx=idx: obj.get_child_at_index(idx))
        if obj is None:
            raise RuntimeError("WECHAT_ACCESSIBILITY_PATH_UNRESOLVED")
    return obj

def main_wechat_frame_row(rows=None):
    rows=rows if rows is not None else tree_rows()
    chats=[r for r in rows if r.get("role")=="list" and r.get("name")=="Chats" and visible(r)]
    if len(chats)!=1:
        raise RuntimeError("WECHAT_CHATS_LIST_NOT_UNIQUE")
    chat_path=str(chats[0].get("path") or "")
    frames=[
        r for r in rows
        if r.get("role")=="frame" and r.get("name")=="WeChat" and visible(r)
        and chat_path.startswith(str(r.get("path") or "")+"/")
        and int((r.get("bounds") or {}).get("width",0))>=700
        and int((r.get("bounds") or {}).get("height",0))>=500
    ]
    if len(frames)!=1:
        raise RuntimeError("WECHAT_MAIN_FRAME_NOT_UNIQUE")
    return frames[0]

def find_search_object():
    rows=tree_rows()
    frame=main_wechat_frame_row(rows)
    prefix=str(frame.get("path") or "")+"/"
    matches=[
        r for r in rows
        if r.get("role")=="text" and r.get("name")=="Search" and visible(r)
        and "editable" in set(r.get("states") or [])
        and str(r.get("path") or "").startswith(prefix)
    ]
    if len(matches)!=1:
        raise RuntimeError("WECHAT_SEARCH_FIELD_NOT_UNIQUE")
    return object_from_path(matches[0].get("path"))

def search_probe(query):
    if not isinstance(query,str) or not query.strip() or len(query)>128:
        raise RuntimeError("WECHAT_SEARCH_QUERY_INVALID")
    with LOCK:
        before=tree_rows()
        if not authenticated(before):
            raise RuntimeError("WECHAT_LOGIN_REQUIRED")
        field=find_search_object()
        old=""
        try:
            old=field.get_text(0,field.get_character_count()) or ""
        except Exception:
            old=""
        try:
            field.set_text_contents(query.strip())
            time.sleep(1.0)
            after=tree_rows()
            candidates=[]
            for row in after:
                if not visible(row):
                    continue
                if row.get("role") in ("list item","label","text") and row.get("name"):
                    candidates.append({
                        "role":row["role"],"name":row["name"][:1000],
                        "path":row["path"],"bounds":row["bounds"],
                    })
            return {"query":query.strip(),"results":candidates[:300],"node_count":len(after)}
        finally:
            try:
                field=find_search_object()
                field.set_text_contents(old)
                time.sleep(0.4)
            except Exception:
                pass

def chat_rows(rows):
    lists=[r for r in rows if r.get("role")=="list" and r.get("name")=="Chats" and visible(r)]
    if len(lists)!=1:
        raise RuntimeError("WECHAT_CHATS_LIST_NOT_UNIQUE")
    base=lists[0]
    prefix=base["path"]+"/"
    depth=int(base["depth"])+1
    return [
        row for row in rows
        if row.get("role")=="list item"
        and int(row.get("depth",-1))==depth
        and str(row.get("path","")).startswith(prefix)
        and visible(row)
    ]

def exact_chat_row(rows,target):
    matches=[]
    for row in chat_rows(rows):
        parsed=parse_chat(row)
        if parsed and parsed.get("name")==target:
            matches.append((row,parsed))
    if not matches:
        raise RuntimeError("WECHAT_TARGET_NOT_FOUND")
    if len(matches)!=1:
        raise RuntimeError("WECHAT_TARGET_AMBIGUOUS")
    return matches[0]

def xdotool(*args):
    env={**os.environ,"DISPLAY":DISPLAY,"XAUTHORITY":XAUTHORITY}
    subprocess.run(["xdotool",*map(str,args)],env=env,check=True,timeout=5)

def xdotool_output(*args):
    env={**os.environ,"DISPLAY":DISPLAY,"XAUTHORITY":XAUTHORITY}
    return subprocess.check_output(["xdotool",*map(str,args)],env=env,timeout=5,text=True).strip()

def context_probe(target):
    if not isinstance(target,str) or not target.strip() or len(target)>256:
        raise RuntimeError("WECHAT_TARGET_INVALID")
    with LOCK:
        before=tree_rows()
        if not authenticated(before):
            raise RuntimeError("WECHAT_LOGIN_REQUIRED")
        row,parsed=exact_chat_row(before,target.strip())
        if not parsed.get("selected"):
            raise RuntimeError("WECHAT_CONTEXT_PROBE_REQUIRES_SELECTED_TARGET")
        b=row.get("bounds") or {}
        if int(b.get("width",0))<20 or int(b.get("height",0))<20:
            raise RuntimeError("WECHAT_TARGET_BOUNDS_INVALID")
        try:
            click_wechat_bounds(b,button=3)
            time.sleep(0.5)
            after=tree_rows()
            items=[]
            for item in after:
                if not visible(item) or not item.get("name"):
                    continue
                if item.get("role") in {"menu item","menu item checkbox","menu item radio","label","button"}:
                    items.append({
                        "role":item.get("role"),"name":str(item.get("name"))[:256],
                        "states":item.get("states"),"bounds":item.get("bounds"),
                    })
            return {"target":target.strip(),"items":items[:200]}
        finally:
            try:
                xdotool("key","Escape")
                time.sleep(0.2)
            except Exception:
                pass

def open_context_menu(target):
    rows=tree_rows()
    if not authenticated(rows):
        raise RuntimeError("WECHAT_LOGIN_REQUIRED")
    row,parsed=exact_chat_row(rows,target)
    b=row.get("bounds") or {}
    if int(b.get("width",0))<20 or int(b.get("height",0))<20:
        raise RuntimeError("WECHAT_TARGET_BOUNDS_INVALID")
    click_wechat_bounds(b,button=3)
    time.sleep(0.35)
    after=tree_rows()
    prompt="You won't be notified of any new messages after logging out. Log out?"
    if any(item.get("role")=="label" and item.get("name")==prompt and visible(item) for item in after):
        try:
            dismiss_logout_confirmation()
        finally:
            raise RuntimeError("WECHAT_CONTEXT_MENU_UNEXPECTED_LOGOUT_MODAL")
    items=[]
    for item in after:
        if item.get("role")!="menu item" or not item.get("name") or not visible(item):
            continue
        ib=item.get("bounds") or {}
        if int(ib.get("width",0))<20 or int(ib.get("height",0))<15:
            continue
        items.append(item)
    return row,parsed,items

def click_menu_item(items,label):
    matches=[item for item in items if item.get("name")==label]
    if len(matches)!=1:
        raise RuntimeError("WECHAT_MENU_ITEM_NOT_UNIQUE_" + label.replace(" ","_").upper())
    b=matches[0].get("bounds") or {}
    click_wechat_bounds(b)

def conversation_action(target,action,desired=None,dry_run=False,confirm_irreversible=False):
    if not isinstance(target,str) or not target.strip() or len(target)>256:
        raise RuntimeError("WECHAT_TARGET_INVALID")
    if action not in {"mark_read","mark_unread","mute","pin","delete"}:
        raise RuntimeError("WECHAT_CONVERSATION_ACTION_INVALID")
    attempt_id=uuid.uuid4().hex
    with LOCK:
        _,parsed,items=open_context_menu(target.strip())
        labels=[str(item.get("name")) for item in items]
        try:
            if action=="mark_read":
                if "Mark as Read" not in labels:
                    if "Mark as Unread" in labels:
                        return {"state":"ALREADY","provider":"wechat","target":target.strip(),"action":action,"effect_performed":False}
                    raise RuntimeError("WECHAT_MARK_READ_UNAVAILABLE")
                label="Mark as Read"
            elif action=="mark_unread":
                if "Mark as Unread" not in labels:
                    if "Mark as Read" in labels:
                        return {"state":"ALREADY","provider":"wechat","target":target.strip(),"action":action,"effect_performed":False}
                    raise RuntimeError("WECHAT_MARK_UNREAD_UNAVAILABLE")
                label="Mark as Unread"
            elif action=="mute":
                if not isinstance(desired,bool):
                    raise RuntimeError("WECHAT_MUTE_DESIRED_REQUIRED")
                if desired:
                    if "Unmute Notifications" in labels:
                        return {"state":"ALREADY","provider":"wechat","target":target.strip(),"action":action,"muted":True,"effect_performed":False}
                    label="Mute Notifications"
                else:
                    if "Mute Notifications" in labels:
                        return {"state":"ALREADY","provider":"wechat","target":target.strip(),"action":action,"muted":False,"effect_performed":False}
                    label="Unmute Notifications"
                if label not in labels:
                    raise RuntimeError("WECHAT_MUTE_ACTION_UNAVAILABLE")
            elif action=="pin":
                if not isinstance(desired,bool):
                    raise RuntimeError("WECHAT_PIN_DESIRED_REQUIRED")
                if desired:
                    if "Unpin" in labels:
                        return {"state":"ALREADY","provider":"wechat","target":target.strip(),"action":action,"pinned":True,"effect_performed":False}
                    label="Pin"
                else:
                    if "Pin" in labels:
                        return {"state":"ALREADY","provider":"wechat","target":target.strip(),"action":action,"pinned":False,"effect_performed":False}
                    label="Unpin"
                if label not in labels:
                    raise RuntimeError("WECHAT_PIN_ACTION_UNAVAILABLE")
            else:
                label="Delete"
                if label not in labels:
                    raise RuntimeError("WECHAT_DELETE_UNAVAILABLE")
                if not confirm_irreversible:
                    return {
                        "state":"CONFIRMATION_REQUIRED","provider":"wechat","target":target.strip(),
                        "action":action,"effect_performed":False,"confirmation_field":"confirm_irreversible",
                    }
                raise RuntimeError("WECHAT_DELETE_CONFIRMATION_UI_UNQUALIFIED")

            if dry_run:
                return {
                    "state":"DRY_RUN_READY","provider":"wechat","target":target.strip(),
                    "action":action,"menu_label":label,"effect_performed":False,
                    "provider_visible_state_changed":False,
                }

            click_menu_item(items,label)
            time.sleep(0.5)
            return {
                "state":"ACKNOWLEDGED_UNVERIFIED","provider":"wechat","attempt_id":attempt_id,
                "target":target.strip(),"action":action,"provider_confirmed":False,
                "provider_fresh":False,"verification_source":"same_runtime_ui_only",
                "effect_may_have_occurred":True,"blind_retry_safe":False,
            }
        finally:
            try:
                xdotool("key","Escape")
            except Exception:
                pass

def accessible_objects():
    desktop=Atspi.get_desktop(0)
    stack=[]
    for i in range(safe(lambda: desktop.get_child_count(),0)-1,-1,-1):
        child=safe(lambda i=i: desktop.get_child_at_index(i))
        if child is not None:
            stack.append((child,0))
    out=[]
    seen=0
    while stack and seen<MAX_NODES:
        obj,depth=stack.pop(); seen+=1
        out.append(obj)
        count=int(safe(lambda: obj.get_child_count(),0) or 0)
        if depth<MAX_DEPTH:
            for i in range(min(count,250)-1,-1,-1):
                child=safe(lambda i=i: obj.get_child_at_index(i))
                if child is not None:
                    stack.append((child,depth+1))
    return out

def find_visible_button_exact(name):
    matches=[]
    for obj in accessible_objects():
        role=safe(lambda obj=obj: obj.get_role_name(),"") or ""
        obj_name=safe(lambda obj=obj: obj.get_name(),"") or ""
        st=set(states(obj))
        b=bounds(obj) or {}
        if role=="button" and obj_name==name and "showing" in st and "visible" in st:
            if int(b.get("width",0))>=20 and int(b.get("height",0))>=20:
                matches.append(obj)
    if len(matches)!=1:
        raise RuntimeError("WECHAT_BUTTON_NOT_UNIQUE_" + name.replace(" ","_").upper())
    return matches[0]

def visible_wechat_frame():
    return main_wechat_frame_row(tree_rows())

def largest_wechat_window():
    wins=[x.strip() for x in xdotool_output("search","--onlyvisible","--class","wechat").splitlines() if x.strip()]
    ranked=[]
    for wid in wins:
        try:
            raw=xdotool_output("getwindowgeometry","--shell",wid)
            vals={}
            for line in raw.splitlines():
                if "=" in line:
                    k,v=line.split("=",1)
                    vals[k.strip()]=v.strip()
            w=int(vals.get("WIDTH","0")); h=int(vals.get("HEIGHT","0"))
            x=int(vals.get("X","0")); y=int(vals.get("Y","0"))
            if w>0 and h>0:
                ranked.append((w*h,w,h,x,y,wid))
        except Exception:
            continue
    if not ranked:
        raise RuntimeError("WECHAT_WINDOW_NOT_FOUND")
    ranked.sort(reverse=True)
    return ranked[0]

def click_wechat_bounds(b,button=1):
    if int(b.get("width",0))<20 or int(b.get("height",0))<15:
        raise RuntimeError("WECHAT_OBJECT_BOUNDS_INVALID")
    frame=visible_wechat_frame()
    fb=frame.get("bounds") or {}
    _,ww,wh,wx,wy,wid=largest_wechat_window()
    if ww<700 or wh<500:
        raise RuntimeError("WECHAT_MAIN_WINDOW_GEOMETRY_INVALID")
    logical_w=int(fb.get("width",0)); logical_h=int(fb.get("height",0))
    logical_x=int(b["x"])+int(b["width"])//2-int(fb["x"])
    logical_y=int(b["y"])+int(b["height"])//2-int(fb["y"])
    if logical_w<700 or logical_h<500 or logical_x<0 or logical_y<0 or logical_x>logical_w or logical_y>logical_h:
        raise RuntimeError("WECHAT_OBJECT_OUTSIDE_FRAME")
    relx=round(logical_x*ww/logical_w)
    rely=round(logical_y*wh/logical_h)
    if relx<0 or rely<0 or relx>ww or rely>wh:
        raise RuntimeError("WECHAT_OBJECT_OUTSIDE_WINDOW")
    xdotool("mousemove","--window",wid,relx,rely,"click",str(int(button)))

def activate_object(obj):
    b=bounds(obj) or {}
    role=safe(lambda: obj.get_role_name(),"") or ""
    if role in {"button","menu item","menu item checkbox","menu item radio"}:
        click_wechat_bounds(b)
        return
    focused=False
    try:
        focused=bool(obj.get_component_iface().grab_focus())
    except Exception:
        focused=False
    if focused:
        return
    click_wechat_bounds(b)

SEARCH_CATEGORY_HEADERS={"Contacts","Group Chats","Chat History","More","Search WeChat ID","Internet search results"}

def trigger_search_query(query):
    field=find_search_object()
    try:
        click_wechat_bounds(bounds(field) or {})
    except Exception:
        try: field.get_component_iface().grab_focus()
        except Exception: pass
    try:
        field.set_text_contents(query.strip())
    except Exception:
        raise RuntimeError("WECHAT_SEARCH_SET_FAILED")
    try:
        click_wechat_bounds(bounds(field) or {})
    except Exception:
        try: field.get_component_iface().grab_focus()
        except Exception: pass
    try:
        xdotool("key","End","space","BackSpace")
    except Exception:
        pass
    time.sleep(1.2)

def parse_search_results(rows):
    raw=[]
    for row in rows:
        if row.get("role")!="list item" or not row.get("name") or not visible(row):
            continue
        st=set(row.get("states") or [])
        b=row.get("bounds") or {}
        if "transient" not in st:
            continue
        if int(b.get("x",0))<320 or int(b.get("width",0))<300:
            continue
        raw.append(row)
    raw.sort(key=lambda row:(int((row.get("bounds") or {}).get("y",0)), int((row.get("bounds") or {}).get("x",0))))
    category=None
    out=[]
    for row in raw:
        name=str(row.get("name") or "").strip()
        if name in SEARCH_CATEGORY_HEADERS:
            category=name
            continue
        out.append({
            "category":category or "Unknown",
            "name":name[:1000],
            "bounds":row.get("bounds"),
        })
    return out

def provider_search(query):
    if not isinstance(query,str) or not query.strip() or len(query)>128:
        raise RuntimeError("WECHAT_SEARCH_QUERY_INVALID")
    with LOCK:
        before=tree_rows()
        if not authenticated(before):
            raise RuntimeError("WECHAT_LOGIN_REQUIRED")
        if any("Log out?" in str(r.get("name","")) and visible(r) for r in before):
            raise RuntimeError("WECHAT_MODAL_BLOCKING_NAVIGATION")
        field=find_search_object()
        try:
            old=field.get_text(0,field.get_character_count()) or ""
        except Exception:
            old=""
        try:
            trigger_search_query(query)
            rows=tree_rows()
            return {
                "query":query.strip(),
                "results":parse_search_results(rows),
                "provider_visible_state_changed":False,
            }
        finally:
            try:
                field=find_search_object()
                field.set_text_contents(old)
                try: field.get_component_iface().grab_focus()
                except Exception: pass
                try: xdotool("key","Escape")
                except Exception: pass
                time.sleep(0.45)
            except Exception:
                pass

def select_target(target,allow_mark_read=False):
    rows=tree_rows()
    try:
        row,parsed=exact_chat_row(rows,target)
    except RuntimeError as exc:
        if str(exc)!="WECHAT_TARGET_NOT_FOUND":
            raise
        row=parsed=None
    if row is not None:
        if parsed.get("selected"):
            return {"target":target,"would_mark_read":False,"selected":True,"resolver":"visible_chat_row"}
        would_mark=bool(parsed.get("unread_count",0)>0)
        if would_mark and not allow_mark_read:
            raise RuntimeError("WECHAT_TARGET_SELECTION_WOULD_MARK_READ")
        b=row.get("bounds") or {}
        click_wechat_bounds(b)
        time.sleep(0.6)
        return {"target":target,"would_mark_read":would_mark,"selected":True,"resolver":"visible_chat_row"}
    if target=="File Transfer":
        try:
            xdotool("mousemove",430,520,"click","--repeat","120","--delay","20","4")
            time.sleep(0.6)
            row,parsed=exact_chat_row(tree_rows(),target)
            b=row.get("bounds") or {}
            click_wechat_bounds(b)
            time.sleep(0.5)
            return {"target":target,"would_mark_read":False,"selected":True,"resolver":"self_chat_scroll_top"}
        except Exception:
            pass
    if not allow_mark_read:
        raise RuntimeError("WECHAT_OFFSCREEN_TARGET_REQUIRES_ALLOW_MARK_READ")
    field=find_search_object()
    try:
        old=field.get_text(0,field.get_character_count()) or ""
    except Exception:
        old=""
    try:
        trigger_search_query(target)
        search_rows=tree_rows()
        results=parse_search_results(search_rows)
        matches=[r for r in results if r.get("name")==target and r.get("category") in {"Contacts","Group Chats"}]
        if not matches:
            raise RuntimeError("WECHAT_TARGET_NOT_FOUND")
        if len(matches)!=1:
            raise RuntimeError("WECHAT_TARGET_AMBIGUOUS")
        b=matches[0].get("bounds") or {}
        click_wechat_bounds(b)
        time.sleep(0.8)
    finally:
        try:
            field=find_search_object()
            field.set_text_contents(old)
            try: xdotool("key","Escape")
            except Exception: pass
            time.sleep(0.25)
        except Exception:
            pass
    after=tree_rows()
    header_ok=any(
        row.get("role")=="label" and str(row.get("name") or "").strip()==target and visible(row)
        and int((row.get("bounds") or {}).get("x",0))>=550
        for row in after
    )
    selected_ok=False
    try:
        _,sel=exact_chat_row(after,target)
        selected_ok=bool(sel.get("selected"))
    except Exception:
        selected_ok=False
    if not (header_ok or selected_ok):
        raise RuntimeError("WECHAT_TARGET_SELECTION_FAILED")
    return {
        "target":target,"would_mark_read":target!="File Transfer",
        "selected":True,"resolver":"provider_search_exact",
        "category":matches[0].get("category"),
    }

def navigation_probe(section,query=None):
    if section not in {"Contacts","Search"}:
        raise RuntimeError("WECHAT_NAV_SECTION_INVALID")
    if query is None:
        raise RuntimeError("WECHAT_SEARCH_QUERY_REQUIRED")
    value=provider_search(query)
    value["section"]=section
    value["items"]=[
        {
            "role":"list item",
            "name":item.get("name"),
            "states":["transient"],
            "bounds":item.get("bounds"),
            "child_count":0,
            "category":item.get("category"),
        }
        for item in value.pop("results",[])
    ]
    return value

def restore_main_view():
    with LOCK:
        rows=tree_rows()
        main=main_wechat_frame_row(rows)
        extras=[
            r for r in rows
            if r.get("role")=="frame" and r.get("name")=="WeChat" and visible(r)
            and r.get("path")!=main.get("path")
        ]
        if not extras:
            return {"state":"ALREADY_MAIN","extra_frames_closed":0,"effect_performed":False}
        active=[r for r in extras if "active" in set(r.get("states") or [])]
        attempts=0
        while extras and attempts<4:
            attempts+=1
            try:
                xdotool("key","ctrl+w")
            except Exception:
                try: xdotool("key","Escape")
                except Exception: pass
            time.sleep(0.5)
            rows=tree_rows()
            main=main_wechat_frame_row(rows)
            extras=[
                r for r in rows
                if r.get("role")=="frame" and r.get("name")=="WeChat" and visible(r)
                and r.get("path")!=main.get("path")
            ]
        if extras:
            raise RuntimeError("WECHAT_AUXILIARY_WINDOW_RESTORE_FAILED")
        return {"state":"RESTORED","extra_frames_closed":attempts,"effect_performed":False}

def find_composer():
    matches=[]
    for obj in accessible_objects():
        role=safe(lambda: obj.get_role_name(),"") or ""
        name=safe(lambda: obj.get_name(),"") or ""
        st=set(states(obj))
        b=bounds(obj) or {}
        if role=="text" and "editable" in st and "showing" in st and "visible" in st and name!="Search":
            if int(b.get("width",0))>=200 and int(b.get("height",0))>=30:
                matches.append(obj)
    if len(matches)!=1:
        raise RuntimeError("WECHAT_COMPOSER_NOT_UNIQUE")
    return matches[0]

def find_send_button(rows):
    matches=[]
    for row in rows:
        if row.get("role")=="button" and row.get("name")=="Send" and visible(row):
            b=row.get("bounds") or {}
            if int(b.get("width",0))>=20 and int(b.get("height",0))>=15:
                matches.append(row)
    if len(matches)!=1:
        raise RuntimeError("WECHAT_SEND_BUTTON_NOT_UNIQUE")
    return matches[0]

def send_text(target,text,allow_mark_read=False,dry_run=False):
    if not isinstance(target,str) or not target.strip() or len(target)>256:
        raise RuntimeError("WECHAT_TARGET_INVALID")
    if not isinstance(text,str) or not text or len(text)>100000:
        raise RuntimeError("WECHAT_TEXT_INVALID")
    target=target.strip()
    attempt_id=uuid.uuid4().hex
    with LOCK:
        before=tree_rows()
        if not authenticated(before):
            raise RuntimeError("WECHAT_LOGIN_REQUIRED")
        visible_row=None
        visible_parsed=None
        try:
            visible_row,visible_parsed=exact_chat_row(before,target)
        except RuntimeError as exc:
            if str(exc)!="WECHAT_TARGET_NOT_FOUND":
                raise
        if dry_run:
            exact_count=None
            categories=[]
            if visible_row is None:
                field=find_search_object()
                try:
                    old=field.get_text(0,field.get_character_count()) or ""
                except Exception:
                    old=""
                try:
                    trigger_search_query(target)
                    results=parse_search_results(tree_rows())
                    exact=[r for r in results if r.get("name")==target and r.get("category") in {"Contacts","Group Chats"}]
                    exact_count=len(exact)
                    categories=sorted({str(r.get("category")) for r in exact})
                finally:
                    try:
                        field=find_search_object()
                        field.set_text_contents(old)
                        try: xdotool("key","Escape")
                        except Exception: pass
                        time.sleep(0.4)
                    except Exception:
                        pass
                if exact_count==0:
                    raise RuntimeError("WECHAT_TARGET_NOT_FOUND")
                if exact_count!=1:
                    raise RuntimeError("WECHAT_TARGET_AMBIGUOUS")
            would_mark_read=(
                bool(visible_parsed.get("unread_count",0)>0)
                if visible_parsed is not None
                else (False if target=="File Transfer" else None)
            )
            composer_ready=None
            composer_empty=None
            send_button_ready=None
            if visible_parsed is not None and visible_parsed.get("selected"):
                composer=find_composer()
                current=safe(lambda: composer.get_text(0,composer.get_character_count()),"") or ""
                composer_ready=True
                composer_empty=(current=="")
                send_button_ready=True
            return {
                "state":"DRY_RUN_READY","provider":"wechat","attempt_id":attempt_id,
                "target":target,"selected":bool(visible_parsed and visible_parsed.get("selected")),
                "would_select":not bool(visible_parsed and visible_parsed.get("selected")),
                "would_mark_read":would_mark_read,
                "target_resolution":"visible_chat_row" if visible_row is not None else "provider_search_exact",
                "provider_search_exact_count":exact_count,
                "provider_search_categories":categories,
                "composer_ready":composer_ready,"composer_empty":composer_empty,
                "send_button_ready":send_button_ready,"effect_performed":False,
            }

        selection=select_target(target,allow_mark_read=bool(allow_mark_read))
        composer=find_composer()
        current=safe(lambda: composer.get_text(0,composer.get_character_count()),"") or ""
        if current:
            raise RuntimeError("WECHAT_COMPOSER_NOT_EMPTY")
        clicked=False
        try:
            composer.set_text_contents(text)
            time.sleep(0.2)
            button=find_send_button(tree_rows())
            b=button.get("bounds") or {}
            click_wechat_bounds(b)
            clicked=True
            time.sleep(0.35)
            return {
                "state":"ACKNOWLEDGED_UNVERIFIED","provider":"wechat","attempt_id":attempt_id,
                "target":target,"provider_confirmed":False,"provider_fresh":False,
                "verification_source":"none","effect_may_have_occurred":True,
                "blind_retry_safe":False,
                "may_have_marked_read":bool(selection.get("would_mark_read")),
                "resolver":selection.get("resolver"),
            }
        except Exception:
            if clicked:
                return {
                    "state":"IN_DOUBT","provider":"wechat","attempt_id":attempt_id,
                    "target":target,"provider_confirmed":False,"provider_fresh":False,
                    "effect_may_have_occurred":True,"blind_retry_safe":False,
                }
            try:
                composer.set_text_contents("")
            except Exception:
                pass
            raise

def focus_and_activate_named_button(name):
    matches=[]
    for obj in accessible_objects():
        role=safe(lambda obj=obj: obj.get_role_name(),"") or ""
        obj_name=safe(lambda obj=obj: obj.get_name(),"") or ""
        st=set(states(obj))
        if role=="button" and obj_name==name and "showing" in st and "visible" in st:
            matches.append(obj)
    if len(matches)!=1:
        raise RuntimeError("WECHAT_BUTTON_NOT_UNIQUE_" + name.replace(" ","_").upper())
    try:
        focused=bool(matches[0].get_component_iface().grab_focus())
    except Exception:
        focused=False
    if not focused:
        raise RuntimeError("WECHAT_BUTTON_FOCUS_FAILED_" + name.replace(" ","_").upper())
    time.sleep(0.15)
    try:
        xdotool("key","Return")
    except Exception:
        xdotool("key","space")
    return True

def dismiss_logout_confirmation():
    with LOCK:
        prompt="You won't be notified of any new messages after logging out. Log out?"
        rows=tree_rows()
        prompts=[row for row in rows if row.get("role")=="label" and row.get("name")==prompt and visible(row)]
        cancels=[row for row in rows if row.get("role")=="button" and row.get("name")=="Cancel" and visible(row)]
        if len(prompts)!=1:
            raise RuntimeError("WECHAT_LOGOUT_CONFIRMATION_NOT_UNIQUE")
        if len(cancels)!=1:
            raise RuntimeError("WECHAT_LOGOUT_CANCEL_NOT_UNIQUE")
        b=cancels[0].get("bounds") or {}
        if int(b.get("width",0))<20 or int(b.get("height",0))<15:
            raise RuntimeError("WECHAT_LOGOUT_CANCEL_BOUNDS_INVALID")
        try:
            focus_and_activate_named_button("Cancel")
        except Exception:
            click_wechat_bounds(b)
        time.sleep(0.5)
        after=tree_rows()
        if any(row.get("role")=="label" and row.get("name")==prompt and visible(row) for row in after):
            try:
                focus_and_activate_named_button("Cancel")
            except Exception:
                click_wechat_bounds(b)
            time.sleep(0.5)
            after=tree_rows()
        if any(row.get("role")=="label" and row.get("name")==prompt and visible(row) for row in after):
            raise RuntimeError("WECHAT_LOGOUT_CONFIRMATION_DISMISS_FAILED")
        return {"state":"DISMISSED","provider":"wechat","effect_performed":False}

def scrollbar_probe():
    out=[]
    for obj in accessible_objects():
        role=safe(lambda obj=obj: obj.get_role_name(),"") or ""
        st=set(states(obj))
        if role!="scroll bar" or "showing" not in st or "visible" not in st:
            continue
        item={"name":safe(lambda obj=obj: obj.get_name(),"") or "","bounds":bounds(obj),"states":sorted(st)}
        try:
            value=obj.get_value_iface()
            item.update({
                "current":float(value.get_current_value()),
                "minimum":float(value.get_minimum_value()),
                "maximum":float(value.get_maximum_value()),
                "increment":float(value.get_minimum_increment()),
            })
        except Exception as exc:
            item["value_error"]=str(exc)[:160]
        out.append(item)
    return {"scrollbars":out}

def conversation_scan(limit=100,max_pages=20):
    if not isinstance(limit,int) or limit<1 or limit>500:
        raise RuntimeError("WECHAT_CONVERSATION_SCAN_LIMIT_INVALID")
    if not isinstance(max_pages,int) or max_pages<1 or max_pages>50:
        raise RuntimeError("WECHAT_CONVERSATION_SCAN_PAGES_INVALID")
    with LOCK:
        rows=tree_rows()
        if not authenticated(rows):
            raise RuntimeError("WECHAT_LOGIN_REQUIRED")
        lists=[r for r in rows if r.get("role")=="list" and r.get("name")=="Chats" and visible(r)]
        if len(lists)!=1:
            raise RuntimeError("WECHAT_CHATS_LIST_NOT_UNIQUE")
        b=lists[0].get("bounds") or {}
        if int(b.get("width",0))<80 or int(b.get("height",0))<120:
            raise RuntimeError("WECHAT_CHATS_LIST_BOUNDS_INVALID")
        cx=int(b["x"])+int(b["width"])//2
        cy=int(b["y"])+int(b["height"])//2
        seen={}
        stalled=0
        pages=0
        try:
            for page in range(max_pages):
                pages=page+1
                batch=conversations(tree_rows())
                before_count=len(seen)
                for item in batch:
                    key=(item.get("name"),item.get("preview"),item.get("timestamp"),item.get("unread_count"),item.get("muted"))
                    seen.setdefault(key,item)
                    if len(seen)>=limit:
                        break
                if len(seen)>=limit:
                    break
                stalled = stalled+1 if len(seen)==before_count else 0
                if stalled>=2:
                    break
                xdotool("mousemove",cx,cy,"click","--repeat","6","--delay","35","5")
                time.sleep(0.35)
        finally:
            try:
                xdotool("mousemove",cx,cy,"click","--repeat","160","--delay","8","4")
                time.sleep(0.45)
            except Exception:
                pass
        return {
            "conversations":list(seen.values())[:limit],
            "complete":False,
            "pages_scanned":pages,
            "read_state_changed":False,
            "provider_visible_state_changed":False,
        }

def file_dialog_state():
    """Require the exact focused, visible WeChat-owned Select File popup.

    The private Xvfb session intentionally has no EWMH window manager:
    xdotool getactivewindow always fails here. X11 input focus plus the
    popup's WM_TRANSIENT_FOR/PID/class/title give a stronger, testable proof.
    A different Qt popup (including Log Out) is never admitted.
    """
    import re
    def prop(wid, key):
        p=subprocess.run(["xprop","-id",str(wid),key],capture_output=True,
                         text=True,timeout=3,check=False)
        return p.stdout.strip() if p.returncode==0 else ""
    try:
        wid=xdotool_output("getwindowfocus").strip()
        title=xdotool_output("getwindowname",wid)
        klass=prop(wid,"WM_CLASS")
        main_ids=[x.strip() for x in xdotool_output(
            "search","--onlyvisible","--name","^WeChat$").splitlines() if x.strip()]
        main_id=main_ids[0] if len(main_ids)==1 else None
        popup_pid=xdotool_output("getwindowpid",wid).strip()
        main_pid=xdotool_output("getwindowpid",main_id).strip() if main_id else None
        transient=prop(wid,"WM_TRANSIENT_FOR")
        ref=re.search(r"window id # (0x[0-9a-fA-F]+)",transient)
        parent=int(ref.group(1),16) if ref else None
        p=subprocess.run(["xwininfo","-id",str(wid)],capture_output=True,
                         text=True,timeout=3,check=False)
        viewable=p.returncode==0 and "Map State: IsViewable" in p.stdout
        qualified=bool(main_id and wid!=main_id and
            title.strip().casefold()=="select file" and
            '"wechat", "wechat"' in klass.casefold() and
            popup_pid.isdigit() and popup_pid==main_pid and
            parent==int(main_id) and viewable)
        return {"window_id":wid,"title":title[:300],"class":klass[:160],
                "main_window_id":main_id,"transient_for":str(parent) if parent else None,
                "same_wechat_pid":bool(main_pid and popup_pid==main_pid),
                "input_focus_verified":True,"window_viewable":viewable,
                "is_distinct_file_dialog_candidate":qualified}
    except Exception as exc:
        return {"window_id":None,"title":None,"class":None,
                "main_window_id":None,"is_distinct_file_dialog_candidate":False,
                "error":type(exc).__name__+":"+str(exc)[:160]}

def dismiss_logout_confirmation_locked():
    prompt="You won't be notified of any new messages after logging out. Log out?"
    rows=tree_rows()
    prompts=[row for row in rows if row.get("role")=="label" and row.get("name")==prompt and visible(row)]
    if not prompts:
        return False
    cancels=[row for row in rows if row.get("role")=="button" and row.get("name")=="Cancel" and visible(row)]
    if len(prompts)!=1 or len(cancels)!=1:
        raise RuntimeError("WECHAT_LOGOUT_MODAL_SHAPE_INVALID")
    b=cancels[0].get("bounds") or {}
    try:
        focus_and_activate_named_button("Cancel")
    except Exception:
        click_wechat_bounds(b)
    time.sleep(0.4)
    if any(row.get("role")=="label" and row.get("name")==prompt and visible(row) for row in tree_rows()):
        raise RuntimeError("WECHAT_LOGOUT_MODAL_CANCEL_FAILED")
    return True

def _real_file_send_once(target,path,filename,digest,size,upload_id):
    """One native file send; all claims after the permanent marker are in doubt."""
    import hashlib
    import re
    import sys
    from pathlib import Path
    if not isinstance(upload_id,str) or not re.fullmatch(r"[0-9a-f]{64}",upload_id):
        raise RuntimeError("WECHAT_FILE_SEND_UPLOAD_ID_INVALID")
    sys.path.insert(0,"/tmp/wxeng")
    from atspi_backend import AtspiBackend
    from wechat_live_lock import WeChatLiveLock
    from x11_modal_guard import assert_no_wechat_modal
    from pointer_mapping import hover_target,click_once
    import wx_common as common
    import wx_nav as nav
    import wx_send as sender
    payload="cf-file:"+upload_id+":"+digest
    def doubtful(reason,clicks=0):
        return {"state":"IN_DOUBT","reason":reason,"target":target,
                "filename":filename,"file_size":size,"sha256_hex":digest,
                "send_clicks":clicks,"provider_confirmed":False,
                "effect_may_have_occurred":True,"blind_retry_safe":False}
    with WeChatLiveLock():
        if common.already_attempted(target,payload):
            raise RuntimeError("WECHAT_FILE_PRIOR_ATTEMPT_NO_RETRY")
        assert_no_wechat_modal()
        selection=select_target(target,allow_mark_read=False)
        backend=AtspiBackend()
        snap=backend.snapshot()
        common.require_chat(snap,target)
        if common.read_text(backend,common.composer(snap))!="":
            raise RuntimeError("WECHAT_FILE_COMPOSER_NOT_EMPTY")
        if common.send_button(snap,require_enabled=False).enabled():
            raise RuntimeError("WECHAT_FILE_SEND_ALREADY_ENABLED")
        before=sender.all_row_names(snap)
        before_count=sum(filename in str(row) for row in before)
        button=find_visible_button_exact("Send File")
        activate_object(button)
        deadline=time.monotonic()+5
        dialog={}
        while time.monotonic()<deadline:
            dialog=file_dialog_state()
            if dialog.get("is_distinct_file_dialog_candidate"):
                break
            time.sleep(0.12)
        if not dialog.get("is_distinct_file_dialog_candidate"):
            raise RuntimeError("WECHAT_FILE_CHOOSER_NOT_QUALIFIED")
        # The exact private file and chooser identity must still hold before
        # reserving a durable send-attempt record and pressing Return.
        if Path(path).stat().st_size!=size or hashlib.sha256(
                Path(path).read_bytes()).hexdigest()!=digest:
            raise RuntimeError("WECHAT_FILE_PRIVATE_BYTES_CHANGED")
        if not file_dialog_state().get("is_distinct_file_dialog_candidate"):
            raise RuntimeError("WECHAT_FILE_CHOOSER_FOCUS_CHANGED")
        common.claim_send(target,payload)  # O_EXCL, fsync, never removed
        try:
            xdotool("key","ctrl+l")
            time.sleep(0.1)
            if not file_dialog_state().get("is_distinct_file_dialog_candidate"):
                return doubtful("WECHAT_FILE_CHOOSER_LOST_FOCUS")
            xdotool("type","--clearmodifiers","--delay","1",path)
            time.sleep(0.15)
            if not file_dialog_state().get("is_distinct_file_dialog_candidate"):
                return doubtful("WECHAT_FILE_CHOOSER_FOCUS_CHANGED")
            xdotool("key","Return")
        except Exception as exc:
            return doubtful("WECHAT_FILE_SELECTION_UNCERTAIN_"+type(exc).__name__)
        deadline=time.monotonic()+5
        while time.monotonic()<deadline and file_dialog_state().get(
                "is_distinct_file_dialog_candidate"):
            time.sleep(0.1)
        if file_dialog_state().get("is_distinct_file_dialog_candidate"):
            return doubtful("WECHAT_FILE_CHOOSER_STILL_OPEN")
        try:
            assert_no_wechat_modal()
        except Exception:
            return doubtful("WECHAT_FILE_UNEXPECTED_MODAL")

        def observe(clicks):
            snap=backend.snapshot()
            common.require_chat(snap,target)
            enabled=common.send_button(snap,require_enabled=False).enabled()
            after=sender.all_row_names(snap)
            added=sum(filename in str(row) for row in after)-before_count
            if (added==1 and after and filename in str(after[-1]) and
                enabled is False):
                direction=sender._last_direction_any(backend,nav.Pixels())
                if direction=="out":
                    return {"state":"UI_OUTBOUND_OBSERVED","target":target,
                      "filename":filename,"file_size":size,"sha256_hex":digest,
                      "direction":"out","fresh_outbound_row":True,
                      "send_enabled_after":False,"send_clicks":clicks,
                      "provider_confirmed":False,"blind_retry_safe":False,
                      "effect_may_have_occurred":True,
                      "verification_source":"same_client_accessibility_and_screen_geometry"}
                return doubtful("WECHAT_FILE_DIRECTION_NOT_OUT",clicks)
            return {"snap":snap,"enabled":enabled,"added":added}
        clicks=0
        deadline=time.monotonic()+8
        while time.monotonic()<deadline:
            try:
                probe=observe(clicks)
            except Exception as exc:
                return doubtful("WECHAT_FILE_STAGING_UI_UNCERTAIN_"+type(exc).__name__)
            if "state" in probe:
                return probe
            if probe["enabled"]:
                snap=probe["snap"]
                try:
                    assert_no_wechat_modal()
                    common.require_chat(snap,target)
                    if common.read_text(backend,common.composer(snap))!="":
                        return doubtful("WECHAT_FILE_UNEXPECTED_TEXT_DRAFT")
                    send=common.send_button(snap,require_enabled=True)
                    plan=hover_target(backend,send,snap=snap,label="CF_FILE_SINGLE_SEND")
                    snap=backend.snapshot()
                    common.require_chat(snap,target)
                    if not common.send_button(snap,require_enabled=True).enabled():
                        return doubtful("WECHAT_FILE_STAGED_ATTACHMENT_CHANGED")
                    if hashlib.sha256(Path(path).read_bytes()).hexdigest()!=digest:
                        return doubtful("WECHAT_FILE_SOURCE_CHANGED_AFTER_STAGING")
                    assert_no_wechat_modal()
                    clicks=1
                    click_once(plan)
                except Exception as exc:
                    return doubtful("WECHAT_FILE_SEND_CLICK_IN_DOUBT_"+type(exc).__name__,clicks)
                break
            if probe["added"]!=0:
                return doubtful("WECHAT_FILE_NONUNIQUE_NEW_ROW")
            time.sleep(0.15)
        else:
            return doubtful("WECHAT_FILE_STAGING_TIMEOUT",clicks)
        deadline=time.monotonic()+16
        while time.monotonic()<deadline:
            try:
                final=observe(clicks)
            except Exception as exc:
                return doubtful("WECHAT_FILE_POST_SEND_UI_UNCERTAIN_"+type(exc).__name__,clicks)
            if "state" in final:
                return final
            if final["added"]>1:
                return doubtful("WECHAT_FILE_OUTBOUND_ROWS_AMBIGUOUS",clicks)
            time.sleep(0.15)
        return doubtful("WECHAT_FILE_POST_SEND_RECEIPT_TIMEOUT",clicks)


def file_send(target,filename=None,data_base64=None,expected_sha256=None,
              allow_mark_read=False,dry_run=False,upload_id=None):
    if not isinstance(target,str) or not target.strip() or len(target)>256 or allow_mark_read:
        raise RuntimeError("WECHAT_FILE_TARGET_INVALID_OR_MARK_READ")
    if not dry_run and (not isinstance(upload_id,str) or len(upload_id)!=64):
        raise RuntimeError("WECHAT_FILE_LIVE_SEND_UPLOAD_ID_REQUIRED")
    import base64,binascii,hashlib,re,shutil,stat,tempfile
    from pathlib import Path
    if (not isinstance(filename,str) or not 1<=len(filename)<=128 or
        filename in {".",".."} or any(ord(c)<32 or ord(c)==127 for c in filename) or
        any(c in filename for c in ('/',chr(92),'"'))):
        raise RuntimeError("WECHAT_FILE_DRYRUN_FILENAME_INVALID")
    if not isinstance(expected_sha256,str) or not re.fullmatch(r"[0-9a-f]{64}",expected_sha256):
        raise RuntimeError("WECHAT_FILE_DRYRUN_SHA_INVALID")
    if not isinstance(data_base64,str) or len(data_base64)>174764:
        raise RuntimeError("WECHAT_FILE_DRYRUN_BYTES_OVER_LIMIT")
    try:
        data=base64.b64decode(data_base64,validate=True)
    except (ValueError,binascii.Error):
        raise RuntimeError("WECHAT_FILE_DRYRUN_BASE64_INVALID") from None
    if not 1<=len(data)<=131072:
        raise RuntimeError("WECHAT_FILE_DRYRUN_SIZE_INVALID")
    digest=hashlib.sha256(data).hexdigest()
    if digest!=expected_sha256:
        raise RuntimeError("WECHAT_FILE_DRYRUN_SHA_MISMATCH")
    root="/tmp/wxeng/in"
    st=os.lstat(root)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o700:
        raise RuntimeError("WECHAT_FILE_DRYRUN_PRIVATE_ROOT_INVALID")
    folder=tempfile.mkdtemp(prefix=".cf-dryrun-",dir=root)
    try:
        os.chmod(folder,0o700)
        path=os.path.join(folder,filename)
        flags=os.O_CREAT|os.O_EXCL|os.O_WRONLY|getattr(os,"O_NOFOLLOW",0)
        descriptor=os.open(path,flags,0o600)
        with os.fdopen(descriptor,"wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        file_stat=os.lstat(path)
        if (not stat.S_ISREG(file_stat.st_mode) or file_stat.st_nlink!=1 or
            file_stat.st_uid!=os.getuid() or stat.S_IMODE(file_stat.st_mode)!=0o600 or
            file_stat.st_size!=len(data) or
            hashlib.sha256(Path(path).read_bytes()).hexdigest()!=digest):
            raise RuntimeError("WECHAT_FILE_DRYRUN_PRIVATE_COPY_INVALID")
        with LOCK:
            rows=tree_rows()
            if not authenticated(rows):
                raise RuntimeError("WECHAT_LOGIN_REQUIRED")
            if not dry_run:
                return _real_file_send_once(target,path,filename,digest,len(data),upload_id)
            selection=select_target(target,allow_mark_read=False)
            button=find_visible_button_exact("Send File")
            opened=False
            try:
                activate_object(button)
                opened=True
                time.sleep(0.7)
                dialog=file_dialog_state()
                if not dialog.get("is_distinct_file_dialog_candidate"):
                    raise RuntimeError("WECHAT_FILE_DIALOG_NOT_QUALIFIED")
            finally:
                if opened:
                    try:
                        xdotool("key","Escape")
                        time.sleep(0.3)
                    except Exception:
                        pass
            if file_dialog_state().get("is_distinct_file_dialog_candidate"):
                raise RuntimeError("WECHAT_FILE_DIALOG_NOT_CLOSED")
            return {
                "state":"DRY_RUN_READY","provider":"wechat",
                "target":target,"filename":filename,"file_size":len(data),
                "sha256_hex":digest,"private_bytes_verified":True,
                "dialog_qualified":True,"effect_performed":False,
                "provider_send_performed":False,"provider_confirmed":False,
                "provider_visible_state_changed":False,"selection":selection
            }
    finally:
        shutil.rmtree(folder,ignore_errors=False)

def file_dialog_probe():
    with LOCK:
        before=tree_rows()
        if not authenticated(before):
            raise RuntimeError("WECHAT_LOGIN_REQUIRED")
        selection=select_target("File Transfer",allow_mark_read=False)
        button=find_visible_button_exact("Send File")
        activate_object(button)
        time.sleep(0.7)
        dialog=file_dialog_state()
        if not dialog.get("is_distinct_file_dialog_candidate"):
            restored=False
            try:
                restored=dismiss_logout_confirmation_locked()
            except Exception:
                restored=False
            if not restored:
                try: xdotool("key","Escape")
                except Exception: pass
            time.sleep(0.3)
            raise RuntimeError("WECHAT_FILE_DIALOG_NOT_QUALIFIED")
        try:
            xdotool("key","Escape")
        finally:
            time.sleep(0.3)
        return {
            "state":"ACHIEVED","provider":"wechat","selection":selection,
            "dialog":dialog,"provider_visible_state_changed":False,
            "effect_performed":False,
        }

def screenshot_png():
    env={**os.environ,"DISPLAY":DISPLAY,"XAUTHORITY":XAUTHORITY}
    fd,path=tempfile.mkstemp(prefix="wechat-semantic-",suffix=".png")
    os.close(fd)
    try:
        subprocess.run([
            "ffmpeg","-loglevel","error","-f","x11grab","-video_size","1440x1000",
            "-i",DISPLAY,"-frames:v","1","-y",path
        ],env=env,check=True,timeout=8)
        with open(path,"rb") as f:
            return f.read()
    finally:
        try: os.unlink(path)
        except FileNotFoundError: pass

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args):
        return
    def send_json(self,status,payload):
        raw=json.dumps(payload,ensure_ascii=False,separators=(",",":")).encode()
        self.send_response(status)
        self.send_header("content-type","application/json; charset=utf-8")
        self.send_header("cache-control","no-store")
        self.send_header("content-length",str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)
    def do_GET(self):
        try:
            if self.path=="/status":
                rows=tree_rows()
                self.send_json(200,{"ok":True,"provider":"wechat","authenticated":authenticated(rows),"conversation_count":len(conversations(rows)) if authenticated(rows) else 0})
                return
            if self.path=="/conversations":
                rows=tree_rows()
                if not authenticated(rows):
                    self.send_json(409,{"ok":False,"error":"WECHAT_LOGIN_REQUIRED"}); return
                self.send_json(200,{"ok":True,"provider":"wechat","complete":False,"read_state_changed":False,"conversations":conversations(rows)})
                return
            if self.path=="/semantic-shape":
                rows=tree_rows()
                selected=[]
                for row in rows:
                    if not visible(row):
                        continue
                    st=set(row.get("states") or [])
                    name=str(row.get("name") or "")
                    b=row.get("bounds") or {}
                    if ("editable" in st and row.get("role")=="text") or name in {"Send","File Transfer"}:
                        selected.append({
                            "path":row.get("path"),"role":row.get("role"),"name":name,
                            "states":row.get("states"),"bounds":b,"child_count":row.get("child_count"),
                        })
                self.send_json(200,{"ok":True,"provider":"wechat","nodes":selected})
                return
            if self.path=="/scrollbars":
                self.send_json(200,{"ok":True,"provider":"wechat",**scrollbar_probe()})
                return
            if self.path=="/screenshot":
                raw=screenshot_png()
                self.send_response(200)
                self.send_header("content-type","image/png")
                self.send_header("cache-control","no-store")
                self.send_header("content-length",str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
                return
            self.send_json(404,{"ok":False,"error":"NOT_FOUND"})
        except Exception as exc:
            self.send_json(500,{"ok":False,"error":str(exc)[:200]})
    def do_POST(self):
        try:
            if self.path not in {"/search-probe","/context-probe","/send-text","/dismiss-logout-confirmation","/navigation-probe","/provider-search","/conversation-action","/file-dialog-probe","/select-target","/conversation-scan","/file-send","/restore-main"}:
                self.send_json(404,{"ok":False,"error":"NOT_FOUND"}); return
            size=int(self.headers.get("content-length","0"))
            if size<1 or size>262144:
                self.send_json(400,{"ok":False,"error":"BODY_INVALID"}); return
            body=json.loads(self.rfile.read(size))
            if self.path=="/search-probe":
                self.send_json(200,{"ok":True,"provider":"wechat",**search_probe(body.get("query"))})
                return
            if self.path=="/context-probe":
                self.send_json(200,{"ok":True,"provider":"wechat",**context_probe(body.get("target"))})
                return
            if self.path=="/send-text":
                payload=send_text(
                    body.get("target"),body.get("text"),
                    allow_mark_read=bool(body.get("allow_mark_read",False)),
                    dry_run=bool(body.get("dry_run",False)),
                )
                self.send_json(200,{"ok":True,**payload})
                return
            if self.path=="/dismiss-logout-confirmation":
                self.send_json(200,{"ok":True,**dismiss_logout_confirmation()})
                return
            if self.path=="/navigation-probe":
                self.send_json(200,{"ok":True,"provider":"wechat",**navigation_probe(body.get("section"),body.get("query"))})
                return
            if self.path=="/provider-search":
                self.send_json(200,{"ok":True,"provider":"wechat",**provider_search(body.get("query"))})
                return
            if self.path=="/restore-main":
                self.send_json(200,{"ok":True,"provider":"wechat",**restore_main_view()})
                return
            if self.path=="/conversation-action":
                self.send_json(200,{"ok":True,**conversation_action(
                    body.get("target"),body.get("action"),desired=body.get("desired"),
                    dry_run=bool(body.get("dry_run",False)),
                    confirm_irreversible=bool(body.get("confirm_irreversible",False)),
                )})
                return
            if self.path=="/file-dialog-probe":
                self.send_json(200,{"ok":True,**file_dialog_probe()})
                return
            if self.path=="/select-target":
                with LOCK:
                    self.send_json(200,{"ok":True,"provider":"wechat",**select_target(
                        str(body.get("target") or "").strip(),
                        allow_mark_read=bool(body.get("allow_mark_read",False)),
                    )})
                return
            if self.path=="/conversation-scan":
                self.send_json(200,{"ok":True,"provider":"wechat",**conversation_scan(
                    limit=int(body.get("limit",100)),
                    max_pages=int(body.get("max_pages",20)),
                )})
                return
            if self.path=="/file-send":
                self.send_json(200,{"ok":True,**file_send(
                    str(body.get("target") or "").strip(),
                    filename=body.get("filename"),
                    data_base64=body.get("data_base64"),
                    expected_sha256=body.get("expected_sha256"),
                    upload_id=body.get("upload_id"),
                    allow_mark_read=bool(body.get("allow_mark_read",False)),
                    dry_run=bool(body.get("dry_run",False)),
                )})
                return
            self.send_json(404,{"ok":False,"error":"NOT_FOUND"})
        except Exception as exc:
            self.send_json(400,{"ok":False,"error":str(exc)[:200]})

class Server(HTTPServer):
    allow_reuse_address = True

if __name__=="__main__":
    Server((HOST,PORT),Handler).serve_forever()
