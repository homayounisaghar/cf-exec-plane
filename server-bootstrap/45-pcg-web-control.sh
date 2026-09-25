#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo "must run as uid 0" >&2; exit 1; }
mode="${CF_PCG_WEB_CONTROL_MODE:-}"
case "$mode" in prepare|status|ingress-diagnostic|semantic-status|semantic-conversations|semantic-conversations-protected|semantic-conversations-canary|semantic-search-canary|semantic-messages-protected|semantic-messages-canary|semantic-mark-read-canary|semantic-open-media-canary|semantic-download-canary|semantic-composer-canary|phone|code|password|cleanup|screenshot|refresh-screenshot|mytelegram-start|mytelegram-capture-code|mytelegram-signin|mytelegram-create-app|mytelegram-screenshot) ;; *) echo "invalid mode" >&2; exit 2 ;; esac

run_root=/var/lib/capability-fabric/pcg/run
socket="$run_root/web.sock"
key_root=/run/capability-fabric/pcg-web-control
private_key="$key_root/ephemeral-rsa.pem"
public_key="$key_root/ephemeral-rsa.pub.pem"

for cmd in python3 openssl base64 docker flock; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "missing required tool: $cmd" >&2; exit 20; }
done

active=/opt/capability-fabric/channels/pcg/current
[[ -L "$active" ]] || { echo "PCG_WEB_ACTIVE_RELEASE=missing" >&2; exit 21; }
release="$(readlink -f "$active")"
[[ -s "$release/manifest.json" ]] || exit 21
python3 - "$release/manifest.json" <<'PY'
import json,sys
m=json.load(open(sys.argv[1],encoding='utf-8'))
if int(m.get('sequence',0)) < 6:
    raise SystemExit('Telegram Web control requires PCG sequence >= 6')
PY

cid="$(docker ps --filter name='^/capability-fabric-pcg-web$' --format '{{.ID}}' | head -n1)"
[[ -n "$cid" ]] || { echo "PCG_WEB_CONTAINER=absent" >&2; exit 22; }
[[ "$(docker inspect -f '{{.State.Health.Status}}' "$cid")" == healthy ]] || { echo "PCG_WEB_CONTAINER=unhealthy" >&2; exit 22; }
[[ -S "$socket" ]] || { echo "PCG_WEB_SOCKET=absent" >&2; exit 22; }

socket_simple() {
  local op="$1"
  python3 - "$socket" "$op" <<'PY'
import json,socket,sys
sock_path,op=sys.argv[1:]
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.settimeout(35)
s.connect(sock_path)
s.sendall((json.dumps({'op':op},separators=(',',':'))+'\n').encode())
buf=b''
while b'\n' not in buf:
    chunk=s.recv(65536)
    if not chunk: break
    buf+=chunk
s.close()
if not buf: raise SystemExit('empty browser response')
d=json.loads(buf.split(b'\n',1)[0])
safe={k:d.get(k) for k in ('ok','phase','origin','pathname','logged_in','error') if k in d}
print(json.dumps(safe,separators=(',',':')))
if not d.get('ok'): raise SystemExit(40)
PY
}


socket_semantic() {
  local operation="$1"
  local purpose="${2:-}"
  python3 - "$socket" "$operation" "$purpose" <<'PY'
import json,socket,sys
sock_path,operation,purpose=sys.argv[1:]
payload={'op':'semantic.invoke','operation':operation,'args':{}}
if operation == 'communication.conversation.list':
    payload['args']={'limit':20}
if purpose:
    payload['purpose']=purpose
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.settimeout(35)
s.connect(sock_path)
s.sendall((json.dumps(payload,separators=(',',':'))+'\n').encode())
buf=b''
while b'\n' not in buf:
    chunk=s.recv(65536)
    if not chunk:
        break
    buf+=chunk
s.close()
if not buf:
    raise SystemExit('empty browser response')
d=json.loads(buf.split(b'\n',1)[0])
safe={k:d.get(k) for k in ('ok','state','operation','provider','realization','error') if k in d}
obs=d.get('observation')
if isinstance(obs,dict):
    allowed=('connection_state','logged_in','count','handles','bounded','provider_content_model_visible')
    safe['observation']={k:obs.get(k) for k in allowed if k in obs}
print(json.dumps(safe,separators=(',',':')))
if d.get('state') != 'ACHIEVED':
    raise SystemExit(40)
PY
}


