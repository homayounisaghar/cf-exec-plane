#!/usr/bin/env python3
"""Alpha5 telemetry tests: privacy, isolation, offline replay, concurrency, freshness."""
import json, tempfile, threading, time, unittest, urllib.request, urllib.error, uuid, os
from pathlib import Path
base=Path(__file__).parent
import service
from telemetry import TelemetryStore, RETENTION_MS, MAX_PER_DEVICE

class TelemetryTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory()
  self.store=service.Store(str(Path(self.temp.name)/"store.db"))
  self.telemetry=TelemetryStore(self.store)
  self.srv=service.create_server(self.store,port=0)
  threading.Thread(target=self.srv.serve_forever,daemon=True).start()
  self.url="http://127.0.0.1:"+str(self.srv.server_port)+service.PREFIX
  code=self.store.create_pair()
  self.status,self.enrolled=self.call("/v2/pair",{"pairing_code":code},token=None)
  assert self.status==201
  self.token=self.enrolled["device_token"]
  self.device_id=self.enrolled["device_id"]
  self.seq=0
 def tearDown(self):
  self.srv.shutdown();self.srv.server_close();self.temp.cleanup()
 def event(self,event_type="DIAGNOSTIC_PING",details=None,seq=None,id=None):
  self.seq+=1
  return {"schema":"cf.agentos.telemetry.v1","event_id":id or uuid.uuid4().hex,
    "seq":seq if seq is not None else self.seq,"version_code":5,"event_type":event_type,
    "occurred_at_ms":int(time.time()*1000),"details":details if details is not None else
      {"source":"MANUAL","pending":0,"acked":5}}
 def call(self,route,payload=None,token="default",method=None):
  if token=="default":token=getattr(self,"token",None)
  hdr={"Accept":"application/json"}
  if token:hdr["Authorization"]="Bearer "+token
  data=None
  if payload is not None:
   hdr["Content-Type"]="application/json"
   data=json.dumps(payload,ensure_ascii=False).encode()
  req=urllib.request.Request(self.url+route,data=data,headers=hdr,method=method)
  try:
   with urllib.request.urlopen(req,timeout=5) as r:return r.status,json.load(r)
  except urllib.error.HTTPError as e:return e.code,json.load(e)
 def test_01_health_no_telemetry_side_effect(self):
  self.assertEqual(self.call("/health",token=None)[0],200)
  self.assertEqual(self.store.count(),0)
 def test_02_device_paired_and_private_summary(self):
  s,r=self.call("/v3/telemetry/summary");self.assertEqual(s,200)
  self.assertEqual(r["device_id"],self.device_id);self.assertTrue(r["stale"])
  self.assertEqual(r["event_count"],0)
 def test_03_unauthorized_upload_rejected(self):
  s,r=self.call("/v3/telemetry",self.event(),token=None)
  self.assertEqual(s,401)
 def test_04_unauthorized_read_rejected(self):
  self.assertEqual(self.call("/v3/telemetry/summary",token=None)[0],401)
 def test_05_upload_accepted_and_readback(self):
  e=self.event("SPEAK_CAPTURED",{"source":"SPEAK","pending":1,"acked":5,"phase":"CAPTURED"})
  s,r=self.call("/v3/telemetry",e)
  self.assertEqual(s,201);self.assertEqual(r["state"],"RECORDED");self.assertFalse(r["executed"])
  s,d=self.call("/v3/telemetry/summary")
  self.assertEqual(d["last_seq"],e["seq"]);self.assertFalse(d["stale"])
  self.assertEqual(d["latest"]["details"]["pending"],1)
 def test_06_duplicate_stable_receipt(self):
  e=self.event();a,x=self.call("/v3/telemetry",e);b,y=self.call("/v3/telemetry",e)
  self.assertEqual((a,b),(201,200))
  self.assertEqual(x["received_at_ms"],y["received_at_ms"])
  self.assertTrue(y["duplicate"])
 def test_07_same_id_changed_payload_rejected(self):
  e=self.event();self.call("/v3/telemetry",e)
  e["details"]["acked"]=999
  self.assertEqual(self.call("/v3/telemetry",e)[0],409)
 def test_08_same_sequence_new_id_rejected(self):
  e=self.event();self.call("/v3/telemetry",e)
  e2=self.event(seq=e["seq"]);self.assertEqual(self.call("/v3/telemetry",e2)[0],409)
 def test_09_no_command_ever_created(self):
  for n in range(4):self.call("/v3/telemetry",self.event())
  self.assertEqual(self.store.count(),0)
 def test_10_extra_command_text_rejected(self):
  e=self.event();e["text"]="PRIVATE VOICE TRANSCRIPT"
  self.assertEqual(self.call("/v3/telemetry",e)[0],400)
 def test_11_details_secret_rejected(self):
  e=self.event(details={"source":"MANUAL","bearer_token":"PRIVATE"})
  self.assertEqual(self.call("/v3/telemetry",e)[0],400)
 def test_12_arbitrary_error_message_rejected(self):
  e=self.event(details={"error":"my token / credential"})
  self.assertEqual(self.call("/v3/telemetry",e)[0],400)
 def test_13_bad_event_type_rejected(self):
  e=self.event("AUDIO_UPLOAD")
  self.assertEqual(self.call("/v3/telemetry",e)[0],400)
 def test_14_old_client_command_compat(self):
  raw="normal command"
  command={"schema":"cf.agentos.command.v2","command_id":uuid.uuid4().hex,
           "text":raw,"sha256":service.sha(raw),"work_id":"apk-test"}
  s,r=self.call("/v2/commands",command)
  self.assertEqual(s,201)
  self.assertEqual(self.store.count(),1)
 def test_15_offline_replay_out_of_order(self):
  queued=[self.event("NETWORK_OFFLINE"),self.event("QUEUE_CAPTURED",{"source":"TYPE","pending":1}),
          self.event("NETWORK_RESTORED"),self.event("SYNC_ACK",{"source":"JOB","acked":6})]
  for e in [queued[2],queued[0],queued[1],queued[3]]:
   self.assertEqual(self.call("/v3/telemetry",e)[0],201)
  self.assertEqual(self.call("/v3/telemetry/summary")[1]["event_count"],4)
  self.assertEqual(self.call("/v3/telemetry",queued[0])[0],200)
 def test_16_cross_device_isolation(self):
  first=self.event();self.call("/v3/telemetry",first)
  code=self.store.create_pair();s,x=self.call("/v2/pair",{"pairing_code":code},token=None)
  second=x["device_token"]
  s,summary=self.call("/v3/telemetry/summary",token=second)
  self.assertEqual(summary["event_count"],0)
  self.assertNotEqual(summary["device_id"],self.device_id)
 def test_17_zero_bool_invalid_count(self):
  e=self.event(details={"pending":True});self.assertEqual(self.call("/v3/telemetry",e)[0],400)
 def test_18_persistent_after_store_restart(self):
  e=self.event();self.call("/v3/telemetry",e)
  restored=TelemetryStore(service.Store(self.store.filename))
  summary=restored.summary(self.device_id)
  self.assertEqual(summary["event_count"],1)
 def test_19_bounded_retention(self):
  now=int(time.time()*1000)
  with self.store.connect() as db:
   for i in range(60):
    db.execute("""INSERT INTO telemetry_events
      (device_id,event_id,seq,version_code,event_type,occurred_at_ms,received_at_ms,details_json,content_sha)
      VALUES(?,?,?,?,?,?,?,?,?)""",(self.device_id,uuid.uuid4().hex,i+1000,5,"APP_RESUME",
      now-RETENTION_MS-100000,now-RETENTION_MS-100000,"{}","test"))
  self.assertEqual(self.call("/v3/telemetry",self.event())[0],201)
  self.assertEqual(self.call("/v3/telemetry/summary")[1]["event_count"],1)
 def test_20_concurrent_duplicate(self):
  e=self.event()
  codes=[]
  from concurrent.futures import ThreadPoolExecutor
  with ThreadPoolExecutor(max_workers=8) as ex:
   for s,r in ex.map(lambda _: self.call("/v3/telemetry",e),range(18)):
    codes.append(s)
  self.assertEqual(codes.count(201),1);self.assertEqual(codes.count(200),17)
  self.assertEqual(self.call("/v3/telemetry/summary")[1]["event_count"],1)
 def test_21_wrong_version_rejected(self):
  e=self.event();e["version_code"]=4
  self.assertEqual(self.call("/v3/telemetry",e)[0],400)
 def test_22_old_timestamp_supported(self):
  e=self.event();e["occurred_at_ms"]=1600000000000
  self.assertEqual(self.call("/v3/telemetry",e)[0],201)
 def test_23_denied_mic_control_field(self):
  e=self.event();e["details"]["activate_microphone"]=True
  self.assertEqual(self.call("/v3/telemetry",e)[0],400)
 def test_24_owner_local_readback(self):
  self.call("/v3/telemetry",self.event())
  read=self.telemetry.read_owner(self.device_id[:8],limit=5)
  self.assertEqual(len(read),1)
  self.assertEqual(read[0]["events"][0]["event_type"],"DIAGNOSTIC_PING")
 def test_25_version6_event_stored_and_readback(self):
  e=self.event();e["version_code"]=6
  s,r=self.call("/v3/telemetry",e)
  self.assertEqual(s,201)
  self.assertEqual(r["state"],"RECORDED")
  with self.store.connect() as db:
   v=db.execute("SELECT version_code FROM telemetry_events WHERE device_id=? AND event_id=?",
       (self.device_id,e["event_id"])).fetchone()[0]
  self.assertEqual(v,6)
 def test_26_version6_repeat_exact_dedup(self):
  e=self.event();e["version_code"]=6
  self.assertEqual(self.call("/v3/telemetry",e)[0],201)
  self.assertEqual(self.call("/v3/telemetry",e)[0],200)
  self.assertEqual(self.call("/v3/telemetry/summary")[1]["event_count"],1)
 def test_27_version4_is_still_refused(self):
  e=self.event();e["version_code"]=4
  self.assertEqual(self.call("/v3/telemetry",e)[0],400)
 def test_28_version_string_is_refused(self):
  e=self.event();e["version_code"]="6"
  self.assertEqual(self.call("/v3/telemetry",e)[0],400)
 def test_29_version7_accepted_exactly_once(self):
  e=self.event();e["version_code"]=7
  s,r=self.call("/v3/telemetry",e)
  self.assertEqual(s,201)
  self.assertEqual(r["state"],"RECORDED")
  self.assertEqual(self.call("/v3/telemetry",e)[0],200)
  with self.store.connect() as db:
   row=db.execute("SELECT version_code FROM telemetry_events WHERE device_id=? AND event_id=?",
                  (self.device_id,e["event_id"])).fetchone()
  self.assertEqual(row[0],7)
 def test_30_version7_wrong_type_refused(self):
  e=self.event();e["version_code"]="7"
  self.assertEqual(self.call("/v3/telemetry",e)[0],400)
if __name__=="__main__": unittest.main(verbosity=2)
