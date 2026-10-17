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

    def test_authentic_http_board_and_old_receipt_unchanged(self):
        import json, threading, time
        from urllib import request, error
        from service import create_server, PREFIX
        httpd=create_server(self.store,port=0)
        worker=threading.Thread(target=httpd.serve_forever,daemon=True)
        worker.start()
        base="http://127.0.0.1:%d%s"%(httpd.server_port,PREFIX)
        def call(route,method="GET",obj=None,bearer=None):
            data=None if obj is None else json.dumps(obj).encode()
            req=request.Request(base+route,method=method,data=data)
            if data is not None:req.add_header("Content-Type","application/json")
            if bearer:req.add_header("Authorization","Bearer "+bearer)
            try:
                with request.urlopen(req,timeout=4) as ans:
                    return ans.status,json.loads(ans.read())
            except error.HTTPError as e:
                return e.code,json.loads(e.read())
        try:
            status,_=call("/v4/board")
            self.assertEqual(status,401)
            key=self.store.create_pair()
            status,paired=call("/v2/pair","POST",{"pairing_code":key})
            self.assertEqual(status,201)
            bearer=paired["device_token"]
            status,accepted=call("/v2/commands","POST",
              message("command-http-v8-111","agentos"),bearer)
            self.assertEqual(status,201)
            self.assertFalse(accepted["executed"])
            status,board=call("/v4/board",bearer=bearer)
            self.assertEqual(status,200)
            self.assertEqual(board["schema"],"cf.agentos.work-board.v8")
            self.assertEqual(len(board["works"]),1)
            self.assertFalse(board["external_provider_dispatch"])
            status,legacy=call("/v2/commands/command-http-v8-111",bearer=bearer)
            self.assertEqual(status,200)
            self.assertFalse(legacy["executed"])
            self.assertEqual(legacy["state"],"QUEUED")
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_true_result_bound_to_command_and_history(self):
        self.put("command-agentos-9001","agentos")
        self.put("command-agentos-9002","agentos")
        self.r.advance()
        mine=self.r.detail("command-agentos-9001")
        self.assertEqual(mine["command_id"],"command-agentos-9001")
        self.assertEqual(mine["state"],"DONE")
        self.assertTrue(mine["evidence_ref"].startswith("vps-read-"))
        self.assertFalse(mine["provider_effect_executed"])
        self.assertEqual(len(self.r.board()["works"][0]["history"]),2)

    def test_arbitrary_command_does_not_fake_completion(self):
        self.put("command-agentos-9999","agentos","لطفاً این برنامه را تغییر بده")
        self.r.advance()
        mine=self.r.detail("command-agentos-9999")
        self.assertEqual(mine["state"],"NEEDS_CLARIFICATION")
        self.assertIsNone(mine["evidence_ref"])

    def test_cross_work_request_not_satisfied_from_wrong_work(self):
        self.put("command-agentos-8888","agentos","وضعیت تلگرام را بررسی کن")
        self.r.advance()
        self.assertEqual(self.r.detail("command-agentos-8888")["state"],"NEEDS_CLARIFICATION")

    def test_status_like_mutating_request_needs_clarification(self):
        self.put("command-agentos-7777","agentos",
                 "وضعیت سرور را بررسی کن و بعد فایل ها را حذف کن")
        self.r.advance()
        item=self.r.detail("command-agentos-7777")
        self.assertEqual(item["state"],"NEEDS_CLARIFICATION")
        self.assertIsNone(item["evidence_ref"])

    def test_server_v9_result_endpoint_authorization(self):
        import json,threading
        from urllib import request,error
        from service import create_server,PREFIX
        httpd=create_server(self.store,port=0)
        thr=threading.Thread(target=httpd.serve_forever,daemon=True)
        thr.start()
        base="http://127.0.0.1:%s%s"%(httpd.server_port,PREFIX)
        try:
            self.put("command-agentos-5555","agentos")
            self.r.advance()
            route=base+"/v4/commands/command-agentos-5555"
            try:
                request.urlopen(route,timeout=3)
                self.fail("anonymous result must be forbidden")
            except error.HTTPError as e:self.assertEqual(e.code,401)
            token=self.store.create_pair()
            req=request.Request(base+"/v2/pair",data=json.dumps({"pairing_code":token}).encode(),
                                headers={"Content-Type":"application/json"})
            with request.urlopen(req,timeout=3) as reply:
                bearer=json.load(reply)["device_token"]
            req=request.Request(route,headers={"Authorization":"Bearer "+bearer})
            with request.urlopen(req,timeout=3) as reply:
                item=json.load(reply)
            self.assertEqual(item["schema"],"cf.agentos.command-result.v9")
            self.assertEqual(item["command_id"],"command-agentos-5555")
            self.assertEqual(item["state"],"DONE")
            self.assertTrue(item["evidence_ref"])
        finally:
            httpd.shutdown();httpd.server_close()

    def test_cutover_does_not_reprocess_history(self):
        with tempfile.TemporaryDirectory() as other:
            s=Store(os.path.join(other,"old.sqlite"))
            code,_=s.accept(message("command-history-1111","agentos"))
            self.assertEqual(code,201)
            newer=WorkRuntimeV8(s)
            newer.advance()
            self.assertEqual(len(newer.board()["works"]),0)

if __name__=="__main__":unittest.main()