socket_semantic_conversation_contract() {
  python3 - "$socket" <<'PY'
import collections,json,socket,sys
sock_path=sys.argv[1]
payload={
    'op':'semantic.invoke',
    'operation':'communication.conversation.list',
    'purpose':'PROTECTED_DISPLAY',
    'args':{'limit':10},
}
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.settimeout(35)
s.connect(sock_path)
s.sendall((json.dumps(payload,separators=(',',':'))+'\n').encode())
buf=b''
while b'\n' not in buf:
    chunk=s.recv(65536)
    if not chunk:
        break
    buf+=chunk
s.close()
if not buf:
    raise SystemExit('empty browser response')
d=json.loads(buf.split(b'\n',1)[0])
assert d.get('state') == 'ACHIEVED'
obs=d.get('observation')
assert isinstance(obs,dict)
assert obs.get('count') == 10
assert obs.get('provider_content_model_visible') is False
protected=d.get('protected_provider_data')
assert isinstance(protected,dict)
assert protected.get('purpose') == 'PROTECTED_DISPLAY'
assert protected.get('model_visible') is False
conversations=protected.get('conversations')
assert isinstance(conversations,list) and len(conversations) == 10
counts=collections.Counter()
for item in conversations:
    assert isinstance(item,dict)
    assert isinstance(item.get('handle'),str) and item['handle'].startswith('tgchat:')
    assert isinstance(item.get('name'),str) and 1 <= len(item['name']) <= 256
    assert item.get('type') in ('user','chat','channel')
    assert set(item) == {'handle','name','type'}
    counts[item['type']]+=1
safe={
    'ok':True,
    'state':'ACHIEVED',
    'operation':'communication.conversation.list',
    'count':10,
    'type_counts':{k:counts.get(k,0) for k in ('user','chat','channel')},
    'protected_provider_data_valid':True,
    'provider_content_model_visible':False,
}
print(json.dumps(safe,separators=(',',':')))
PY
}


socket_qualification() {
  python3 - "$socket" <<'PY'
import json,socket,sys
sock_path=sys.argv[1]
payload={'op':'qualify.conversation_list_no_read'}
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.settimeout(40)
s.connect(sock_path)
s.sendall((json.dumps(payload,separators=(',',':'))+'\n').encode())
buf=b''
while b'\n' not in buf:
    chunk=s.recv(65536)
    if not chunk:
        break
    buf+=chunk
s.close()
if not buf:
    raise SystemExit('empty browser response')
d=json.loads(buf.split(b'\n',1)[0])
safe={k:d.get(k) for k in ('ok','state','operation','provider','realization','error') if k in d}
obs=d.get('observation')
if isinstance(obs,dict):
    allowed=('canary_present','canary_handle','unread_before','unread_after','list_state','provider_content_model_visible')
    safe['observation']={k:obs.get(k) for k in allowed if k in obs}
print(json.dumps(safe,separators=(',',':')))
state=d.get('state')
if state == 'ACHIEVED':
    raise SystemExit(0)
if state == 'QUALIFICATION_REQUIRED':
    raise SystemExit(42)
raise SystemExit(40)
PY
}

socket_search_qualification() {
  python3 - "$socket" <<'PY'
import json,socket,sys
sock_path=sys.argv[1]
payload={'op':'qualify.conversation_search_no_read'}
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.settimeout(45)
s.connect(sock_path)
s.sendall((json.dumps(payload,separators=(',',':'))+'\n').encode())
buf=b''
while b'\n' not in buf:
    chunk=s.recv(65536)
    if not chunk:
        break
    buf+=chunk
s.close()
if not buf:
    raise SystemExit('empty browser response')
d=json.loads(buf.split(b'\n',1)[0])
safe={k:d.get(k) for k in ('ok','state','operation','provider','realization','error') if k in d}
obs=d.get('observation')
if isinstance(obs,dict):
    allowed=(
        'canary_present','canary_handle','unread_before','unread_after',
        'search_state','search_count','canary_found','navigation_unchanged',
        'selection_resolved','provider_content_model_visible'
    )
    safe['observation']={k:obs.get(k) for k in allowed if k in obs}
print(json.dumps(safe,separators=(',',':')))
state=d.get('state')
if state == 'ACHIEVED':
    raise SystemExit(0)
if state == 'QUALIFICATION_REQUIRED':
    raise SystemExit(42)
raise SystemExit(40)
PY
}

