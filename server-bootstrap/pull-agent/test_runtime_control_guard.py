#!/usr/bin/env python3
from __future__ import annotations
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile

guard_path=Path(sys.argv[1]).resolve()

def base():
    return {
      "schema":"capability-fabric.onshape-runtime-control.v1",
      "controlRevision":529,
      "routing":{"state":"ADMITTED","activeMailboxIssue":34,"candidateMailboxIssue":34,"busGeneration":2,"statusIssue":33,"requireRuntimeAttestation":True,"materialCommandsAllowed":True},
      "runtime":{"requiredResourceKey":"onshape-session:production"},
      "lease":{"state":"FREE","busGeneration":2},
      "authority":{
        "schema":"capability-fabric.onshape-production-authority.v1",
        "productionEpoch":1,
        "mode":"ANDROID_PRODUCTION",
        "materialAuthority":"android-v1",
        "planes":{
          "android-v1":{"ingress":"ADMITTED","materialEffectsAllowed":True,"runtimeGeneration":"bridge","busGeneration":2},
          "vps-fabric":{"ingress":"SHADOW","materialEffectsAllowed":False,"releaseSequence":63,"releaseId":"rollback","manifestSha256":"a"*64}
        },
        "reconciliationHold":{"active":False}
      }
    }

def write(root,p):
    p.write_text(json.dumps(root,sort_keys=True,separators=(",",":")))

def run(prev,new,ok):
    with tempfile.TemporaryDirectory() as td:
        p=Path(td)/"p.json"; n=Path(td)/"n.json"; write(prev,p); write(new,n)
        r=subprocess.run([sys.executable,str(guard_path),str(p),str(n)],capture_output=True,text=True)
        if (r.returncode==0) != ok:
            raise SystemExit(f"unexpected guard result ok={ok} rc={r.returncode} out={r.stdout} err={r.stderr}")

cur=base()

same=copy.deepcopy(cur)
run(cur,same,True)

metadata=copy.deepcopy(cur); metadata["controlRevision"]=530; metadata["authority"]["planes"]["vps-fabric"]["releaseSequence"]=64
metadata["authority"]["planes"]["vps-fabric"]["releaseId"]="new-shadow"; metadata["authority"]["planes"]["vps-fabric"]["manifestSha256"]="b"*64
run(cur,metadata,True)

down=copy.deepcopy(cur); down["controlRevision"]=530; down["authority"]["productionEpoch"]=0
run(cur,down,False)

quiesced=copy.deepcopy(cur); quiesced["controlRevision"]=530; quiesced["authority"]["productionEpoch"]=2
quiesced["authority"]["mode"]="QUIESCED_RECONCILING"; quiesced["authority"]["materialAuthority"]=None
quiesced["authority"]["planes"]["android-v1"]["ingress"]="CLOSED"; quiesced["authority"]["planes"]["android-v1"]["materialEffectsAllowed"]=False
quiesced["authority"]["planes"]["vps-fabric"]["ingress"]="CLOSED"; quiesced["routing"]["state"]="CLOSED"; quiesced["routing"]["materialCommandsAllowed"]=False
run(cur,quiesced,True)

badq=copy.deepcopy(quiesced); badq["authority"]["productionEpoch"]=1
run(cur,badq,False)

vps=copy.deepcopy(quiesced); vps["controlRevision"]=531; vps["authority"]["productionEpoch"]=3
vps["authority"]["mode"]="VPS_PRODUCTION"; vps["authority"]["materialAuthority"]="vps-fabric"
vps["authority"]["planes"]["vps-fabric"]["ingress"]="ADMITTED"; vps["authority"]["planes"]["vps-fabric"]["materialEffectsAllowed"]=True
vps["authority"]["planes"]["vps-fabric"]["releaseSequence"]=65; vps["authority"]["planes"]["vps-fabric"]["releaseId"]="onshape-vps-hardened-production-r2"; vps["authority"]["planes"]["vps-fabric"]["manifestSha256"]="c"*64
run(quiesced,vps,True)

