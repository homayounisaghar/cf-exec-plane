#!/usr/bin/env python3
import hashlib, json, pathlib, subprocess, time, urllib.request, urllib.error, re, signal
stage=pathlib.Path("/home/cfserver/dexa-lite-stage-20261103")
script=(stage/"lite-gateway.mjs").read_text()
testdir=stage/"local-test"
testdir.mkdir(mode=0o700,exist_ok=True)
user,password="testowner","example-only-local-fixture"
(testdir/"credentials.json").write_text(json.dumps({
 "username":user,"passwordSha256":hashlib.sha256(password.encode()).hexdigest()}))
copy=script.replace("9518","9519").replace(
 'const BASE="/home/cfserver/.local/share/dexa-mobile-gateway-20261023"',
 'const BASE="'+str(testdir)+'"').replace(
 '/home/cfserver/.local/share/dexa-lite-20261103/lite.css',
 str(stage/"lite.css"))
if copy==script or "9518" in copy:raise RuntimeError("TEST_COPY_NOT_ISOLATED")
(testdir/"test-gateway.mjs").write_text(copy)
node=subprocess.Popen(["node",str(testdir/"test-gateway.mjs")],
 stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,start_new_session=True)
base="http://127.0.0.1:9519"
auth="Basic "+__import__("base64").b64encode(f"{user}:{password}".encode()).decode()
def call(path,auth_header=None,method="GET",origin=None):
 h={"Host":"127.0.0.1:9519"}
 if auth_header:h["Authorization"]=auth_header
 if origin:h["Origin"]=origin
 request=urllib.request.Request(base+path,method=method,headers=h,
                                data=b"{}" if method=="POST" else None)
 try:
  with urllib.request.urlopen(request,timeout=12) as response:
   return response.status,response.read(),dict(response.headers)
 except urllib.error.HTTPError as e:
  return e.code,e.read(),dict(e.headers)
try:
 for _ in range(40):
  if node.poll() is not None:raise RuntimeError("NODE_EXITED")
  try:
   status,body,_=call("/_local-health")
   if status==200:break
  except Exception:time.sleep(.15)
 else:raise RuntimeError("LITE_NOT_LISTENING")
 tests={}
 tests["loopback_health"]=json.loads(body)["ok"] is True
 tests["auth_required"]=call("/dexa-lite/")[0]==401
 tests["bad_auth_rejected"]=call("/dexa-lite/","Basic dGVzdDp3cm9uZw==")[0]==401
 code,page,headers=call("/dexa-lite/",auth)
 html=page.decode("utf8","replace")
 tests["real_core_html_200"]=code==200 and "<html" in html
 tests["telegram_label_removed"]=("تلگرام (فقط‌خواندنی)" not in html and
                                    'id="telegramMvpMode" type="checkbox" hidden' in html)
 tests["catalog_not_injected"]="mobile-catalog-ui.js" not in html and "mobile-root-otp.js" not in html
 tests["session_draft_preserved"]="dexa.lite.draft.v1" in html
 tests["public_diagnostic"]=call("/dexa-lite/check")[0]==200
 tests["api_rewritten"]='"/dexa-lite/api/missions' in html
 tests["history_five_default"]='<option value="5" selected>' in html
 tests["no_external_dependencies"]=not bool(re.search(
   r'<(?:script|link)[^>]+(?:src|href)="https?://',html))
 tests["no_external_css"]='@import url(http' not in html and '@import "http' not in html
 tests["catalog_route_closed"]=call("/dexa-lite/catalog/anything",auth)[0]==404
 tests["bridge_route_closed"]=call("/dexa-lite/bridge/anything",auth)[0]==404
 tests["cross_origin_post_rejected"]=call("/dexa-lite/api/missions",auth,
                                           method="POST",origin="https://wrong.example")[0]==403
 code,raw,headers=call("/dexa-lite/api/form/challenge",auth)
 challenge=json.loads(raw)
 tests["real_api_challenge"]=code==200 and len(challenge.get("token",""))==43
 tests["cookie_scoped"]=any("/dexa-lite/" in str(x) for x in headers.items()
                            if x[0].lower()=="set-cookie")
 code,raw,_=call("/dexa-lite/healthz",auth)
 tests["real_core_health"]=code==200 and json.loads(raw).get("ok") is True
 failures=[name for name,ok in tests.items() if not ok]
 print(json.dumps({"passed":len(tests)-len(failures),"total":len(tests),
                   "failed":failures,"realCoreGET":True},ensure_ascii=False))
 if failures:raise SystemExit(2)
finally:
 try:node.terminate();node.wait(timeout=3)
 except Exception:node.kill()
