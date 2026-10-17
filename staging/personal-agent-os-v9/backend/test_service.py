#!/usr/bin/env python3
import json, tempfile, threading, unittest, urllib.request, urllib.error, uuid
from pathlib import Path
from service import Store, create_server, sha, COMMAND_SCHEMA, PREFIX

class Tests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory()
  self.db=str(Path(self.tmp.name)/"data"/"cmd.sqlite")
  self.store=Store(self.db)
  self.srv=create_server(self.store,port=0)
  self.t=threading.Thread(target=self.srv.serve_forever,daemon=True)
  self.t.start()
  self.url="http://127.0.0.1:"+str(self.srv.server_port)+PREFIX
  code=self.store.create_pair()
  status,obj=self.send("/v2/pair",{"pairing_code":code},auth=False)
  assert status==201
  self.token=obj["device_token"]
 def tearDown(self):
  self.srv.shutdown();self.srv.server_close();self.tmp.cleanup()
 def send(self,path,data,auth=True,method="POST"):
  req=urllib.request.Request(self.url+path,data=json.dumps(data,ensure_ascii=False).encode("utf-8"),
     headers={"Content-Type":"application/json",**({"Authorization":"Bearer "+self.token} if auth else {})},method=method)
  try:
   with urllib.request.urlopen(req,timeout=5) as r:return r.status,json.loads(r.read())
  except urllib.error.HTTPError as e:return e.code,json.loads(e.read())
 def get(self,path,auth=True):
  req=urllib.request.Request(self.url+path,headers=({"Authorization":"Bearer "+self.token} if auth else {}))
  try:
   with urllib.request.urlopen(req,timeout=5) as r:return r.status,json.loads(r.read())
  except urllib.error.HTTPError as e:return e.code,json.loads(e.read())
 def cmd(self,work="onshape",text="سلام دنیا",cid=None):
  return {"schema":COMMAND_SCHEMA,"command_id":cid or uuid.uuid4().hex,"text":text,"sha256":sha(text),"work_id":work}
 def test_health(self):
  st,r=self.get("/health",False);self.assertEqual(st,200);self.assertEqual(r["executed"],False)
 def test_authentication(self):
  st,_=self.get("/v2/works",False);self.assertEqual(st,401)
  st,_=self.send("/v2/commands",self.cmd(),False);self.assertEqual(st,401)
 def test_first_accept(self):
  st,r=self.send("/v2/commands",self.cmd());self.assertEqual(st,201)
  self.assertEqual(r["state"],"QUEUED");self.assertEqual(r["receipt"],"DURABLY_ACCEPTED")
  self.assertFalse(r["executed"])
 def test_duplicate_stable(self):
  c=self.cmd();a,x=self.send("/v2/commands",c);b,y=self.send("/v2/commands",c)
  self.assertEqual((a,b),(201,200));self.assertEqual(x["receipt_id"],y["receipt_id"]);self.assertTrue(y["duplicate"])
  self.assertEqual(self.store.count(),1)
 def test_changed_work_conflict(self):
  c=self.cmd();self.send("/v2/commands",c);c["work_id"]="docs"
  st,r=self.send("/v2/commands",c);self.assertEqual(st,409)
 def test_changed_text_conflict(self):
  c=self.cmd();self.send("/v2/commands",c);c["text"]="دیگر";c["sha256"]=sha("دیگر")
  st,_=self.send("/v2/commands",c);self.assertEqual(st,409)
 def test_digest_bad(self):
  c=self.cmd();c["sha256"]="0"*64;st,_=self.send("/v2/commands",c);self.assertEqual(st,400)
 def test_pair_is_one_time(self):
  code=self.store.create_pair();a,x=self.send("/v2/pair",{"pairing_code":code},False)
  b,y=self.send("/v2/pair",{"pairing_code":code},False)
  self.assertEqual((a,b),(201,403))
 def test_pair_secret_is_required(self):
  st,_=self.send("/v2/pair",{"pairing_code":"INVALIDCODE0001"},False);self.assertEqual(st,403)
 def test_three_works(self):
  for w in ("onshape","apk","docs"):self.send("/v2/commands",self.cmd(work=w))
  st,d=self.get("/v2/works");self.assertEqual(st,200)
  self.assertEqual({v["work_id"] for v in d["works"]},{"onshape","apk","docs"})
 def test_restart_idempotency(self):
  c=self.cmd();a,r=self.send("/v2/commands",c)
  fresh=Store(self.db);code,res=fresh.accept(c)
  self.assertEqual(code,200);self.assertEqual(res["receipt_id"],r["receipt_id"])
 def test_status(self):
  c=self.cmd();self.send("/v2/commands",c)
  st,r=self.get("/v2/commands/"+c["command_id"])
  self.assertEqual(st,200);self.assertEqual(r["executed"],False)
 def test_unknown_request(self):
  c=self.cmd();c["evil_execute"]=True
  st,_=self.send("/v2/commands",c);self.assertEqual(st,400)
 def test_utf8(self):
  c=self.cmd(text="رشته 🤖\nب",work=None);st,r=self.send("/v2/commands",c)
  self.assertEqual(st,201);self.assertIsNone(r["work_id"])
if __name__=="__main__":unittest.main(verbosity=2)
