"""Shared AT-SPI popup closure proof. No GUI input and no image/pixel layer.

PopupBaseline holds two actual snapshots (before open, after open), enabling a
multiset baseline diff. verify_popup_closed is the ONLY closure verifier.
The historical first Chat Info click predates durable snapshot capture: the
legacy constructor explicitly records that limited provenance and additionally
requires the pretest total node count and published Messages geometry.
"""
from __future__ import annotations
from collections import Counter
from dataclasses import dataclass
import time
from engine import TARGETS,UIBlocked

@dataclass(frozen=True)
class PopupBaseline:
    backend: object
    added: Counter
    allowed: Counter
    messages_rect: tuple
    composer_rect: tuple
    origin: str
    expected_total: int | None = None

@dataclass(frozen=True)
class CloseEvidence:
    closed: bool
    elapsed_ms: int
    remaining_added: int
    extents_match: bool
    total_nodes: int
    origin: str

def _shown(n):
    return "showing" in n.states and "visible" in n.states

def _rect(n):
    return (n.rect.x,n.rect.y,n.rect.w,n.rect.h) if n.rect else None

def _signature(n):
    # Path is deliberately omitted because Qt renumbers siblings after popup
    # dismissal; count duplicate semantic/geometry tuples with a multiset.
    return (n.role,n.name,_rect(n))

def _shown_count(snapshot):
    return Counter(_signature(n) for n in snapshot.nodes if _shown(n))

def _anchors(snap):
    mes=[n for n in snap.nodes if n.role.casefold()=="list" and _shown(n) and
         " ".join(n.name.casefold().split()) in
         {" ".join(label.casefold().split()) for label in TARGETS["messages_container"].labels}]
    txt=[n for n in snap.nodes if n.role.casefold()=="text" and _shown(n) and
         "editable" in n.states and
         " ".join(n.name.casefold().split()) not in
         {" ".join(label.casefold().split()) for label in TARGETS["search_box"].labels}]
    if len(mes)!=1 or len(txt)!=1 or not mes[0].rect or not txt[0].rect:
        raise UIBlocked("POPUP_BASELINE_ANCHORS_UNVERIFIED")
    return (_rect(mes[0]),_rect(txt[0]))

def baseline_from_snapshots(backend,before,opened):
    """Use for ALL newly opened controls: exact pre/post showing-node diff."""
    pre=_shown_count(before)
    delta=_shown_count(opened)-pre
    if not delta:
        raise UIBlocked("POPUP_OPEN_NODES_NOT_PROVEN")
    m,c=_anchors(before)
    return PopupBaseline(backend,delta,pre,m,c,"captured_before_open")

def legacy_chat_info_baseline(backend,opened,*,original_total=249,
                              historical_messages_rect=(552,241,578,418)):
    """Strict historical fallback; NEVER misreport it as a captured snapshot.

    The original 249-node full snapshot was not persisted by the earlier run.
    Isolate the unique showing 250x558 Chat Info panel subtree, and require
    every visible member of that subtree to disappear, all anchors unchanged,
    and the complete tree count to return to the measured pre-open baseline.
    The original composer rectangle was not preserved: its *current* size is
    a conservative invariant but NOT independent proof of pre-open geometry.
    """
    if len(opened.nodes)<=original_total:
        raise UIBlocked("HISTORICAL_POPUP_NOT_OPEN")
    required=("Search Chat History","Mute Notifications","Pin to Top","Clear Chat History")
    for label in required:
        if not any(n.name==label and _shown(n) for n in opened.nodes):
            raise UIBlocked("HISTORICAL_CHAT_INFO_LABEL_MISSING")
    # Qt tree: panel is a unique nested filler at x=880,y=241,w=250,h=558.
    panels=[n for n in opened.nodes if _shown(n) and n.role.casefold()=="filler"
            and _rect(n)==(880,241,250,558)]
    if not panels:
        raise UIBlocked("HISTORICAL_POPUP_SUBTREE_UNVERIFIED")
    min_depth=min(len(n.path) for n in panels)
    top=[n for n in panels if len(n.path)==min_depth]
    if len(top)!=1:
        raise UIBlocked("HISTORICAL_POPUP_SUBTREE_UNVERIFIED")
    prefix=top[0].path
    subtree=[n for n in opened.nodes if n.path[:len(prefix)]==prefix and _shown(n)]
    if len(subtree)<20 or not all(any(n.name==k for n in subtree) for k in required):
        raise UIBlocked("HISTORICAL_POPUP_SUBTREE_UNVERIFIED")
    observed_m,observed_c=_anchors(opened)
    if observed_m!=historical_messages_rect:
        raise UIBlocked("HISTORICAL_MESSAGE_EXTENTS_CHANGED")
    delta=Counter(_signature(n) for n in subtree)
    return PopupBaseline(backend,delta,Counter(),historical_messages_rect,observed_c,
                         "reconstructed_no_old_snapshot",original_total)

def verify_popup_closed(baseline,timeout=2.0,poll=0.1):
    """Require EVERY added showing-node gone, and both UI anchor extents equal.

    One bounded event-driven proof. No GUI action. The only historical fallback
    additionally requires returning to the original observed tree size.
    """
    if not isinstance(baseline,PopupBaseline) or not baseline.added:
        raise UIBlocked("POPUP_BASELINE_INVALID")
    if not (0<timeout<=2.0 and 0<poll<=0.1):
        raise UIBlocked("POPUP_POLL_BOUNDS_INVALID")
    start=time.monotonic()
    deadline=start+timeout
    last=None
    while True:
        snap=baseline.backend.snapshot()
        current=_shown_count(snap)
        remaining=sum(min(delta,max(0,current[key]-baseline.allowed[key]))
                      for key,delta in baseline.added.items())
        # The original baseline multiplicity remains allowed for duplicated
        # semantic+rect keys; only the newly appearing copies must disappear.
        try:
            message,composer=_anchors(snap)
            aligned=(message==baseline.messages_rect and composer==baseline.composer_rect)
        except UIBlocked:
            aligned=False
        size_ok=(baseline.expected_total is None or len(snap.nodes)<=baseline.expected_total)
        elapsed=int(round((time.monotonic()-start)*1000))
        last=CloseEvidence(remaining==0 and aligned and size_ok,elapsed,remaining,
                           aligned,len(snap.nodes),baseline.origin)
        if last.closed or time.monotonic()>=deadline:
            return last
        baseline.backend.wait_change(min(poll,max(0.0,deadline-time.monotonic())))