socket_message_contract() {
  python3 - "$socket" <<'PY'
import json,socket,sys
sock_path=sys.argv[1]

def call(payload, timeout=45):
    s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
    s.settimeout(timeout)
    s.connect(sock_path)
    s.sendall((json.dumps(payload,separators=(',',':'))+'\n').encode())
    buf=b''
    while b'\n' not in buf:
        chunk=s.recv(65536)
        if not chunk:
            break
        buf+=chunk
    s.close()
    if not buf:
        raise SystemExit('empty browser response')
    return json.loads(buf.split(b'\n',1)[0])

conversations=call({
    'op':'semantic.invoke',
    'operation':'communication.conversation.list',
    'purpose':'PROTECTED_DISPLAY',
    'args':{'limit':10},
})
if conversations.get('state') != 'ACHIEVED':
    print(json.dumps({'ok':False,'state':conversations.get('state'),'error':conversations.get('error')},separators=(',',':')))
    raise SystemExit(40)

protected=conversations.get('protected_provider_data')
items=protected.get('conversations') if isinstance(protected,dict) else None
if not isinstance(items,list) or not items:
    print(json.dumps({'ok':False,'error':'NO_CONVERSATION_CANDIDATE'},separators=(',',':')))
    raise SystemExit(40)

first_error=None
for conversation in items:
    handle=conversation.get('handle') if isinstance(conversation,dict) else None
    if not isinstance(handle,str) or not handle.startswith('tgchat:'):
        continue
    listed=call({
        'op':'semantic.invoke',
        'operation':'communication.message.list',
        'purpose':'PROTECTED_DISPLAY',
        'args':{'conversation_handle':handle,'limit':5},
    })
    if listed.get('state') != 'ACHIEVED':
        first_error=first_error or listed.get('error') or 'MESSAGE_LIST_FAILED'
        continue
    obs=listed.get('observation')
    pdata=listed.get('protected_provider_data')
    messages=pdata.get('messages') if isinstance(pdata,dict) else None
    if not isinstance(obs,dict) or not isinstance(messages,list) or not messages:
        first_error=first_error or 'NO_MESSAGE_CANDIDATE'
        continue
    if obs.get('provider_content_model_visible') is not False:
        first_error=first_error or 'MESSAGE_LIST_MODEL_VISIBILITY_INVALID'
        continue
    if pdata.get('purpose') != 'PROTECTED_DISPLAY' or pdata.get('model_visible') is not False:
        first_error=first_error or 'MESSAGE_LIST_PROTECTED_CONTRACT_INVALID'
        continue

    valid=True
    for message in messages:
        if not isinstance(message,dict):
            valid=False; break
        expected={'handle','kind','text','date','outgoing','media_type','media_open_kind','media_unread','attachments','service_action'}
        if set(message) != expected:
            valid=False; break
        if not isinstance(message.get('handle'),str) or not message['handle'].startswith('tgmsg:'):
            valid=False; break
        if not isinstance(message.get('text'),str) or len(message['text']) > 4096:
            valid=False; break
        if message.get('date') is not None and not isinstance(message.get('date'),int):
            valid=False; break
        if not isinstance(message.get('outgoing'),bool):
            valid=False; break
        if message.get('media_open_kind') not in (None,'voice','round_video'):
            valid=False; break
        if not isinstance(message.get('media_unread'),bool):
            valid=False; break
        attachments=message.get('attachments')
        if not isinstance(attachments,list):
            valid=False; break
        for attachment in attachments:
            if not isinstance(attachment,dict):
                valid=False; break
            if set(attachment) != {'handle','media_type','size_bytes','filename'}:
                valid=False; break
            if not isinstance(attachment.get('handle'),str) or not attachment['handle'].startswith('tgatt:'):
                valid=False; break
            if not isinstance(attachment.get('media_type'),str) or not attachment['media_type']:
                valid=False; break
            if attachment.get('size_bytes') is not None and (
                not isinstance(attachment.get('size_bytes'),int) or attachment['size_bytes'] < 1
            ):
                valid=False; break
            if attachment.get('filename') is not None and (
                not isinstance(attachment.get('filename'),str)
                or not attachment['filename']
                or len(attachment['filename']) > 512
            ):
                valid=False; break
        if not valid:
            break
    if not valid:
        first_error=first_error or 'MESSAGE_LIST_ENTRY_INVALID'
        continue

    message_handle=messages[0]['handle']
    fetched=call({
        'op':'semantic.invoke',
        'operation':'communication.message.fetch',
        'purpose':'PROTECTED_DISPLAY',
        'args':{'conversation_handle':handle,'message_handle':message_handle},
    })
    if fetched.get('state') != 'ACHIEVED':
        first_error=first_error or fetched.get('error') or 'MESSAGE_FETCH_FAILED'
        continue
    fobs=fetched.get('observation')
    fpdata=fetched.get('protected_provider_data')
    message=fpdata.get('message') if isinstance(fpdata,dict) else None
    valid_fetch=(
        isinstance(fobs,dict)
        and fobs.get('message_handle') == message_handle
        and fobs.get('provider_content_model_visible') is False
        and fpdata.get('purpose') == 'PROTECTED_DISPLAY'
        and fpdata.get('model_visible') is False
        and isinstance(message,dict)
        and message.get('handle') == message_handle
    )
    if not valid_fetch:
        first_error=first_error or 'MESSAGE_FETCH_PROTECTED_CONTRACT_INVALID'
        continue

    safe={
        'ok':True,
        'state':'ACHIEVED',
        'list_count':obs.get('count'),
        'message_handles_valid':all(m['handle'].startswith('tgmsg:') for m in messages),
        'fetch_identity_stable':True,
        'protected_provider_data_valid':True,
        'provider_content_model_visible':False,
    }
    print(json.dumps(safe,separators=(',',':')))
    raise SystemExit(0)

print(json.dumps({'ok':False,'error':first_error or 'NO_MESSAGE_CANDIDATE'},separators=(',',':')))
raise SystemExit(40)
PY
}

