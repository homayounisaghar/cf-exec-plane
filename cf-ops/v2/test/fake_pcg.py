import json, os, socket, sys, threading
P="/tmp/cfit/run/pcg.sock"
try: os.unlink(P)
except FileNotFoundError: pass
s=socket.socket(socket.AF_UNIX); s.bind(P); s.listen(8)
mode = {"fail": False}
def h(c):
    f=c.makefile("rwb"); req=json.loads(f.readline())
    if req.get("operation")=="communication.conversation.search":
        r={"state":"ACHIEVED","protected_provider_data":{"conversations":[{"name":"Saved Messages","handle":"tgchat:777"},{"name":"Other","handle":"tgchat:1"}]}}
    elif req.get("operation")=="communication.message.send":
        if os.path.exists("/tmp/cfit/run/pcg_fail"): r={"state":"FAILED","error":"PROVIDER_DOWN"}
        else:
            with open("/tmp/cfit/run/sent.jsonl","a") as o: o.write(json.dumps(req["args"])+"\n")
            r={"state":"ACHIEVED"}
    else: r={"state":"FAILED"}
    f.write((json.dumps(r)+"\n").encode()); f.flush(); c.close()
while True:
    c,_=s.accept(); threading.Thread(target=h,args=(c,),daemon=True).start()
