"""Offline, privacy-safe benchmark preflight invariants; no WeChat session needed."""
from benchmark_gate_f_readsafe import verify_benchmark_preflight
from engine import UIBlocked

case_count=0
def ok(selected,row_selected,zero):
    global case_count
    assert verify_benchmark_preflight(selected,row_selected,zero) is None
    case_count+=1
    print("[PASS] safe preflight",case_count)

def blocked(expected,selected,row_selected,zero):
    global case_count
    try:
        verify_benchmark_preflight(selected,row_selected,zero)
    except UIBlocked as e:
        assert e.code==expected,(e.code,expected)
    else:
        raise AssertionError(expected)
    case_count+=1
    print("[PASS] denied preflight",case_count)

ok("FixtureRecipient",True,False)
ok(None,False,True)
blocked("BENCH_UNSELECTED_TARGET_NEEDS_UNREAD_ZERO_PROOF",None,False,False)
blocked("BENCH_OTHER_CONVERSATION_SELECTED","Other",False,True)
blocked("BENCH_SELECTION_STATE_INCONSISTENT",None,True,True)
blocked("BENCH_SELECTION_STATE_INCONSISTENT","FixtureRecipient",False,True)
print("%d/%d passed" % (case_count,case_count))