socket_message_qualification() {
  python3 - "$socket" <<'PY'
import json,socket,sys
sock_path=sys.argv[1]
payload={'op':'qualify.message_retrieval_no_read'}
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.settimeout(55)
s.connect(sock_path)
s.sendall((json.dumps(payload,separators=(',',':'))+'\n').encode())
buf=b''
while b'\n' not in buf:
    chunk=s.recv(65536)
    if not chunk:
        break
    buf+=chunk
s.close()
if not buf:
    raise SystemExit('empty browser response')
d=json.loads(buf.split(b'\n',1)[0])
safe={k:d.get(k) for k in ('ok','state','operation','provider','realization','error') if k in d}
obs=d.get('observation')
if isinstance(obs,dict):
    allowed=(
        'canary_present','unread_before','unread_after','list_state','list_count',
        'fetch_state','message_identity_stable','navigation_unchanged',
        'media_open_invoked','provider_content_model_visible'
    )
    safe['observation']={k:obs.get(k) for k in allowed if k in obs}
print(json.dumps(safe,separators=(',',':')))
state=d.get('state')
if state == 'ACHIEVED':
    raise SystemExit(0)
if state == 'QUALIFICATION_REQUIRED':
    raise SystemExit(42)
raise SystemExit(40)
PY
}

socket_mark_read_qualification() {
  python3 - "$socket" <<'PY'
import json,socket,sys
sock_path=sys.argv[1]
payload={'op':'qualify.conversation_mark_read'}
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.settimeout(70)
s.connect(sock_path)
s.sendall((json.dumps(payload,separators=(',',':'))+'\n').encode())
buf=b''
while b'\n' not in buf:
    chunk=s.recv(65536)
    if not chunk:
        break
    buf+=chunk
s.close()
if not buf:
    raise SystemExit('empty browser response')
d=json.loads(buf.split(b'\n',1)[0])
safe={k:d.get(k) for k in ('ok','state','operation','provider','realization','error') if k in d}
obs=d.get('observation')
if isinstance(obs,dict):
    allowed=(
        'canary_present','target_was_unread','target_read_after',
        'provider_observation_before','provider_observation_after',
        'effect_attempted','effect_invocation_acknowledged','provider_confirmed',
        'unrelated_unread_preserved','navigation_unchanged',
        'provider_content_model_visible'
    )
    safe['observation']={k:obs.get(k) for k in allowed if k in obs}
print(json.dumps(safe,separators=(',',':')))
state=d.get('state')
if state == 'ACHIEVED':
    raise SystemExit(0)
if state == 'QUALIFICATION_REQUIRED':
    raise SystemExit(42)
if state == 'IN_DOUBT':
    raise SystemExit(43)
raise SystemExit(40)
PY
}

socket_open_media_qualification() {
  python3 - "$socket" <<'PY'
import json,socket,sys
sock_path=sys.argv[1]
payload={'op':'qualify.message_open_media'}
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.settimeout(90)
s.connect(sock_path)
s.sendall((json.dumps(payload,separators=(',',':'))+'\n').encode())
buf=b''
while b'\n' not in buf:
    chunk=s.recv(65536)
    if not chunk:
        break
    buf+=chunk
s.close()
if not buf:
    raise SystemExit('empty browser response')
d=json.loads(buf.split(b'\n',1)[0])
safe={k:d.get(k) for k in ('ok','state','operation','provider','realization','error') if k in d}
obs=d.get('observation')
if isinstance(obs,dict):
    allowed=(
        'canary_present','media_kind','admitted_media_kinds',
        'target_media_unread_before','target_media_unread_after',
        'effect_attempted','effect_invocation_acknowledged','provider_confirmed',
        'unrelated_unread_preserved','navigation_unchanged',
        'provider_content_model_visible'
    )
    safe['observation']={k:obs.get(k) for k in allowed if k in obs}
print(json.dumps(safe,separators=(',',':')))
state=d.get('state')
if state == 'ACHIEVED':
    raise SystemExit(0)
if state == 'QUALIFICATION_REQUIRED':
    raise SystemExit(42)
if state == 'IN_DOUBT':
    raise SystemExit(43)
raise SystemExit(40)
PY
}

socket_download_qualification() {
  python3 - "$socket" <<'PY'
import json,socket,sys
sock_path=sys.argv[1]
payload={'op':'qualify.attachment_download'}
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.settimeout(120)
s.connect(sock_path)
s.sendall((json.dumps(payload,separators=(',',':'))+'\n').encode())
buf=b''
while b'\n' not in buf:
    chunk=s.recv(65536)
    if not chunk:
        break
    buf+=chunk
s.close()
if not buf:
    raise SystemExit('empty browser response')
d=json.loads(buf.split(b'\n',1)[0])
safe={k:d.get(k) for k in ('ok','state','operation','provider','realization','error') if k in d}
obs=d.get('observation')
if isinstance(obs,dict):
    allowed=(
        'canary_present','admitted_attachment_slots','attachment_slot',
        'local_file_acquired','file_handle_opaque','broker_verified','cleanup_confirmed',
        'provider_restriction_checked','provider_state_checked','provider_state_unchanged',
        'target_read_state_unchanged','target_media_unread_unchanged',
        'target_unread_preserved','unrelated_unread_preserved',
        'navigation_unchanged','provider_content_model_visible'
    )
    safe['observation']={k:obs.get(k) for k in allowed if k in obs}
print(json.dumps(safe,separators=(',',':')))
state=d.get('state')
if state == 'ACHIEVED':
    raise SystemExit(0)
if state == 'QUALIFICATION_REQUIRED':
    raise SystemExit(42)
if state == 'IN_DOUBT':
    raise SystemExit(43)
raise SystemExit(40)
PY
}

