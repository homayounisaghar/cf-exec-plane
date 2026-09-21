#!/usr/bin/env python3
from __future__ import annotations
import json,sqlite3,subprocess,sys,tempfile
from pathlib import Path

guard=Path(sys.argv[1]).resolve()

def control(mode="VPS_PRODUCTION",epoch=3,bus=2,mailbox=34):
    if mode=="VPS_PRODUCTION":
        material="vps-fabric"; ai="CLOSED"; aa=False; vi="ADMITTED"; va=True; routing="CLOSED"; allowed=False
    elif mode=="QUIESCED_RECONCILING":
        material=None; ai="CLOSED"; aa=False; vi="CLOSED"; va=False; routing="CLOSED"; allowed=False
    else:
        material="android-v1"; ai="ADMITTED"; aa=True; vi="SHADOW"; va=False; routing="ADMITTED"; allowed=True
    return {
      "schema":"capability-fabric.onshape-runtime-control.v1",
      "controlRevision":600+epoch,
      "routing":{"state":routing,"activeMailboxIssue":mailbox,"candidateMailboxIssue":mailbox,"busGeneration":bus,"materialCommandsAllowed":allowed},
      "lease":{"state":"FREE","busGeneration":bus},
      "authority":{
        "schema":"capability-fabric.onshape-production-authority.v1",
        "productionEpoch":epoch,"mode":mode,"materialAuthority":material,
        "planes":{
          "android-v1":{"ingress":ai,"materialEffectsAllowed":aa,"busGeneration":bus},
          "vps-fabric":{"ingress":vi,"materialEffectsAllowed":va,"releaseSequence":65,"releaseId":"r2","manifestSha256":"a"*64}
        }
      }
    }

def db(path, achieved=False, unresolved=False):
    c=sqlite3.connect(path)
    c.executescript("""
      CREATE TABLE invocations(invocation_id TEXT PRIMARY KEY,payload TEXT NOT NULL,phase TEXT NOT NULL,admission_payload TEXT,route_payload TEXT,dispatch_payload TEXT);
      CREATE TABLE operations(operation_id TEXT PRIMARY KEY,invocation_id TEXT NOT NULL UNIQUE,payload TEXT NOT NULL,state TEXT NOT NULL,outcome_payload TEXT);
      CREATE TABLE attempts(attempt_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,ordinal INTEGER NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,observation_payload TEXT);
    """)
    if achieved:
        dispatch={"execution_payload":{"agentEffect":"MUTATION","preconditions":{"productionAuthority":{"productionEpoch":3,"mode":"VPS_PRODUCTION","materialAuthority":"vps-fabric"}}}}
        c.execute("INSERT INTO invocations VALUES(?,?,?,?,?,?)",("i1","{}","RECONCILED",None,None,json.dumps(dispatch)))
        c.execute("INSERT INTO operations VALUES(?,?,?,?,?)",("o1","i1","{}","ACHIEVED",'{"state":"ACHIEVED"}'))
        c.execute("INSERT INTO attempts VALUES(?,?,?,?,?,?)",("a1","o1",1,"{}","OBSERVED","{}"))
    if unresolved:
        dispatch={"execution_payload":{"agentEffect":"MUTATION","preconditions":{"productionAuthority":{"productionEpoch":3,"mode":"VPS_PRODUCTION","materialAuthority":"vps-fabric"}}}}
        c.execute("INSERT INTO invocations VALUES(?,?,?,?,?,?)",("i2","{}","OBSERVED",None,None,json.dumps(dispatch)))
        c.execute("INSERT INTO operations VALUES(?,?,?,?,?)",("o2","i2","{}","IN_DOUBT",None))
        c.execute("INSERT INTO attempts VALUES(?,?,?,?,?,?)",("a2","o2",1,"{}","IN_DOUBT","{}"))
    c.commit(); c.close()

def write(path,v): path.write_text(json.dumps(v))

def run(args,ok=True,contains=None):
    r=subprocess.run([sys.executable,str(guard),*args],capture_output=True,text=True)
    if (r.returncode==0)!=ok:
        raise SystemExit(f"unexpected rc={r.returncode} ok={ok}\nout={r.stdout}\nerr={r.stderr}")
    if contains and contains not in r.stdout+r.stderr:
        raise SystemExit(f"missing {contains}\nout={r.stdout}\nerr={r.stderr}")

with tempfile.TemporaryDirectory() as td:
    td=Path(td)
    ctl=td/"control.json"; write(ctl,control())
    d0=td/"d0.sqlite"; db(d0)
    run(["decide","--db",str(d0),"--control",str(ctl)],contains="CF_A4_ROLLBACK_DIRECTIVE=ROLLBACK_ALLOWED")

    d1=td/"d1.sqlite"; db(d1,achieved=True)
    run(["decide","--db",str(d1),"--control",str(ctl)],contains="CF_A4_PONR=true")
    run(["decide","--db",str(d1),"--control",str(ctl)],contains="CF_A4_ROLLBACK_DIRECTIVE=ROLLBACK_ALLOWED")

    d2=td/"d2.sqlite"; db(d2,achieved=True,unresolved=True)
    run(["decide","--db",str(d2),"--control",str(ctl)],ok=False,contains="both material ingresses must remain closed")

    closed=td/"closed.json"; write(closed,control("QUIESCED_RECONCILING",4,2,34))
    run(["decide","--db",str(d2),"--control",str(closed)],contains="CF_A4_ROLLBACK_DIRECTIVE=HOLD_BOTH_CLOSED")

    android=td/"android.json"; write(android,control("ANDROID_PRODUCTION",5,3,35))
    run(["transition","--previous",str(closed),"--candidate",str(android)],contains="CF_A4_ROLLBACK_TRANSITION=pass")

    stale=td/"stale.json"; write(stale,control("ANDROID_PRODUCTION",4,2,34))
    run(["transition","--previous",str(closed),"--candidate",str(stale)],ok=False)

    direct=td/"direct.json"; write(direct,control("ANDROID_PRODUCTION",4,3,35))
    run(["transition","--previous",str(ctl),"--candidate",str(direct)],ok=False,contains="direct VPS-to-Android")

print("CF_A4_TEST_PRE_PONR_ROLLBACK=pass")
print("CF_A4_TEST_PONR_DETECTED_FROM_DURABLE_FABRIC=pass")
print("CF_A4_TEST_POST_PONR_ZERO_UNRESOLVED_ROLLBACK=pass")
print("CF_A4_TEST_UNRESOLVED_REQUIRES_BOTH_CLOSED=pass")
print("CF_A4_TEST_ROLLBACK_EPOCH_MONOTONIC=pass")
print("CF_A4_TEST_ROLLBACK_BUS_MAILBOX_MONOTONIC=pass")
print("CF_A4_TEST_DIRECT_VPS_ANDROID_REJECT=pass")
print("CF_A4_TEST=pass")
