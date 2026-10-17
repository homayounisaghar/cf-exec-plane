#!/usr/bin/env python3
"""v8 projection regression: isolated files, no provider calls."""
import hashlib
import os
import tempfile
import unittest
from service import Store
from work_runtime_v8 import WorkRuntimeV8

def message(ident,work,text="وضعیت"):
    return {"schema":"cf.agentos.command.v2","command_id":ident,
      "text":text,"sha256":hashlib.sha256(text.encode()).hexdigest(),"work_id":work}

class WorkV8Test(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.store=Store(os.path.join(self.tmp.name,"test.sqlite"))
        self.r=WorkRuntimeV8(self.store)
    def tearDown(self):self.tmp.cleanup()

    def put(self,ident,work,text="وضعیت"):
        status,receipt=self.store.accept(message(ident,work,text))
        self.assertEqual(status,201)
        self.assertFalse(receipt["executed"])

    def test_three_local_works_done_and_durable(self):
        for w in ("agentos","queue","vps"):self.put("command-%s-1111"%w,w)
        self.r.advance()
        b=self.r.board()
        self.assertEqual(b["mode"],"DIRECT_READONLY")
        self.assertFalse(b["external_provider_dispatch"])
        self.assertEqual(len(b["works"]),3)
        self.assertTrue(all(w["state"]=="DONE" and w["evidence_ref"] for w in b["works"]))
        self.assertEqual(WorkRuntimeV8(self.store).board()["works"],b["works"])

    def test_provider_tasks_fail_closed(self):
        self.put("command-onshape-1111","onshape")
        self.put("command-telegram-1111","telegram")
        self.r.advance()
        b=self.r.board()["works"]
        self.assertTrue(all(w["state"]=="QUEUED" and not w["evidence_ref"] for w in b))

    def test_ambiguous_target_not_dispatched(self):
        self.put("command-unknown-1111",None,"ادامه بده")
        self.r.advance()
        self.assertEqual(self.r.board()["works"],[])

    def test_no_duplicate_after_restart(self):
        self.put("command-agentos-2222","agentos")
        self.r.advance()
        before=self.r.board()["works"]
        self.r.advance()
        self.assertEqual(before,self.r.board()["works"])
        code,old=self.store.status("command-agentos-2222")
        self.assertEqual(code,200)
        self.assertEqual(old["state"],"QUEUED")
        self.assertFalse(old["executed"])

    def test_cutover_does_not_reprocess_history(self):
        with tempfile.TemporaryDirectory() as other:
            s=Store(os.path.join(other,"old.sqlite"))
            code,_=s.accept(message("command-history-1111","agentos"))
            self.assertEqual(code,201)
            newer=WorkRuntimeV8(s)
            newer.advance()
            self.assertEqual(len(newer.board()["works"]),0)

if __name__=="__main__":unittest.main()