socket_composer_qualification() {
  python3 - "$socket" <<'PY'
import json,socket,sys
sock_path=sys.argv[1]
payload={'op':'qualify.composer_foundation'}
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.settimeout(150)
s.connect(sock_path)
s.sendall((json.dumps(payload,separators=(',',':'))+'\n').encode())
buf=b''
while b'\n' not in buf:
    chunk=s.recv(65536)
    if not chunk:
        break
    buf+=chunk
s.close()
if not buf:
    raise SystemExit('empty browser response')
d=json.loads(buf.split(b'\n',1)[0])
safe={k:d.get(k) for k in ('ok','state','operation','provider','realization','error') if k in d}
obs=d.get('observation')
if isinstance(obs,dict):
    allowed=(
        'canary_present','candidate_count','target_handle','target_resolved',
        'unknown_target_fail_closed','local_before_present','local_composer_set',
        'local_composer_restored','provider_draft_unchanged',
        'provider_message_top_unchanged','provider_read_state_unchanged',
        'server_draft_write_invoked','send_primitive_invoked','typing_primitive_invoked',
        'target_was_unread','target_unread_preserved','unrelated_unread_preserved',
        'navigation_unchanged','provider_content_model_visible'
    )
    safe['observation']={k:obs.get(k) for k in allowed if k in obs}
print(json.dumps(safe,separators=(',',':')))
state=d.get('state')
if state == 'ACHIEVED':
    raise SystemExit(0)
if state == 'QUALIFICATION_REQUIRED':
    raise SystemExit(42)
raise SystemExit(40)
PY
}

if [[ "$mode" == prepare ]]; then
  install -d -m 0700 -o root -g root "$key_root"
  rm -f "$private_key" "$public_key"
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$private_key" >/dev/null 2>&1
  chmod 0600 "$private_key"
  openssl pkey -in "$private_key" -pubout -out "$public_key" >/dev/null 2>&1
  chmod 0644 "$public_key"
  socket_simple open
  printf 'PCG_WEB_PUBLIC_KEY_PEM_B64=%s\n' "$(base64 -w0 < "$public_key")"
  printf 'PCG_WEB_CONTROL_PREPARE=pass\n'
  exit 0
fi

if [[ "$mode" == status ]]; then
  python3 - "$release/manifest.json" <<'PY'
import json,sys
m=json.load(open(sys.argv[1],encoding='utf-8'))
print(f"PCG_WEB_ACTIVE_SEQUENCE={int(m.get('sequence',0))}")
print(f"PCG_WEB_ACTIVE_RELEASE={m.get('release_id','UNKNOWN')}")
PY
  socket_simple health
  exit 0
fi

if [[ "$mode" == ingress-diagnostic ]]; then
  stat -c 'PCG_HOST_RUN_MODE=%a OWNER=%u:%g' "$run_root"
  stat -c 'PCG_HOST_SOCKET_MODE=%a OWNER=%u:%g' "$socket"
  docker exec -i capability-fabric-onshape-server node <<'JS'
const fs = require("node:fs");
const net = require("node:net");
const path = "/run/pcg/web.sock";
console.log("INGRESS_UID=" + process.getuid() + " GID=" + process.getgid());
try {
  const st = fs.statSync(path);
  console.log("INGRESS_SOCKET_PRESENT=" + st.isSocket() + " MODE=" + (st.mode & 0o777).toString(8) + " OWNER=" + st.uid + ":" + st.gid);
} catch (e) {
  console.log("INGRESS_STAT_ERROR=" + (e.code || "UNKNOWN"));
  process.exit(30);
}
const socket = net.createConnection({ path });
socket.setEncoding("utf8");
socket.setTimeout(5000);
let buffer = "";
socket.once("connect", () => {
  console.log("INGRESS_CONNECT=pass");
  socket.write('{"op":"semantic.invoke","operation":"communication.conversation.list","purpose":"PROTECTED_DISPLAY","args":{"limit":10}}\n');
});
socket.on("data", chunk => {
  buffer += chunk;
  if (buffer.includes("\n")) {
    try {
      const result = JSON.parse(buffer.split("\n", 1)[0]);
      const items = result.protected_provider_data?.conversations;
      const valid = result.state === "ACHIEVED" && result.operation === "communication.conversation.list"
        && result.observation?.count === 10 && result.observation?.provider_content_model_visible === false
        && result.protected_provider_data?.purpose === "PROTECTED_DISPLAY"
        && result.protected_provider_data?.model_visible === false
        && Array.isArray(items) && items.length === 10
        && items.every(x => typeof x.name === "string" && ["user", "chat", "channel"].includes(x.type));
      console.log("INGRESS_CONTRACT_VALID=" + valid + " COUNT=" + (result.observation?.count ?? "unknown"));
      if (!valid) process.exitCode = 32;
      socket.destroy();
    } catch {
      console.log("INGRESS_HEALTH_INVALID=1");
      process.exitCode = 32;
      socket.destroy();
    }
  }
});
socket.once("timeout", () => {
  console.log("INGRESS_CONNECT_ERROR=TIMEOUT");
  process.exitCode = 33;
  socket.destroy();
});
socket.once("error", e => {
  console.log("INGRESS_CONNECT_ERROR=" + (e.code || "UNKNOWN"));
  process.exitCode = 34;
});
JS
  exit 0
