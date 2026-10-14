#!/usr/bin/env python3
"""Offline stdlib regression tests; no root, messages, tokens or external writes."""
import base64
import hashlib
import hmac
import io
import json
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

import agent
import admin_wrapper
import github_api

FP = "cfsub_" + "f"*64

class AgentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        agent.ROOT = self.root / "state"
        agent.AUDIT = agent.ROOT / "audit.jsonl"
        agent.make_root()
        self.dir = self.root/"files"
        self.dir.mkdir()
        self.p = self.dir/"sample.txt"
        self.write = lambda **a:agent.handle(dict(caller=FP,op="server_file_write",args=a))

    def call(self,op,**args):
        r = agent.handle(dict(caller=FP,op=op,args=args))
        self.assertTrue(r["ok"],r)
        return r["result"]

    def test_owner_gate_and_files(self):
        with self.assertRaises(agent.Problem):
            agent.handle(dict(caller="cfsub_invalid",op="server_exec",args={"command":"echo no"}))

        self.call("server_file_write",path=str(self.p),content="cat",mode="create")
        r=self.call("server_file_read",path=str(self.p))
        self.assertEqual(r["content"],"cat")
        self.call("server_file_write",path=str(self.p),content=" dog",mode="append")
        self.call("server_file_edit",path=str(self.p),old_text="cat",new_text="bird")
        self.assertEqual(self.call("server_file_stat",path=str(self.p))["size_bytes"],8)
        listing=self.call("server_file_list",path=str(self.dir),depth=2)
        self.assertEqual(listing["entries"][0]["name"],"sample.txt")
        matches=self.call("server_file_search",path=str(self.dir),name_glob="*.txt",content_regex="bird")
        self.assertEqual(len(matches["matches"]),1)
        self.assertEqual(base64.b64decode(self.call("server_file_read",path=str(self.p),encoding="base64")["content"]),b"bird dog")
        b=self.dir/"copy.txt"
        self.call("server_file_copy",src=str(self.p),dst=str(b))
        moved=self.dir/"moved.txt"
        self.call("server_file_move",src=str(b),dst=str(moved))
        self.call("server_file_delete",path=str(moved),confirm=True)
        self.assertFalse(moved.exists())
        self.assertFalse(self.write(path=str(self.p),content="overwrite",mode="create")["ok"])
        self.assertFalse(agent.handle(dict(caller=FP,op="server_file_edit",
                         args=dict(path=str(self.p),old_text="nomatch",new_text="x")))["ok"])
        self.assertFalse(agent.handle(dict(caller=FP,op="server_file_delete",
                         args=dict(path=str(self.p),confirm=False)))["ok"])
        self.call("server_file_delete",path=str(self.p),confirm=True)
        self.assertTrue(agent.AUDIT.read_text().strip())

    def test_upload_link_and_fetch(self):
        self.call("server_file_write",path=str(self.p),content="ready")
        link=self.call("server_file_link",path=str(self.p),ttl_s=60)
        token=link["url"].rsplit("/",1)[1]
        meta=self.call("_link_open",token=token)
        self.assertEqual(meta["size_bytes"],5)
        chunk=self.call("_link_chunk",token=token,offset=0,length=100)
        self.assertEqual(base64.b64decode(chunk["content"]),b"ready")
        dest=self.dir/"out.bin"
        blob=b"A\x00B\xef"
        ticket=self.call("server_file_upload",action="start",path=str(dest),size_bytes=len(blob),sha256=hashlib.sha256(blob).hexdigest())
        upload_id=ticket["upload_id"]
        self.call("server_file_upload",action="chunk",upload_id=upload_id,offset=0,content_base64=base64.b64encode(blob).decode())
        self.assertEqual(self.call("server_file_upload",action="status",upload_id=upload_id)["offset"],4)
        self.call("server_file_upload",action="finish",upload_id=upload_id)
        self.assertEqual(dest.read_bytes(),blob)
        fetched=self.dir/"from-web.bin"
        stream=io.BytesIO(b"sample-content")
        with mock.patch.object(agent.urllib.request,"urlopen",return_value=stream):
            res=self.call("server_file_fetch",url_or_cf_download_path="https://example.com/static.txt",dest_path=str(fetched),expected_size=14)
        self.assertEqual(res["sha256"],hashlib.sha256(b"sample-content").hexdigest())

    def test_exec_jobs_and_caps(self):
        result=self.call("server_exec",command="id; hostname")
        self.assertEqual(result["exit_code"],0)
        self.assertTrue(result["stdout"])
        result=self.call("server_exec",command="printf abc; printf err >&2")
        self.assertEqual((result["stdout"],result["stderr"]),("abc","err"))
        self.assertIn("...cut...",agent.limit_text("a"*30000))
        job=self.call("server_exec",command="sleep 0.2; printf done",background=True)
        jid=job["job_id"]
        self.call("server_job_list")
        deadline=time.time()+6
        while time.time()<deadline:
            status=self.call("server_job_status",job_id=jid)
            if status["exit_code"] is not None:
                break
            time.sleep(.08)
        self.assertEqual(status["exit_code"],0,status)
        output=self.call("server_job_output",job_id=jid,stdout_offset=0,stderr_offset=0)
        self.assertEqual(output["stdout"],"done")
        job2=self.call("server_exec",command="sleep 30",background=True)
        time.sleep(.15)
        self.call("server_job_kill",job_id=job2["job_id"])
        self.assertNotIn("echo private-secret",agent.AUDIT.read_text())
        self.call("server_exec",command="echo private-secret")
        self.assertNotIn("echo private-secret",agent.AUDIT.read_text())

    def test_recursive_confirm(self):
        nested=self.dir/"nested"
        nested.mkdir()
        (nested/"x").write_text("x")
        result=agent.handle(dict(caller=FP,op="server_file_delete",args=dict(path=str(nested),confirm=True)))
        self.assertFalse(result["ok"])
        self.call("server_file_delete",path=str(nested),confirm=True,recursive=True)

class GithubTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.gh=github_api.GithubAPI(pathlib.Path(self.tmp.name))
        self.calls=[]
        def api(path,method="GET",payload=None):
            self.calls.append((path,method,payload))
            if "/git/ref/heads/main" in path:
                return {"object":{"sha":"oldsha"}}
            if "/git/commits/oldsha" in path:
                return {"tree":{"sha":"oldtree"}}
            if "/git/blobs" in path:
                return {"sha":"newblob"}
            if "/git/trees" in path:
                return {"sha":"newtree"}
            if "/git/commits" in path and method=="POST":
                return {"sha":"newcommit"}
            return {}
        self.gh.api=api

    def test_one_commit_and_delete(self):
        r=self.gh.files_push(dict(repo="homayounisaghar/cf-exec-plane",branch="main",
                message="test",files=[dict(path="a.txt",content="value"),dict(path="b.txt",content_base64="Yg==")],
                delete_paths=["obsolete.txt"]))
        self.assertEqual(r["commit_sha"],"newcommit")
        self.assertEqual(len([x for x in self.calls if x[0].endswith("/git/commits") and x[1]=="POST"]),1)
        self.assertEqual(self.calls[-1][1],"PATCH")
        with self.assertRaises(github_api.GithubProblem):
            self.gh.file_delete(dict(repo="homayounisaghar/cf-exec-plane",branch="main",
                                     path="a.txt",message="delete",confirm=False))
        with self.assertRaises(github_api.GithubProblem):
            github_api.repo_ok("someone-else/private")

    def test_device_token_not_returned(self):
        self.gh.form=lambda path,payload: {"device_code":"internal-hidden","user_code":"AAAA-BBBB",
                 "verification_uri":"https://github.com/login/device","expires_in":600,"interval":5}
        r=self.gh.auth_start({})
        self.assertEqual(r["user_code"],"AAAA-BBBB")
        self.assertNotIn("internal-hidden",json.dumps(r))
        self.assertEqual((self.gh.dir/"device.json").stat().st_mode&0o777,0o600)

class AdminTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        admin_wrapper.STATE=pathlib.Path(self.tmp.name)/"admin"
        admin_wrapper.STATE.mkdir(mode=0o700)
        self.key=b"test-signing-key-only-for-offline-tests"[:32]
        self.req="a"*32
    def signed(self,action,**fields):
        payload=dict(action=action,created_at=int(time.time()),caller=FP,**fields)
        raw=json.dumps(payload,separators=(",",":"))
        return dict(action=action,signed_payload=raw,
                    signature=hmac.new(self.key,raw.encode(),hashlib.sha256).hexdigest())
    def test_signed_root_one_time(self):
        with self.assertRaises(ValueError):
            admin_wrapper.dispatch(dict(action="request",signed_payload="{}",signature="fake"),self.key)
        create=self.signed("request",request_id=self.req,command="printf approved",reason="unit test",code="012345")
        out=admin_wrapper.dispatch(create,self.key)
        self.assertNotIn("code",json.dumps(out))
        with self.assertRaises(ValueError):
            admin_wrapper.dispatch(dict(action="approve",request_id=self.req,code="012345"),self.key)
        admin_wrapper.dispatch(self.signed("delivered",request_id=self.req),self.key)
        with self.assertRaises(ValueError):
            admin_wrapper.dispatch(dict(action="approve",request_id=self.req,code="000000"),self.key)
        r=admin_wrapper.dispatch(dict(action="approve",request_id=self.req,code="012345"),self.key)
        self.assertEqual((r["status"],r["exit_code"],r["stdout"]),("finished",0,"approved"))
        with self.assertRaises(ValueError):
            admin_wrapper.dispatch(dict(action="approve",request_id=self.req,code="012345"),self.key)
        self.assertNotIn("012345",(admin_wrapper.STATE/(self.req+".json")).read_text())
        self.assertNotIn("code_hash",(admin_wrapper.STATE/(self.req+".json")).read_text())

if __name__=="__main__":
    unittest.main(verbosity=2)