guarded=copy.deepcopy(vps); guarded["controlRevision"]=532; guarded["authority"]["productionEpoch"]=4
guarded["authority"]["productionGuard"]={
  "schema":"capability-fabric.onshape-production-guard.v1",
  "generation":1,
  "killSwitch":"ENGAGED",
  "allowedDocumentIds":[],
  "mutationBudget":{"budgetId":"guard-closed","maxMutations":0},
}
run(vps,guarded,True)

guard_same_epoch=copy.deepcopy(guarded); guard_same_epoch["controlRevision"]=533
guard_same_epoch["authority"]["productionGuard"]={
  "schema":"capability-fabric.onshape-production-guard.v1",
  "generation":2,
  "killSwitch":"OPEN",
  "allowedDocumentIds":["881affea8ea63c33ae4e6c78"],
  "mutationBudget":{"budgetId":"guard-open-two","maxMutations":2},
}
run(guarded,guard_same_epoch,False)

guard_new_epoch=copy.deepcopy(guard_same_epoch); guard_new_epoch["authority"]["productionEpoch"]=5
run(guarded,guard_new_epoch,True)

direct=copy.deepcopy(vps); direct["controlRevision"]=530; direct["authority"]["productionEpoch"]=2
run(cur,direct,False)

q2=copy.deepcopy(vps); q2["controlRevision"]=532; q2["authority"]["productionEpoch"]=4
q2["authority"]["mode"]="QUIESCED_RECONCILING"; q2["authority"]["materialAuthority"]=None
q2["authority"]["planes"]["vps-fabric"]["ingress"]="CLOSED"; q2["authority"]["planes"]["vps-fabric"]["materialEffectsAllowed"]=False
run(vps,q2,True)

rollback=copy.deepcopy(q2); rollback["controlRevision"]=533; rollback["authority"]["productionEpoch"]=5
rollback["authority"]["mode"]="ANDROID_PRODUCTION"; rollback["authority"]["materialAuthority"]="android-v1"
rollback["authority"]["planes"]["android-v1"]["ingress"]="ADMITTED"; rollback["authority"]["planes"]["android-v1"]["materialEffectsAllowed"]=True
rollback["routing"]["state"]="ADMITTED"; rollback["routing"]["materialCommandsAllowed"]=True
rollback["routing"]["activeMailboxIssue"]=35; rollback["routing"]["candidateMailboxIssue"]=35
rollback["routing"]["busGeneration"]=3; rollback["lease"]["busGeneration"]=3
rollback["authority"]["planes"]["android-v1"]["busGeneration"]=3
run(q2,rollback,True)

badrollback=copy.deepcopy(rollback); badrollback["routing"]["activeMailboxIssue"]=34; badrollback["routing"]["candidateMailboxIssue"]=34
run(q2,badrollback,False)

badrollback2=copy.deepcopy(rollback); badrollback2["routing"]["busGeneration"]=2; badrollback2["lease"]["busGeneration"]=2; badrollback2["authority"]["planes"]["android-v1"]["busGeneration"]=2
run(q2,badrollback2,False)

print("CF_AUTH_GUARD_TEST_IDENTICAL=pass")
print("CF_AUTH_GUARD_TEST_SHADOW_METADATA_SAME_EPOCH=pass")
print("CF_AUTH_GUARD_TEST_EPOCH_DECREASE_REJECT=pass")
print("CF_AUTH_GUARD_TEST_QUIESCE_NEW_EPOCH=pass")
print("CF_AUTH_GUARD_TEST_DIRECT_TRANSFER_REJECT=pass")
print("CF_AUTH_GUARD_TEST_VPS_TRANSITION=pass")
print("CF_AUTH_GUARD_TEST_POLICY_ADD_NEW_EPOCH=pass")
print("CF_AUTH_GUARD_TEST_POLICY_CHANGE_SAME_EPOCH_REJECT=pass")
print("CF_AUTH_GUARD_TEST_POLICY_CHANGE_NEW_EPOCH=pass")
print("CF_AUTH_GUARD_TEST_ROLLBACK_NEW_EPOCH_BUS_MAILBOX=pass")
print("CF_AUTH_GUARD_TEST_ROLLBACK_STALE_BUS_REJECT=pass")
print("CF_AUTH_GUARD_TEST=pass")