fi

if [[ "$mode" == semantic-status || "$mode" == semantic-conversations ]]; then
  sequence="$(python3 - "$release/manifest.json" <<'PY'
import json,sys
print(int(json.load(open(sys.argv[1],encoding='utf-8')).get('sequence',0)))
PY
)"
  [[ "$sequence" -ge 18 ]] || { echo "PCG_WEB_SEMANTIC_RUNTIME=too-old" >&2; exit 29; }
  if [[ "$mode" == semantic-status ]]; then
    socket_semantic communication.session.status
  else
    socket_semantic communication.conversation.list PROTECTED_DISPLAY
  fi
  printf 'PCG_WEB_SEMANTIC_%s=pass\n' "${mode#semantic-}"
  exit 0
fi

if [[ "$mode" == semantic-conversations-protected ]]; then
  sequence="$(python3 - "$release/manifest.json" <<'PY'
import json,sys
print(int(json.load(open(sys.argv[1],encoding='utf-8')).get('sequence',0)))
PY
)"
  [[ "$sequence" -ge 20 ]] || { echo "PCG_WEB_CONVERSATION_TYPES_RUNTIME=too-old" >&2; exit 31; }
  socket_semantic_conversation_contract
  printf 'PCG_WEB_CONVERSATION_TYPES=pass\n'
  exit 0
fi

if [[ "$mode" == semantic-conversations-canary ]]; then
  sequence="$(python3 - "$release/manifest.json" <<'PY'
import json,sys
print(int(json.load(open(sys.argv[1],encoding='utf-8')).get('sequence',0)))
PY
)"
  [[ "$sequence" -ge 19 ]] || { echo "PCG_WEB_SEMANTIC_CANARY_RUNTIME=too-old" >&2; exit 30; }
  set +e
  socket_qualification
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    printf 'PCG_WEB_UNREAD_CANARY=pass\n'
    exit 0
  fi
  if [[ "$rc" -eq 42 ]]; then
    printf 'PCG_WEB_UNREAD_CANARY=qualification-required\n'
    exit 0
  fi
  exit "$rc"
fi

if [[ "$mode" == semantic-search-canary ]]; then
  sequence="$(python3 - "$release/manifest.json" <<'PY'
import json,sys
print(int(json.load(open(sys.argv[1],encoding='utf-8')).get('sequence',0)))
PY
)"
  [[ "$sequence" -ge 23 ]] || { echo "PCG_WEB_SEARCH_RUNTIME=too-old" >&2; exit 32; }
  set +e
  socket_search_qualification
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    printf 'PCG_WEB_SEARCH_CANARY=pass\n'
    exit 0
  fi
  if [[ "$rc" -eq 42 ]]; then
    printf 'PCG_WEB_SEARCH_CANARY=qualification-required\n'
    exit 0
  fi
  exit "$rc"
fi

if [[ "$mode" == semantic-messages-protected ]]; then
  sequence="$(python3 - "$release/manifest.json" <<'PY'
import json,sys
print(int(json.load(open(sys.argv[1],encoding='utf-8')).get('sequence',0)))
PY
)"
  [[ "$sequence" -ge 25 ]] || { echo "PCG_WEB_MESSAGE_RUNTIME=too-old" >&2; exit 33; }
  socket_message_contract
  printf 'PCG_WEB_MESSAGE_PROTECTED_CONTRACT=pass\n'
  exit 0
fi

if [[ "$mode" == semantic-messages-canary ]]; then
  sequence="$(python3 - "$release/manifest.json" <<'PY'
import json,sys
print(int(json.load(open(sys.argv[1],encoding='utf-8')).get('sequence',0)))
PY
)"
  [[ "$sequence" -ge 25 ]] || { echo "PCG_WEB_MESSAGE_RUNTIME=too-old" >&2; exit 33; }
  set +e
  socket_message_qualification
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    printf 'PCG_WEB_MESSAGE_CANARY=pass\n'
    exit 0
  fi
  if [[ "$rc" -eq 42 ]]; then
    printf 'PCG_WEB_MESSAGE_CANARY=qualification-required\n'
    exit 0
  fi
  exit "$rc"
fi

if [[ "$mode" == semantic-mark-read-canary ]]; then
  sequence="$(python3 - "$release/manifest.json" <<'PY'
import json,sys
print(int(json.load(open(sys.argv[1],encoding='utf-8')).get('sequence',0)))
PY
)"
  [[ "$sequence" -ge 26 ]] || { echo "PCG_WEB_MARK_READ_RUNTIME=too-old" >&2; exit 34; }
  set +e
  socket_mark_read_qualification
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    printf 'PCG_WEB_MARK_READ_CANARY=pass\n'
    exit 0
  fi
  if [[ "$rc" -eq 42 ]]; then
    printf 'PCG_WEB_MARK_READ_CANARY=qualification-required\n'
    exit 0
  fi
  if [[ "$rc" -eq 43 ]]; then
    printf 'PCG_WEB_MARK_READ_CANARY=in-doubt\n' >&2
    exit 43
  fi
  exit "$rc"
fi

if [[ "$mode" == semantic-open-media-canary ]]; then
  sequence="$(python3 - "$release/manifest.json" <<'PY'
import json,sys
print(int(json.load(open(sys.argv[1],encoding='utf-8')).get('sequence',0)))
PY
)"
  [[ "$sequence" -ge 27 ]] || { echo "PCG_WEB_OPEN_MEDIA_RUNTIME=too-old" >&2; exit 35; }
  set +e
  socket_open_media_qualification
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    printf 'PCG_WEB_OPEN_MEDIA_CANARY=pass\n'
    exit 0
  fi
  if [[ "$rc" -eq 42 ]]; then
    printf 'PCG_WEB_OPEN_MEDIA_CANARY=qualification-required\n'
    exit 0
  fi
  if [[ "$rc" -eq 43 ]]; then
    printf 'PCG_WEB_OPEN_MEDIA_CANARY=in-doubt\n' >&2
    exit 43
  fi
  exit "$rc"
fi

if [[ "$mode" == semantic-download-canary ]]; then
  sequence="$(python3 - "$release/manifest.json" <<'PY'
import json,sys
print(int(json.load(open(sys.argv[1],encoding='utf-8')).get('sequence',0)))
PY
)"
  [[ "$sequence" -ge 28 ]] || { echo "PCG_WEB_DOWNLOAD_RUNTIME=too-old" >&2; exit 36; }
  set +e
  socket_download_qualification
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    printf 'PCG_WEB_DOWNLOAD_CANARY=pass\n'
    exit 0
  fi
  if [[ "$rc" -eq 42 ]]; then
    printf 'PCG_WEB_DOWNLOAD_CANARY=qualification-required\n'
    exit 0
  fi
  if [[ "$rc" -eq 43 ]]; then
    printf 'PCG_WEB_DOWNLOAD_CANARY=in-doubt\n' >&2
    exit 43
  fi
  exit "$rc"
fi

if [[ "$mode" == semantic-composer-canary ]]; then
  sequence="$(python3 - "$release/manifest.json" <<'PY'
import json,sys
print(int(json.load(open(sys.argv[1],encoding='utf-8')).get('sequence',0)))
PY
)"
  [[ "$sequence" -ge 29 ]] || { echo "PCG_WEB_COMPOSER_RUNTIME=too-old" >&2; exit 37; }
  set +e
  socket_composer_qualification
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    printf 'PCG_WEB_COMPOSER_CANARY=pass\n'
    exit 0
  fi
  if [[ "$rc" -eq 42 ]]; then
    printf 'PCG_WEB_COMPOSER_CANARY=qualification-required\n'
    exit 0
  fi
  exit "$rc"
fi

if [[ "$mode" == screenshot ]]; then
  sequence="$(python3 - "$release/manifest.json" <<'PY'
import json,sys
print(int(json.load(open(sys.argv[1],encoding='utf-8')).get('sequence',0)))
PY
)"
  [[ "$sequence" -ge 11 ]] || { echo "PCG_WEB_SCREENSHOT_RUNTIME=too-old" >&2; exit 26; }
  shot="$run_root/telegram-web-ui.png"
  rm -f "$shot"
  socket_simple screenshot
  [[ -s "$shot" ]] || { echo "PCG_WEB_SCREENSHOT=missing" >&2; exit 27; }
  chmod 0600 "$shot"
  printf 'PCG_WEB_SCREENSHOT_READY=yes\n'
  exit 0
fi

if [[ "$mode" == refresh-screenshot ]]; then
  sequence="$(python3 - "$release/manifest.json" <<'PY'
import json,sys
print(int(json.load(open(sys.argv[1],encoding='utf-8')).get('sequence',0)))
PY
)"
  [[ "$sequence" -ge 11 ]] || { echo "PCG_WEB_SCREENSHOT_RUNTIME=too-old" >&2; exit 26; }
  shot="$run_root/telegram-web-ui.png"
  rm -f "$shot"

  install -d -m 0755 /run/lock
  exec 9>/run/lock/capability-fabric-pull-pcg.lock
  flock 9
  exec 8>/run/lock/capability-fabric-pull.lock
  flock 8

  before_started="$(docker inspect -f '{{.State.StartedAt}}' capability-fabric-pcg-web 2>/dev/null || true)"
  [[ -n "$before_started" ]] || { echo "PCG_WEB_REFRESH=container-missing" >&2; exit 38; }
  docker restart --time 15 capability-fabric-pcg-web >/dev/null

  ready=0
  deadline=$((SECONDS + 90))
  while (( SECONDS < deadline )); do
    cid="$(docker ps --filter name='^/capability-fabric-pcg-web$' --format '{{.ID}}' | head -n1)"
    if [[ -n "$cid" ]] && [[ "$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || true)" == healthy ]] && [[ -S "$socket" ]]; then
      ready=1
      break
    fi
    sleep 1
  done
  [[ "$ready" -eq 1 ]] || { echo "PCG_WEB_REFRESH=unhealthy-after-restart" >&2; exit 38; }

  after_started="$(docker inspect -f '{{.State.StartedAt}}' capability-fabric-pcg-web 2>/dev/null || true)"
  [[ -n "$after_started" && "$after_started" != "$before_started" ]] || { echo "PCG_WEB_REFRESH=restart-not-observed" >&2; exit 38; }

  list_ready=0
  settle_deadline=$((SECONDS + 30))
  while (( SECONDS < settle_deadline )); do
    if socket_semantic_conversation_contract >/dev/null 2>&1; then
      list_ready=1
      break
    fi
    sleep 1
  done
  [[ "$list_ready" -eq 1 ]] || { echo "PCG_WEB_REFRESH=conversation-list-not-ready" >&2; exit 38; }

  socket_simple screenshot
  [[ -s "$shot" ]] || { echo "PCG_WEB_REFRESH_SCREENSHOT=missing" >&2; exit 39; }
  chmod 0600 "$shot"
  printf 'PCG_WEB_REFRESH_SCREENSHOT_READY=yes\n'
  exit 0
fi

if [[ "$mode" == mytelegram-capture-code ]]; then
  socket_simple mytelegram.capture_code
  exit 0
fi

if [[ "$mode" == mytelegram-signin ]]; then
  socket_simple mytelegram.signin
  exit 0
fi

if [[ "$mode" == mytelegram-create-app ]]; then
  socket_simple mytelegram.create_app
  src="$run_root/mytelegram-api.json"
  dst_dir=/var/lib/capability-fabric/pcg/api-credentials
  dst="$dst_dir/telegram-api.json"
  if [[ -s "$src" ]]; then
    install -d -m 0700 -o 65534 -g 65534 "$dst_dir"
    install -m 0600 -o 65534 -g 65534 "$src" "$dst"
    rm -f "$src"
    printf 'PCG_TELEGRAM_API_CREDENTIALS=installed\n'
  fi
  exit 0
fi

if [[ "$mode" == mytelegram-screenshot ]]; then
  shot="$run_root/mytelegram-ui.png"
  rm -f "$shot"
  socket_simple mytelegram.screenshot
  [[ -s "$shot" ]] || { echo "PCG_MYTELEGRAM_SCREENSHOT=missing" >&2; exit 28; }
  chmod 0600 "$shot"
  printf 'PCG_MYTELEGRAM_SCREENSHOT_READY=yes\n'
  exit 0
fi

if [[ "$mode" == cleanup ]]; then
  rm -f "$private_key" "$public_key"
  printf 'PCG_WEB_EPHEMERAL_KEY=removed\n'
  exit 0
fi

[[ -s "$private_key" ]] || { echo "PCG_WEB_EPHEMERAL_KEY=missing" >&2; exit 23; }
cipher="${CF_PCG_WEB_CONTROL_CIPHERTEXT:-}"
[[ "$cipher" =~ ^[A-Za-z0-9+/=]{32,8192}$ ]] || { echo "invalid ciphertext" >&2; exit 24; }

tmp_cipher="$(mktemp "$key_root/.cipher.XXXXXX")"
tmp_plain="$(mktemp "$key_root/.plain.XXXXXX")"
cleanup_files() { rm -f "$tmp_cipher" "$tmp_plain"; }
trap cleanup_files EXIT
printf '%s' "$cipher" | base64 -d > "$tmp_cipher"
openssl pkeyutl -decrypt -inkey "$private_key" -in "$tmp_cipher" -out "$tmp_plain" \
  -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -pkeyopt rsa_mgf1_md:sha256 >/dev/null 2>&1
[[ -s "$tmp_plain" ]] || { echo "decrypt failed" >&2; exit 25; }

case "$mode" in
  phone) op='login.phone' ;;
  code) op='login.code' ;;
  password) op='login.password' ;;
  mytelegram-start) op='mytelegram.start' ;;
esac

python3 - "$socket" "$op" "$tmp_plain" <<'PY'
import json,socket,sys
sock_path,op,plain_path=sys.argv[1:]
with open(plain_path,'r',encoding='utf-8') as f:
    value=f.read()
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.settimeout(40)
s.connect(sock_path)
s.sendall((json.dumps({'op':op,'value':value},separators=(',',':'))+'\n').encode())
value=''
buf=b''
while b'\n' not in buf:
    chunk=s.recv(65536)
    if not chunk: break
    buf+=chunk
s.close()
if not buf: raise SystemExit('empty browser response')
d=json.loads(buf.split(b'\n',1)[0])
safe={k:d.get(k) for k in ('ok','phase','origin','pathname','logged_in','error') if k in d}
print(json.dumps(safe,separators=(',',':')))
if not d.get('ok'): raise SystemExit(40)
PY
: > "$tmp_plain"
printf 'PCG_WEB_CONTROL_%s=pass\n' "${mode^^}"
