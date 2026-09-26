#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(id -u)" -eq 0 ]] || { echo "must run as uid 0" >&2; exit 1; }
mode="${CF_PCG_WEB_CONTROL_MODE:-}"
case "$mode" in prepare|status|ingress-diagnostic|semantic-status|semantic-conversations|semantic-conversations-protected|semantic-conversations-canary|semantic-search-canary|semantic-messages-protected|semantic-messages-canary|semantic-retrieval-hardening-canary|semantic-mark-read-canary|semantic-open-media-canary|semantic-download-canary|semantic-composer-canary|material-send-canary|material-reply-canary|material-attachment-send-canary|material-attachment-reply-canary|material-edit-canary|material-delete-canary|material-forward-canary|material-relay-canary|semantic-reaction-canary|material-text-limit-canary|material-attachment-hardening-canary|material-photo-album-canary|phone|code|password|cleanup|screenshot|refresh-screenshot|mytelegram-start|mytelegram-capture-code|mytelegram-signin|mytelegram-create-app|mytelegram-screenshot) ;; *) echo "invalid mode" >&2; exit 2 ;; esac

run_root=/var/lib/capability-fabric/pcg/run
socket="$run_root/web.sock"
key_root=/run/capability-fabric/pcg-web-control
private_key="$key_root/ephemeral-rsa.pem"
public_key="$key_root/ephemeral-rsa.pub.pem"

for cmd in python3 openssl base64 docker flock git tar; do
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

socket_retrieval_hardening_qualification() {
  python3 - "$socket" <<'PY'
import json,socket,sys
sock_path=sys.argv[1]

def call(payload, timeout=50):
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
    'args':{'limit':20},
})
if conversations.get('state') != 'ACHIEVED':
    raise SystemExit('conversation list failed')
protected=conversations.get('protected_provider_data')
items=protected.get('conversations') if isinstance(protected,dict) else None
if not isinstance(items,list) or not items:
    print(json.dumps({'state':'QUALIFICATION_REQUIRED','reason':'NO_CONVERSATION_CANDIDATE','provider_content_model_visible':False},separators=(',',':')))
    raise SystemExit(42)

pagination_ok=False
for conversation in items:
    if not isinstance(conversation,dict):
        continue
    handle=conversation.get('handle')
    if not isinstance(handle,str) or not handle.startswith('tgchat:'):
        continue
    first=call({
        'op':'semantic.invoke',
        'operation':'communication.message.list',
        'purpose':'PROTECTED_DISPLAY',
        'args':{'conversation_handle':handle,'limit':5},
    })
    if first.get('state') != 'ACHIEVED':
        continue
    obs1=first.get('observation')
    handles1=obs1.get('handles') if isinstance(obs1,dict) else None
    cursor=obs1.get('next_before_message_handle') if isinstance(obs1,dict) else None
    if not isinstance(handles1,list) or len(handles1) != 5 or not isinstance(cursor,str):
        continue
    second=call({
        'op':'semantic.invoke',
        'operation':'communication.message.list',
        'purpose':'PROTECTED_DISPLAY',
        'args':{
            'conversation_handle':handle,
            'limit':5,
            'before_message_handle':cursor,
        },
    })
    if second.get('state') != 'ACHIEVED':
        continue
    obs2=second.get('observation')
    handles2=obs2.get('handles') if isinstance(obs2,dict) else None
    if not isinstance(handles2,list) or not handles2:
        continue
    if set(handles1).isdisjoint(handles2) and obs2.get('before_message_handle') == cursor:
        pagination_ok=True
        break

if not pagination_ok:
    print(json.dumps({'state':'QUALIFICATION_REQUIRED','reason':'NO_PAGINATABLE_CONVERSATION','provider_content_model_visible':False},separators=(',',':')))
    raise SystemExit(42)

search_ok=False
for conversation in items:
    if not isinstance(conversation,dict):
        continue
    name=conversation.get('name')
    if not isinstance(name,str):
        continue
    query=name.strip()
    if not query:
        continue
    query=query[:min(12,len(query))]
    searched=call({
        'op':'semantic.invoke',
        'operation':'communication.conversation.search',
        'purpose':'PROTECTED_DISPLAY',
        'args':{'query':query,'limit':50},
    })
    if searched.get('state') != 'ACHIEVED':
        continue
    obs=searched.get('observation')
    if isinstance(obs,dict) and obs.get('navigation_unchanged') is True and obs.get('provider_content_model_visible') is False:
        search_ok=True
        break

if not search_ok:
    raise SystemExit('hardened search limit qualification failed')

print(json.dumps({
    'state':'ACHIEVED',
    'message_pagination':True,
    'opaque_cursor':True,
    'page_overlap':False,
    'search_limit_50_accepted':True,
    'navigation_unchanged':True,
    'provider_content_model_visible':False,
},separators=(',',':')))
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

if [[ "$mode" == semantic-retrieval-hardening-canary ]]; then
  sequence="$(python3 - "$release/manifest.json" <<'PY'
import json,sys
print(int(json.load(open(sys.argv[1],encoding='utf-8')).get('sequence',0)))
PY
)"
  [[ "$sequence" -ge 41 ]] || { echo "PCG_WEB_RETRIEVAL_HARDENING_RUNTIME=too-old" >&2; exit 51; }
  set +e
  socket_retrieval_hardening_qualification
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    printf 'PCG_WEB_RETRIEVAL_HARDENING_CANARY=pass\n'
    exit 0
  fi
  if [[ "$rc" -eq 42 ]]; then
    printf 'PCG_WEB_RETRIEVAL_HARDENING_CANARY=qualification-required\n'
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

if [[ "$mode" == material-send-canary ]]; then
  sequence="$(python3 - "$release/manifest.json" <<'PY'
import json,sys
print(int(json.load(open(sys.argv[1],encoding='utf-8')).get('sequence',0)))
PY
)"
  [[ "$sequence" -ge 30 ]] || { echo "PCG_WEB_MATERIAL_SEND_RUNTIME=too-old" >&2; exit 40; }

  source_commit="$(tr -d '\r\n' < "$release/source-commit")"
  [[ "$source_commit" =~ ^[0-9a-f]{40}$ ]] || { echo "PCG_WEB_MATERIAL_SEND_SOURCE=invalid" >&2; exit 40; }
  repo_cache=/var/lib/capability-fabric/deploy/pcg/repo.git
  [[ -d "$repo_cache" ]] || { echo "PCG_WEB_MATERIAL_SEND_SOURCE=cache-missing" >&2; exit 40; }
  git --git-dir="$repo_cache" cat-file -e "$source_commit^{commit}"

  work="$(mktemp -d "$run_root/.material-send-src.XXXXXX")"
  cleanup_material_send() { rm -rf "$work"; }
  trap cleanup_material_send EXIT
  chmod 0755 "$work"
  git --git-dir="$repo_cache" archive "$source_commit" src/capability_fabric | tar -x -C "$work"
  chown -R 65534:65534 "$work"
  find "$work" -type d -exec chmod 0755 {} +
  find "$work" -type f -exec chmod 0644 {} +

  image='python:3.12-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e'
  docker pull "$image" >/dev/null
  docker run --rm --network none --user 65534:65534 \
    -e PYTHONPATH=/src \
    -v "$work/src:/src:ro" \
    -v /var/lib/capability-fabric/pcg/core-state:/state:rw \
    -v /var/lib/capability-fabric/pcg/run:/run/pcg:rw \
    "$image" python - <<'PY'
import json
from uuid import uuid4

from capability_fabric.communications_runtime import PrivatePayloadBroker
from capability_fabric.domain import OutcomeState
from capability_fabric.persistence import SqliteExecutionStateStore
from capability_fabric.telegram_web_runtime import (
    TelegramWebSocketClient,
    TelegramWebUncertainEffectResolver,
    build_telegram_web_kernel_runtime,
)

client = TelegramWebSocketClient("/run/pcg/web.sock", timeout=35.0)
target = client.call({"op": "material.self_target"})
handle = target.get("conversation_handle")
if not isinstance(handle, str) or not handle.startswith("tgchat:"):
    raise SystemExit("self target resolution failed")

state = SqliteExecutionStateStore("/state/web-material-send.sqlite3")
payloads = PrivatePayloadBroker(
    "/state/web-material-payloads",
    ttl_seconds=86400,
    max_payload_bytes=4096,
)
try:
    runtime = build_telegram_web_kernel_runtime(
        client=client,
        payloads=payloads,
        state_store=state,
        journal=state,
    )
    result = runtime.send_text(
        conversation_handle=handle,
        text="pcg-material-send-canary-" + str(uuid4()),
    )
    if result.outcome.state is not OutcomeState.ACHIEVED:
        raise SystemExit("material send did not achieve")

    resolver = TelegramWebUncertainEffectResolver(client, payloads)
    observed = resolver.resolve(result.operation, result.attempt, result.dispatch)
    if observed.state is not OutcomeState.ACHIEVED:
        raise SystemExit("material send authoritative readback failed")

    events = state.event_records()
    durable_intent = any(
        item.get("kind") == "state.dispatch_intent.persisted"
        and item.get("entity_id") == result.attempt.attempt_id
        for item in events
    )
    if not durable_intent:
        raise SystemExit("durable dispatch intent missing")

    payload_handle = str(result.dispatch.evidence["payload.handle"])
    payloads.remove(payload_handle)
    payload_removed = False
    try:
        payloads.resolve(payload_handle)
    except KeyError:
        payload_removed = True
    if not payload_removed:
        raise SystemExit("payload cleanup failed")

    safe = {
        "state": "ACHIEVED",
        "self_target_opaque": True,
        "kernel_dispatch_intent": True,
        "provider_acknowledged": result.observation.ack_state.value == "ACKNOWLEDGED",
        "provider_confirmed": result.observation.detail == "provider_confirmed",
        "reconciliation_readback": "ACHIEVED",
        "payload_removed": True,
        "provider_content_model_visible": False,
    }
    print(json.dumps(safe, separators=(",", ":")))
finally:
    state.close()
PY
  printf 'PCG_WEB_MATERIAL_SEND_CANARY=pass\n'
  exit 0
fi

if [[ "$mode" == material-attachment-send-canary ]]; then
  sequence="$(python3 - "$release/manifest.json" <<'PY'
import json,sys
print(int(json.load(open(sys.argv[1],encoding='utf-8')).get('sequence',0)))
PY
)"
  [[ "$sequence" -ge 32 ]] || { echo "PCG_WEB_MATERIAL_ATTACHMENT_RUNTIME=too-old" >&2; exit 42; }

  source_commit="$(tr -d '\r\n' < "$release/source-commit")"
  [[ "$source_commit" =~ ^[0-9a-f]{40}$ ]] || { echo "PCG_WEB_MATERIAL_ATTACHMENT_SOURCE=invalid" >&2; exit 42; }
  repo_cache=/var/lib/capability-fabric/deploy/pcg/repo.git
  [[ -d "$repo_cache" ]] || { echo "PCG_WEB_MATERIAL_ATTACHMENT_SOURCE=cache-missing" >&2; exit 42; }
  git --git-dir="$repo_cache" cat-file -e "$source_commit^{commit}"

  work="$(mktemp -d "$run_root/.material-attachment-src.XXXXXX")"
  cleanup_material_attachment() { rm -rf "$work"; }
  trap cleanup_material_attachment EXIT
  chmod 0755 "$work"
  git --git-dir="$repo_cache" archive "$source_commit" src/capability_fabric | tar -x -C "$work"
  chown -R 65534:65534 "$work"
  find "$work" -type d -exec chmod 0755 {} +
  find "$work" -type f -exec chmod 0644 {} +

  image='python:3.12-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e'
  docker pull "$image" >/dev/null
  docker run --rm --network none --user 65534:65534 \
    -e PYTHONPATH=/src \
    -v "$work/src:/src:ro" \
    -v /var/lib/capability-fabric/pcg/core-state:/state:rw \
    -v /var/lib/capability-fabric/pcg/run:/run/pcg:rw \
    "$image" python - <<'PY'
import json
from uuid import uuid4

from capability_fabric.communications_runtime import PrivatePayloadBroker
from capability_fabric.domain import OutcomeState
from capability_fabric.persistence import SqliteExecutionStateStore
from capability_fabric.telegram_web_runtime import (
    TelegramWebSocketClient,
    TelegramWebUncertainEffectResolver,
    build_telegram_web_kernel_runtime,
)

client = TelegramWebSocketClient("/run/pcg/web.sock", timeout=45.0)
target = client.call({"op": "material.self_target"})
conversation_handle = target.get("conversation_handle")
if not isinstance(conversation_handle, str) or not conversation_handle.startswith("tgchat:"):
    raise SystemExit("self attachment target resolution failed")

state = SqliteExecutionStateStore("/state/web-material-send.sqlite3")
payloads = PrivatePayloadBroker(
    "/state/web-material-payloads",
    ttl_seconds=86400,
    max_payload_bytes=8192,
)
lease = payloads.put_bytes(("pcg-attachment-send-canary-" + str(uuid4()) + "\n").encode("utf-8"))
try:
    runtime = build_telegram_web_kernel_runtime(
        client=client,
        payloads=payloads,
        state_store=state,
        journal=state,
    )
    result = runtime.send_attachment(
        conversation_handle=conversation_handle,
        attachment_handle=lease.handle,
        filename="pcg-attachment-canary.txt",
        mime_type="text/plain",
    )
    if result.outcome.state is not OutcomeState.ACHIEVED:
        raise SystemExit("material attachment send did not achieve")

    if result.dispatch.evidence.get("attachment.handle") != lease.handle:
        raise SystemExit("attachment handle correlation mismatch")
    if result.dispatch.evidence.get("attachment.sha256") != lease.sha256_hex:
        raise SystemExit("attachment digest correlation mismatch")
    if result.dispatch.evidence.get("attachment.size_bytes") != lease.size_bytes:
        raise SystemExit("attachment size correlation mismatch")

    resolver = TelegramWebUncertainEffectResolver(client, payloads)
    observed = resolver.resolve(result.operation, result.attempt, result.dispatch)
    if observed.state is not OutcomeState.ACHIEVED:
        raise SystemExit("material attachment authoritative readback failed")

    events = state.event_records()
    durable_intent = any(
        item.get("kind") == "state.dispatch_intent.persisted"
        and item.get("entity_id") == result.attempt.attempt_id
        for item in events
    )
    if not durable_intent:
        raise SystemExit("durable attachment dispatch intent missing")

    payloads.remove(lease.handle)
    payload_removed = False
    try:
        payloads.resolve(lease.handle)
    except KeyError:
        payload_removed = True
    if not payload_removed:
        raise SystemExit("attachment payload cleanup failed")

    safe = {
        "state": "ACHIEVED",
        "self_target_opaque": True,
        "attachment_handle_opaque": lease.handle.startswith("payload:"),
        "bounded_size": lease.size_bytes <= 8192,
        "kernel_dispatch_intent": True,
        "provider_acknowledged": result.observation.ack_state.value == "ACKNOWLEDGED",
        "provider_confirmed": result.observation.detail == "provider_confirmed",
        "attachment_metadata_authoritative": True,
        "reconciliation_readback": "ACHIEVED",
        "payload_removed": True,
        "provider_content_model_visible": False,
    }
    print(json.dumps(safe, separators=(",", ":")))
finally:
    state.close()
PY
  printf 'PCG_WEB_MATERIAL_ATTACHMENT_SEND_CANARY=pass\n'
  exit 0
fi

if [[ "$mode" == material-attachment-reply-canary ]]; then
  sequence="$(python3 - "$release/manifest.json" <<'PY'
import json,sys
print(int(json.load(open(sys.argv[1],encoding='utf-8')).get('sequence',0)))
PY
)"
  [[ "$sequence" -ge 33 ]] || { echo "PCG_WEB_MATERIAL_ATTACHMENT_REPLY_RUNTIME=too-old" >&2; exit 43; }

  source_commit="$(tr -d '\r\n' < "$release/source-commit")"
  [[ "$source_commit" =~ ^[0-9a-f]{40}$ ]] || { echo "PCG_WEB_MATERIAL_ATTACHMENT_REPLY_SOURCE=invalid" >&2; exit 43; }
  repo_cache=/var/lib/capability-fabric/deploy/pcg/repo.git
  [[ -d "$repo_cache" ]] || { echo "PCG_WEB_MATERIAL_ATTACHMENT_REPLY_SOURCE=cache-missing" >&2; exit 43; }
  git --git-dir="$repo_cache" cat-file -e "$source_commit^{commit}"

  work="$(mktemp -d "$run_root/.material-attachment-reply-src.XXXXXX")"
  cleanup_material_attachment_reply() { rm -rf "$work"; }
  trap cleanup_material_attachment_reply EXIT
  chmod 0755 "$work"
  git --git-dir="$repo_cache" archive "$source_commit" src/capability_fabric | tar -x -C "$work"
  chown -R 65534:65534 "$work"
  find "$work" -type d -exec chmod 0755 {} +
  find "$work" -type f -exec chmod 0644 {} +

  image='python:3.12-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e'
  docker pull "$image" >/dev/null
  docker run --rm --network none --user 65534:65534 \
    -e PYTHONPATH=/src \
    -v "$work/src:/src:ro" \
    -v /var/lib/capability-fabric/pcg/core-state:/state:rw \
    -v /var/lib/capability-fabric/pcg/run:/run/pcg:rw \
    "$image" python - <<'PY'
import json
from uuid import uuid4

from capability_fabric.communications_runtime import PrivatePayloadBroker
from capability_fabric.domain import OutcomeState
from capability_fabric.persistence import SqliteExecutionStateStore
from capability_fabric.telegram_web_runtime import (
    TelegramWebSocketClient,
    TelegramWebUncertainEffectResolver,
    build_telegram_web_kernel_runtime,
)

client = TelegramWebSocketClient("/run/pcg/web.sock", timeout=45.0)
target = client.call({"op": "material.self_reply_target"})
conversation_handle = target.get("conversation_handle")
source_message_handle = target.get("source_message_handle")
if not isinstance(conversation_handle, str) or not conversation_handle.startswith("tgchat:"):
    raise SystemExit("self attachment reply conversation resolution failed")
if not isinstance(source_message_handle, str) or not source_message_handle.startswith("tgmsg:"):
    raise SystemExit("self attachment reply source resolution failed")

state = SqliteExecutionStateStore("/state/web-material-send.sqlite3")
payloads = PrivatePayloadBroker(
    "/state/web-material-payloads",
    ttl_seconds=86400,
    max_payload_bytes=8192,
)
lease = payloads.put_bytes(("pcg-attachment-reply-canary-" + str(uuid4()) + "\n").encode("utf-8"))
try:
    runtime = build_telegram_web_kernel_runtime(
        client=client,
        payloads=payloads,
        state_store=state,
        journal=state,
    )
    result = runtime.reply_attachment(
        conversation_handle=conversation_handle,
        source_message_handle=source_message_handle,
        attachment_handle=lease.handle,
        filename="pcg-attachment-reply-canary.txt",
        mime_type="text/plain",
    )
    if result.outcome.state is not OutcomeState.ACHIEVED:
        raise SystemExit("material attachment reply did not achieve")

    if result.dispatch.evidence.get("telegram_web.source_message_handle") != source_message_handle:
        raise SystemExit("attachment reply source correlation mismatch")
    if result.dispatch.evidence.get("attachment.handle") != lease.handle:
        raise SystemExit("attachment reply handle correlation mismatch")
    if result.dispatch.evidence.get("attachment.sha256") != lease.sha256_hex:
        raise SystemExit("attachment reply digest correlation mismatch")
    if result.dispatch.evidence.get("attachment.size_bytes") != lease.size_bytes:
        raise SystemExit("attachment reply size correlation mismatch")

    resolver = TelegramWebUncertainEffectResolver(client, payloads)
    observed = resolver.resolve(result.operation, result.attempt, result.dispatch)
    if observed.state is not OutcomeState.ACHIEVED:
        raise SystemExit("material attachment reply authoritative readback failed")

    events = state.event_records()
    durable_intent = any(
        item.get("kind") == "state.dispatch_intent.persisted"
        and item.get("entity_id") == result.attempt.attempt_id
        for item in events
    )
    if not durable_intent:
        raise SystemExit("durable attachment reply dispatch intent missing")

    payloads.remove(lease.handle)
    payload_removed = False
    try:
        payloads.resolve(lease.handle)
    except KeyError:
        payload_removed = True
    if not payload_removed:
        raise SystemExit("attachment reply payload cleanup failed")

    safe = {
        "state": "ACHIEVED",
        "self_target_opaque": True,
        "source_message_opaque": True,
        "attachment_handle_opaque": lease.handle.startswith("payload:"),
        "bounded_size": lease.size_bytes <= 8192,
        "kernel_dispatch_intent": True,
        "provider_acknowledged": result.observation.ack_state.value == "ACKNOWLEDGED",
        "provider_confirmed": result.observation.detail == "provider_confirmed",
        "attachment_metadata_authoritative": True,
        "reply_relationship_authoritative": True,
        "reconciliation_readback": "ACHIEVED",
        "payload_removed": True,
        "provider_content_model_visible": False,
    }
    print(json.dumps(safe, separators=(",", ":")))
finally:
    state.close()
PY
  printf 'PCG_WEB_MATERIAL_ATTACHMENT_REPLY_CANARY=pass\n'
  exit 0
fi

if [[ "$mode" == material-photo-album-canary ]]; then
  sequence="$(python3 - "$release/manifest.json" <<'PY'
import json,sys
print(int(json.load(open(sys.argv[1],encoding='utf-8')).get('sequence',0)))
PY
)"
  [[ "$sequence" -ge 43 ]] || { echo "PCG_WEB_PHOTO_ALBUM_RUNTIME=too-old" >&2; exit 52; }

  source_commit="$(tr -d '\r\n' < "$release/source-commit")"
  [[ "$source_commit" =~ ^[0-9a-f]{40}$ ]] || { echo "PCG_WEB_PHOTO_ALBUM_SOURCE=invalid" >&2; exit 52; }
  repo_cache=/var/lib/capability-fabric/deploy/pcg/repo.git
  [[ -d "$repo_cache" ]] || { echo "PCG_WEB_PHOTO_ALBUM_SOURCE=cache-missing" >&2; exit 52; }
  git --git-dir="$repo_cache" cat-file -e "$source_commit^{commit}"

  work="$(mktemp -d "$run_root/.photo-album-src.XXXXXX")"
  cleanup_photo_album() { rm -rf "$work"; }
  trap cleanup_photo_album EXIT
  chmod 0755 "$work"
  git --git-dir="$repo_cache" archive "$source_commit" src/capability_fabric | tar -x -C "$work"
  chown -R 65534:65534 "$work"
  find "$work" -type d -exec chmod 0755 {} +
  find "$work" -type f -exec chmod 0644 {} +

  image='python:3.12-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e'
  docker pull "$image" >/dev/null
  docker run --rm --network none --user 65534:65534 \
    -e PYTHONPATH=/src \
    -v "$work/src:/src:ro" \
    -v /var/lib/capability-fabric/pcg/core-state:/state:rw \
    -v /var/lib/capability-fabric/pcg/run:/run/pcg:rw \
    "$image" python - <<'PY'
import json
import struct
import zlib
from uuid import uuid4

from capability_fabric.communications_runtime import PrivatePayloadBroker
from capability_fabric.domain import OutcomeState
from capability_fabric.persistence import SqliteExecutionStateStore
from capability_fabric.telegram_web_runtime import (
    TelegramWebSocketClient,
    TelegramWebUncertainEffectResolver,
    build_telegram_web_kernel_runtime,
)

def png_pixel(r,g,b):
    sig=b"\x89PNG\r\n\x1a\n"
    def chunk(kind,data):
        return struct.pack(">I",len(data))+kind+data+struct.pack(">I",zlib.crc32(kind+data)&0xffffffff)
    ihdr=struct.pack(">IIBBBBB",1,1,8,2,0,0,0)
    raw=b"\x00"+bytes([r,g,b])
    return sig+chunk(b"IHDR",ihdr)+chunk(b"IDAT",zlib.compress(raw))+chunk(b"IEND",b"")

client=TelegramWebSocketClient("/run/pcg/web.sock",timeout=90.0)
target=client.call({"op":"material.self_target"})
conversation=target.get("conversation_handle")
if not isinstance(conversation,str) or not conversation.startswith("tgchat:"):
    raise SystemExit("photo album self target resolution failed")

state=SqliteExecutionStateStore("/state/web-material-send.sqlite3")
payloads=PrivatePayloadBroker("/state/web-material-payloads",ttl_seconds=86400,max_payload_bytes=8*1024*1024)
cleanup=[]
try:
    runtime=build_telegram_web_kernel_runtime(client=client,payloads=payloads,state_store=state,journal=state)
    a=payloads.put_bytes(png_pixel(255,0,0))
    b=payloads.put_bytes(png_pixel(0,0,255))
    cleanup.extend([a.handle,b.handle])
    caption="pcg-album-"+str(uuid4())
    result=runtime.send_photo_album(
        conversation_handle=conversation,
        attachment_handles=[a.handle,b.handle],
        filenames=["pcg-a.png","pcg-b.png"],
        mime_types=["image/png","image/png"],
        caption=caption,
    )
    caption_handle=result.dispatch.evidence.get("attachment.caption_handle")
    if isinstance(caption_handle,str): cleanup.append(caption_handle)
    if result.outcome.state is not OutcomeState.ACHIEVED:
        raise SystemExit("photo album did not achieve")
    if len(result.dispatch.evidence.get("album.items",[])) != 2:
        raise SystemExit("photo album durable item binding missing")

    resolver=TelegramWebUncertainEffectResolver(client,payloads)
    observed=resolver.resolve(result.operation,result.attempt,result.dispatch)
    if observed.state is not OutcomeState.ACHIEVED:
        raise SystemExit("photo album authoritative readback failed")

    durable=any(
        item.get("kind")=="state.dispatch_intent.persisted"
        and item.get("entity_id")==result.attempt.attempt_id
        for item in state.event_records()
    )
    if not durable:
        raise SystemExit("photo album durable dispatch intent missing")

    print(json.dumps({
        "state":"ACHIEVED",
        "photo_count":2,
        "grouped_album":True,
        "caption_bound":True,
        "provider_confirmed":result.observation.detail=="provider_confirmed",
        "reconciliation_readback":"ACHIEVED",
        "kernel_dispatch_intent":True,
        "provider_content_model_visible":False,
    },separators=(",",":")))
finally:
    for handle in cleanup:
        try: payloads.remove(handle)
        except Exception: pass
    state.close()
PY
  printf 'PCG_WEB_PHOTO_ALBUM_CANARY=pass\n'
  exit 0
fi

if [[ "$mode" == material-attachment-hardening-canary ]]; then
  sequence="$(python3 - "$release/manifest.json" <<'PY'
import json,sys
print(int(json.load(open(sys.argv[1],encoding='utf-8')).get('sequence',0)))
PY
)"
  [[ "$sequence" -ge 40 ]] || { echo "PCG_WEB_ATTACHMENT_HARDENING_RUNTIME=too-old" >&2; exit 50; }

  source_commit="$(tr -d '\r\n' < "$release/source-commit")"
  [[ "$source_commit" =~ ^[0-9a-f]{40}$ ]] || { echo "PCG_WEB_ATTACHMENT_HARDENING_SOURCE=invalid" >&2; exit 50; }
  repo_cache=/var/lib/capability-fabric/deploy/pcg/repo.git
  [[ -d "$repo_cache" ]] || { echo "PCG_WEB_ATTACHMENT_HARDENING_SOURCE=cache-missing" >&2; exit 50; }
  git --git-dir="$repo_cache" cat-file -e "$source_commit^{commit}"

  work="$(mktemp -d "$run_root/.attachment-hardening-src.XXXXXX")"
  cleanup_attachment_hardening() { rm -rf "$work"; }
  trap cleanup_attachment_hardening EXIT
  chmod 0755 "$work"
  git --git-dir="$repo_cache" archive "$source_commit" src/capability_fabric | tar -x -C "$work"
  chown -R 65534:65534 "$work"
  find "$work" -type d -exec chmod 0755 {} +
  find "$work" -type f -exec chmod 0644 {} +

  image='python:3.12-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e'
  docker pull "$image" >/dev/null
  docker run --rm --network none --user 65534:65534 \
    -e PYTHONPATH=/src \
    -v "$work/src:/src:ro" \
    -v /var/lib/capability-fabric/pcg/core-state:/state:rw \
    -v /var/lib/capability-fabric/pcg/run:/run/pcg:rw \
    "$image" python - <<'PY'
import json
from hashlib import sha256
from uuid import uuid4

from capability_fabric.communications_runtime import PrivatePayloadBroker
from capability_fabric.domain import OutcomeState
from capability_fabric.persistence import SqliteExecutionStateStore
from capability_fabric.telegram_web_runtime import (
    TelegramWebSocketClient,
    TelegramWebUncertainEffectResolver,
    build_telegram_web_kernel_runtime,
)

client = TelegramWebSocketClient("/run/pcg/web.sock", timeout=90.0)
self_target = client.call({"op": "material.self_target"})
conversation_handle = self_target.get("conversation_handle")
if not isinstance(conversation_handle, str) or not conversation_handle.startswith("tgchat:"):
    raise SystemExit("attachment hardening self target resolution failed")

state = SqliteExecutionStateStore("/state/web-material-send.sqlite3")
payloads = PrivatePayloadBroker(
    "/state/web-material-payloads",
    ttl_seconds=86400,
    max_payload_bytes=1024 * 1024,
)
cleanup_handles = []
try:
    runtime = build_telegram_web_kernel_runtime(
        client=client,
        payloads=payloads,
        state_store=state,
        journal=state,
    )

    suffix = str(uuid4())
    source_text = "pcg-attachment-hardening-source-" + suffix
    source = runtime.send_text(conversation_handle=conversation_handle, text=source_text)
    if source.outcome.state is not OutcomeState.ACHIEVED:
        raise SystemExit("attachment hardening source send did not achieve")
    cleanup_handles.append(str(source.dispatch.evidence["payload.handle"]))

    target = client.call({"op": "material.self_relay_target", "expected_text": source_text})
    source_message_handle = target.get("source_message_handle")
    if target.get("source_conversation_handle") != conversation_handle:
        raise SystemExit("attachment hardening source conversation mismatch")
    if not isinstance(source_message_handle, str) or not source_message_handle.startswith("tgmsg:"):
        raise SystemExit("attachment hardening source message resolution failed")

    send_bytes = (b"pcg-attachment-send-" + suffix.encode("ascii") + b"\n")
    send_bytes = (send_bytes + b"S" * (64 * 1024))[:64 * 1024]
    send_lease = payloads.put_bytes(send_bytes)
    cleanup_handles.append(send_lease.handle)
    send_caption = "pcg-caption-send-" + suffix
    sent = runtime.send_attachment(
        conversation_handle=conversation_handle,
        attachment_handle=send_lease.handle,
        filename="pcg-hardening-send.bin",
        mime_type="application/octet-stream",
        caption=send_caption,
    )
    if sent.outcome.state is not OutcomeState.ACHIEVED:
        raise SystemExit("large captioned attachment send did not achieve")
    send_caption_handle = sent.dispatch.evidence.get("attachment.caption_handle")
    if not isinstance(send_caption_handle, str) or not send_caption_handle.startswith("payload:"):
        raise SystemExit("attachment send caption handle missing")
    cleanup_handles.append(send_caption_handle)
    if sent.dispatch.evidence.get("attachment.caption_sha256") != sha256(send_caption.encode()).hexdigest():
        raise SystemExit("attachment send caption digest mismatch")
    if sent.dispatch.evidence.get("attachment.size_bytes") != 64 * 1024:
        raise SystemExit("attachment send size mismatch")

    resolver = TelegramWebUncertainEffectResolver(client, payloads)
    send_observed = resolver.resolve(sent.operation, sent.attempt, sent.dispatch)
    if send_observed.state is not OutcomeState.ACHIEVED:
        raise SystemExit("attachment send authoritative caption readback failed")

    reply_bytes = (b"pcg-attachment-reply-" + suffix.encode("ascii") + b"\n")
    reply_bytes = (reply_bytes + b"R" * (64 * 1024))[:64 * 1024]
    reply_lease = payloads.put_bytes(reply_bytes)
    cleanup_handles.append(reply_lease.handle)
    reply_caption = "pcg-caption-reply-" + suffix
    replied = runtime.reply_attachment(
        conversation_handle=conversation_handle,
        source_message_handle=source_message_handle,
        attachment_handle=reply_lease.handle,
        filename="pcg-hardening-reply.bin",
        mime_type="application/octet-stream",
        caption=reply_caption,
    )
    if replied.outcome.state is not OutcomeState.ACHIEVED:
        raise SystemExit("large captioned attachment reply did not achieve")
    reply_caption_handle = replied.dispatch.evidence.get("attachment.caption_handle")
    if not isinstance(reply_caption_handle, str) or not reply_caption_handle.startswith("payload:"):
        raise SystemExit("attachment reply caption handle missing")
    cleanup_handles.append(reply_caption_handle)
    if replied.dispatch.evidence.get("attachment.caption_sha256") != sha256(reply_caption.encode()).hexdigest():
        raise SystemExit("attachment reply caption digest mismatch")
    if replied.dispatch.evidence.get("attachment.size_bytes") != 64 * 1024:
        raise SystemExit("attachment reply size mismatch")

    reply_observed = resolver.resolve(replied.operation, replied.attempt, replied.dispatch)
    if reply_observed.state is not OutcomeState.ACHIEVED:
        raise SystemExit("attachment reply authoritative caption readback failed")

    safe = {
        "state": "ACHIEVED",
        "attachment_size_bytes": 64 * 1024,
        "exercised_over_8kib": True,
        "send_caption_provider_confirmed": True,
        "reply_caption_provider_confirmed": True,
        "reply_relationship_authoritative": True,
        "private_caption_brokered": True,
        "socket_large_request_path": True,
        "provider_content_model_visible": False,
    }
    print(json.dumps(safe, separators=(",", ":")))
finally:
    for handle in cleanup_handles:
        try:
            payloads.remove(handle)
        except Exception:
            pass
    state.close()
PY
  printf 'PCG_WEB_ATTACHMENT_HARDENING_CANARY=pass\n'
  exit 0
fi

if [[ "$mode" == material-text-limit-canary ]]; then
  sequence="$(python3 - "$release/manifest.json" <<'PY'
import json,sys
print(int(json.load(open(sys.argv[1],encoding='utf-8')).get('sequence',0)))
PY
)"
  [[ "$sequence" -ge 39 ]] || { echo "PCG_WEB_TEXT_LIMIT_RUNTIME=too-old" >&2; exit 49; }

  source_commit="$(tr -d '\r\n' < "$release/source-commit")"
  [[ "$source_commit" =~ ^[0-9a-f]{40}$ ]] || { echo "PCG_WEB_TEXT_LIMIT_SOURCE=invalid" >&2; exit 49; }
  repo_cache=/var/lib/capability-fabric/deploy/pcg/repo.git
  [[ -d "$repo_cache" ]] || { echo "PCG_WEB_TEXT_LIMIT_SOURCE=cache-missing" >&2; exit 49; }
  git --git-dir="$repo_cache" cat-file -e "$source_commit^{commit}"

  work="$(mktemp -d "$run_root/.text-limit-src.XXXXXX")"
  cleanup_text_limit() { rm -rf "$work"; }
  trap cleanup_text_limit EXIT
  chmod 0755 "$work"
  git --git-dir="$repo_cache" archive "$source_commit" src/capability_fabric | tar -x -C "$work"
  chown -R 65534:65534 "$work"
  find "$work" -type d -exec chmod 0755 {} +
  find "$work" -type f -exec chmod 0644 {} +

  image='python:3.12-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e'
  docker pull "$image" >/dev/null
  docker run --rm --network none --user 65534:65534 \
    -e PYTHONPATH=/src \
    -v "$work/src:/src:ro" \
    -v /var/lib/capability-fabric/pcg/core-state:/state:rw \
    -v /var/lib/capability-fabric/pcg/run:/run/pcg:rw \
    "$image" python - <<'PY'
import json
from uuid import uuid4

from capability_fabric.communications_runtime import PrivatePayloadBroker
from capability_fabric.domain import OutcomeState
from capability_fabric.persistence import SqliteExecutionStateStore
from capability_fabric.telegram_web_runtime import TelegramWebSocketClient, build_telegram_web_kernel_runtime

client = TelegramWebSocketClient("/run/pcg/web.sock", timeout=60.0)
self_target = client.call({"op": "material.self_target"})
conversation_handle = self_target.get("conversation_handle")
if not isinstance(conversation_handle, str) or not conversation_handle.startswith("tgchat:"):
    raise SystemExit("long-text self target resolution failed")

state = SqliteExecutionStateStore("/state/web-material-send.sqlite3")
payloads = PrivatePayloadBroker(
    "/state/web-material-payloads",
    ttl_seconds=86400,
    max_payload_bytes=16384,
)
handles = []
try:
    runtime = build_telegram_web_kernel_runtime(
        client=client,
        payloads=payloads,
        state_store=state,
        journal=state,
    )

    suffix = str(uuid4())
    send_text = ("pcg-long-send-" + suffix + "-") + ("s" * 900)
    if not (512 < len(send_text) < 4096):
        raise SystemExit("long-text send canary length invalid")
    sent = runtime.send_text(conversation_handle=conversation_handle, text=send_text)
    if sent.outcome.state is not OutcomeState.ACHIEVED:
        raise SystemExit("long-text send did not achieve")
    handles.append(str(sent.dispatch.evidence["payload.handle"]))

    target = client.call({"op": "material.self_relay_target", "expected_text": send_text})
    message_handle = target.get("source_message_handle")
    if target.get("source_conversation_handle") != conversation_handle:
        raise SystemExit("long-text source conversation mismatch")
    if not isinstance(message_handle, str) or not message_handle.startswith("tgmsg:"):
        raise SystemExit("long-text source resolution failed")

    reply_text = ("pcg-long-reply-" + suffix + "-") + ("r" * 900)
    replied = runtime.reply_text(
        conversation_handle=conversation_handle,
        source_message_handle=message_handle,
        text=reply_text,
    )
    if replied.outcome.state is not OutcomeState.ACHIEVED:
        raise SystemExit("long-text reply did not achieve")
    handles.append(str(replied.dispatch.evidence["payload.handle"]))

    edit_text = ("pcg-long-edit-" + suffix + "-") + ("e" * 900)
    edited = runtime.edit_text(
        conversation_handle=conversation_handle,
        message_handle=message_handle,
        text=edit_text,
    )
    if edited.outcome.state is not OutcomeState.ACHIEVED:
        raise SystemExit("long-text edit did not achieve")
    handles.append(str(edited.dispatch.evidence["payload.handle"]))

    relayed = runtime.relay_text(
        source_conversation_handle=conversation_handle,
        source_message_handle=message_handle,
        conversation_handle=conversation_handle,
        purpose="TRANSPORT_RELAY",
    )
    if relayed.outcome.state is not OutcomeState.ACHIEVED:
        raise SystemExit("long-text relay did not achieve")

    safe = {
        "state": "ACHIEVED",
        "provider_limit_chars": 4096,
        "exercised_over_512": True,
        "send_over_512": True,
        "reply_over_512": True,
        "edit_over_512": True,
        "relay_over_512": True,
        "provider_confirmed": True,
        "provider_content_model_visible": False,
    }
    print(json.dumps(safe, separators=(",", ":")))
finally:
    for handle in handles:
        try:
            payloads.remove(handle)
        except Exception:
            pass
    state.close()
PY
  printf 'PCG_WEB_TEXT_LIMIT_CANARY=pass\n'
  exit 0
fi

if [[ "$mode" == semantic-reaction-canary ]]; then
  sequence="$(python3 - "$release/manifest.json" <<'PY'
import json,sys
print(int(json.load(open(sys.argv[1],encoding='utf-8')).get('sequence',0)))
PY
)"
  [[ "$sequence" -ge 38 ]] || { echo "PCG_WEB_REACTION_RUNTIME=too-old" >&2; exit 48; }

  source_commit="$(tr -d '\r\n' < "$release/source-commit")"
  [[ "$source_commit" =~ ^[0-9a-f]{40}$ ]] || { echo "PCG_WEB_REACTION_SOURCE=invalid" >&2; exit 48; }
  repo_cache=/var/lib/capability-fabric/deploy/pcg/repo.git
  [[ -d "$repo_cache" ]] || { echo "PCG_WEB_REACTION_SOURCE=cache-missing" >&2; exit 48; }
  git --git-dir="$repo_cache" cat-file -e "$source_commit^{commit}"

  work="$(mktemp -d "$run_root/.reaction-src.XXXXXX")"
  cleanup_reaction() { rm -rf "$work"; }
  trap cleanup_reaction EXIT
  chmod 0755 "$work"
  git --git-dir="$repo_cache" archive "$source_commit" src/capability_fabric | tar -x -C "$work"
  chown -R 65534:65534 "$work"
  find "$work" -type d -exec chmod 0755 {} +
  find "$work" -type f -exec chmod 0644 {} +

  image='python:3.12-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e'
  docker pull "$image" >/dev/null
  docker run --rm --network none --user 65534:65534 \
    -e PYTHONPATH=/src \
    -v "$work/src:/src:ro" \
    -v /var/lib/capability-fabric/pcg/core-state:/state:rw \
    -v /var/lib/capability-fabric/pcg/run:/run/pcg:rw \
    "$image" python - <<'PY'
import json
from uuid import uuid4

from capability_fabric.communications_runtime import PrivatePayloadBroker
from capability_fabric.domain import OutcomeState
from capability_fabric.persistence import SqliteExecutionStateStore
from capability_fabric.telegram_web_runtime import TelegramWebSocketClient, build_telegram_web_kernel_runtime

client = TelegramWebSocketClient("/run/pcg/web.sock", timeout=45.0)
self_target = client.call({"op": "material.self_target"})
conversation_handle = self_target.get("conversation_handle")
if not isinstance(conversation_handle, str) or not conversation_handle.startswith("tgchat:"):
    raise SystemExit("self reaction conversation resolution failed")

state = SqliteExecutionStateStore("/state/web-material-send.sqlite3")
payloads = PrivatePayloadBroker(
    "/state/web-material-payloads",
    ttl_seconds=86400,
    max_payload_bytes=8192,
)
try:
    runtime = build_telegram_web_kernel_runtime(
        client=client,
        payloads=payloads,
        state_store=state,
        journal=state,
    )

    canary_text = "pcg-reaction-source-" + str(uuid4())
    source = runtime.send_text(conversation_handle=conversation_handle, text=canary_text)
    if source.outcome.state is not OutcomeState.ACHIEVED:
        raise SystemExit("reaction source send did not achieve")
    payloads.remove(str(source.dispatch.evidence["payload.handle"]))

    target = client.call({
        "op": "material.self_relay_target",
        "expected_text": canary_text,
    })
    message_handle = target.get("source_message_handle")
    if target.get("source_conversation_handle") != conversation_handle:
        raise SystemExit("reaction source conversation mismatch")
    if not isinstance(message_handle, str) or not message_handle.startswith("tgmsg:"):
        raise SystemExit("reaction source resolution failed")

    request = {
        "op": "semantic.invoke",
        "operation": "communication.message.react",
        "args": {
            "conversation_handle": conversation_handle,
            "message_handle": message_handle,
            "emoji": "👍",
        },
    }
    first = client.call(request)
    if first.get("state") != "ACHIEVED":
        raise SystemExit("reaction effect did not achieve")
    observation = first.get("observation")
    if not isinstance(observation, dict):
        raise SystemExit("reaction observation missing")
    if observation.get("selected_after") is not True or observation.get("provider_confirmed") is not True:
        raise SystemExit("reaction provider confirmation missing")

    second = client.call(request)
    if second.get("state") != "ACHIEVED":
        raise SystemExit("reaction idempotence check failed")
    second_obs = second.get("observation")
    if not isinstance(second_obs, dict) or second_obs.get("selected_after") is not True:
        raise SystemExit("reaction idempotence observation missing")
    if second_obs.get("effect_attempted") is not False:
        raise SystemExit("reaction desired-state replay was not idempotent")

    safe = {
        "state": "ACHIEVED",
        "message_target_opaque": True,
        "standard_emoji": True,
        "provider_confirmed": True,
        "desired_state_idempotent": True,
        "second_effect_attempted": False,
        "provider_content_model_visible": False,
    }
    print(json.dumps(safe, separators=(",", ":"), ensure_ascii=True))
finally:
    state.close()
PY
  printf 'PCG_WEB_REACTION_CANARY=pass\n'
  exit 0
fi

if [[ "$mode" == material-relay-canary ]]; then
  sequence="$(python3 - "$release/manifest.json" <<'PY'
import json,sys
print(int(json.load(open(sys.argv[1],encoding='utf-8')).get('sequence',0)))
PY
)"
  [[ "$sequence" -ge 37 ]] || { echo "PCG_WEB_MATERIAL_RELAY_RUNTIME=too-old" >&2; exit 47; }

  source_commit="$(tr -d '\r\n' < "$release/source-commit")"
  [[ "$source_commit" =~ ^[0-9a-f]{40}$ ]] || { echo "PCG_WEB_MATERIAL_RELAY_SOURCE=invalid" >&2; exit 47; }
  repo_cache=/var/lib/capability-fabric/deploy/pcg/repo.git
  [[ -d "$repo_cache" ]] || { echo "PCG_WEB_MATERIAL_RELAY_SOURCE=cache-missing" >&2; exit 47; }
  git --git-dir="$repo_cache" cat-file -e "$source_commit^{commit}"

  work="$(mktemp -d "$run_root/.material-relay-src.XXXXXX")"
  cleanup_material_relay() { rm -rf "$work"; }
  trap cleanup_material_relay EXIT
  chmod 0755 "$work"
  git --git-dir="$repo_cache" archive "$source_commit" src/capability_fabric | tar -x -C "$work"
  chown -R 65534:65534 "$work"
  find "$work" -type d -exec chmod 0755 {} +
  find "$work" -type f -exec chmod 0644 {} +

  image='python:3.12-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e'
  docker pull "$image" >/dev/null
  docker run --rm --network none --user 65534:65534 \
    -e PYTHONPATH=/src \
    -v "$work/src:/src:ro" \
    -v /var/lib/capability-fabric/pcg/core-state:/state:rw \
    -v /var/lib/capability-fabric/pcg/run:/run/pcg:rw \
    "$image" python - <<'PY'
import json
from uuid import uuid4

from capability_fabric.communications_runtime import PrivatePayloadBroker
from capability_fabric.domain import OutcomeState
from capability_fabric.persistence import SqliteExecutionStateStore
from capability_fabric.telegram_web_runtime import (
    TelegramWebSocketClient,
    TelegramWebUncertainEffectResolver,
    build_telegram_web_kernel_runtime,
)

client = TelegramWebSocketClient("/run/pcg/web.sock", timeout=45.0)
self_target = client.call({"op": "material.self_target"})
conversation_handle = self_target.get("conversation_handle")
if not isinstance(conversation_handle, str) or not conversation_handle.startswith("tgchat:"):
    raise SystemExit("self relay conversation resolution failed")

state = SqliteExecutionStateStore("/state/web-material-send.sqlite3")
payloads = PrivatePayloadBroker(
    "/state/web-material-payloads",
    ttl_seconds=86400,
    max_payload_bytes=8192,
)
try:
    runtime = build_telegram_web_kernel_runtime(
        client=client,
        payloads=payloads,
        state_store=state,
        journal=state,
    )

    canary_text = "pcg-relay-source-" + str(uuid4())
    source = runtime.send_text(
        conversation_handle=conversation_handle,
        text=canary_text,
    )
    if source.outcome.state is not OutcomeState.ACHIEVED:
        raise SystemExit("relay source send did not achieve")
    source_payload = str(source.dispatch.evidence["payload.handle"])
    payloads.remove(source_payload)

    target = client.call({
        "op": "material.self_relay_target",
        "expected_text": canary_text,
    })
    source_conversation_handle = target.get("source_conversation_handle")
    source_message_handle = target.get("source_message_handle")
    target_conversation_handle = target.get("conversation_handle")
    source_digest = target.get("source_content_sha256")
    if source_conversation_handle != conversation_handle or target_conversation_handle != conversation_handle:
        raise SystemExit("self relay conversation correlation mismatch")
    if not isinstance(source_message_handle, str) or not source_message_handle.startswith("tgmsg:"):
        raise SystemExit("self relay source resolution failed")
    if not isinstance(source_digest, str) or len(source_digest) != 64:
        raise SystemExit("self relay source digest missing")

    result = runtime.relay_text(
        source_conversation_handle=source_conversation_handle,
        source_message_handle=source_message_handle,
        conversation_handle=target_conversation_handle,
        purpose="TRANSPORT_RELAY",
    )
    if result.outcome.state is not OutcomeState.ACHIEVED:
        raise SystemExit("material relay did not achieve")
    if result.dispatch.evidence.get("telegram_web.source_conversation_handle") != source_conversation_handle:
        raise SystemExit("relay source conversation correlation mismatch")
    if result.dispatch.evidence.get("telegram_web.source_message_handle") != source_message_handle:
        raise SystemExit("relay source message correlation mismatch")
    if result.dispatch.evidence.get("telegram_web.conversation_handle") != target_conversation_handle:
        raise SystemExit("relay target correlation mismatch")
    if result.dispatch.evidence.get("telegram_web.relay_purpose") != "TRANSPORT_RELAY":
        raise SystemExit("relay purpose mismatch")
    if result.dispatch.evidence.get("telegram_web.source_content_sha256") != source_digest:
        raise SystemExit("relay source digest correlation mismatch")

    resolver = TelegramWebUncertainEffectResolver(client, payloads)
    observed = resolver.resolve(result.operation, result.attempt, result.dispatch)
    if observed.state is not OutcomeState.ACHIEVED:
        raise SystemExit("material relay authoritative readback failed")

    events = state.event_records()
    durable_intent = any(
        item.get("kind") == "state.dispatch_intent.persisted"
        and item.get("entity_id") == result.attempt.attempt_id
        for item in events
    )
    if not durable_intent:
        raise SystemExit("durable relay dispatch intent missing")

    safe = {
        "state": "ACHIEVED",
        "source_target_opaque": True,
        "destination_target_opaque": True,
        "transport_relay_authorized": True,
        "source_digest_bound": True,
        "copy_not_native_forward": True,
        "kernel_dispatch_intent": True,
        "provider_acknowledged": result.observation.ack_state.value == "ACKNOWLEDGED",
        "provider_confirmed": result.observation.detail == "provider_confirmed",
        "authoritative_relay_readback": True,
        "reconciliation_readback": "ACHIEVED",
        "provider_content_model_visible": False,
    }
    print(json.dumps(safe, separators=(",", ":")))
finally:
    state.close()
PY
  printf 'PCG_WEB_MATERIAL_RELAY_CANARY=pass\n'
  exit 0
fi

if [[ "$mode" == material-forward-canary ]]; then
  sequence="$(python3 - "$release/manifest.json" <<'PY'
import json,sys
print(int(json.load(open(sys.argv[1],encoding='utf-8')).get('sequence',0)))
PY
)"
  [[ "$sequence" -ge 36 ]] || { echo "PCG_WEB_MATERIAL_FORWARD_RUNTIME=too-old" >&2; exit 46; }

  source_commit="$(tr -d '\r\n' < "$release/source-commit")"
  [[ "$source_commit" =~ ^[0-9a-f]{40}$ ]] || { echo "PCG_WEB_MATERIAL_FORWARD_SOURCE=invalid" >&2; exit 46; }
  repo_cache=/var/lib/capability-fabric/deploy/pcg/repo.git
  [[ -d "$repo_cache" ]] || { echo "PCG_WEB_MATERIAL_FORWARD_SOURCE=cache-missing" >&2; exit 46; }
  git --git-dir="$repo_cache" cat-file -e "$source_commit^{commit}"

  work="$(mktemp -d "$run_root/.material-forward-src.XXXXXX")"
  cleanup_material_forward() { rm -rf "$work"; }
  trap cleanup_material_forward EXIT
  chmod 0755 "$work"
  git --git-dir="$repo_cache" archive "$source_commit" src/capability_fabric | tar -x -C "$work"
  chown -R 65534:65534 "$work"
  find "$work" -type d -exec chmod 0755 {} +
  find "$work" -type f -exec chmod 0644 {} +

  image='python:3.12-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e'
  docker pull "$image" >/dev/null
  docker run --rm --network none --user 65534:65534 \
    -e PYTHONPATH=/src \
    -v "$work/src:/src:ro" \
    -v /var/lib/capability-fabric/pcg/core-state:/state:rw \
    -v /var/lib/capability-fabric/pcg/run:/run/pcg:rw \
    "$image" python - <<'PY'
import json
from uuid import uuid4

from capability_fabric.communications_runtime import PrivatePayloadBroker
from capability_fabric.domain import OutcomeState
from capability_fabric.persistence import SqliteExecutionStateStore
from capability_fabric.telegram_web_runtime import (
    TelegramWebSocketClient,
    TelegramWebUncertainEffectResolver,
    build_telegram_web_kernel_runtime,
)

client = TelegramWebSocketClient("/run/pcg/web.sock", timeout=45.0)
self_target = client.call({"op": "material.self_target"})
conversation_handle = self_target.get("conversation_handle")
if not isinstance(conversation_handle, str) or not conversation_handle.startswith("tgchat:"):
    raise SystemExit("self forward conversation resolution failed")

state = SqliteExecutionStateStore("/state/web-material-send.sqlite3")
payloads = PrivatePayloadBroker(
    "/state/web-material-payloads",
    ttl_seconds=86400,
    max_payload_bytes=8192,
)
try:
    runtime = build_telegram_web_kernel_runtime(
        client=client,
        payloads=payloads,
        state_store=state,
        journal=state,
    )

    canary_text = "pcg-forward-source-" + str(uuid4())
    source = runtime.send_text(
        conversation_handle=conversation_handle,
        text=canary_text,
    )
    if source.outcome.state is not OutcomeState.ACHIEVED:
        raise SystemExit("forward source send did not achieve")
    source_payload = str(source.dispatch.evidence["payload.handle"])
    payloads.remove(source_payload)

    target = client.call({
        "op": "material.self_forward_target",
        "expected_text": canary_text,
    })
    source_conversation_handle = target.get("source_conversation_handle")
    source_message_handle = target.get("source_message_handle")
    target_conversation_handle = target.get("conversation_handle")
    if source_conversation_handle != conversation_handle or target_conversation_handle != conversation_handle:
        raise SystemExit("self forward conversation correlation mismatch")
    if not isinstance(source_message_handle, str) or not source_message_handle.startswith("tgmsg:"):
        raise SystemExit("self forward source resolution failed")

    result = runtime.forward_native(
        source_conversation_handle=source_conversation_handle,
        source_message_handle=source_message_handle,
        conversation_handle=target_conversation_handle,
    )
    if result.outcome.state is not OutcomeState.ACHIEVED:
        raise SystemExit("material native forward did not achieve")
    if result.dispatch.evidence.get("telegram_web.source_conversation_handle") != source_conversation_handle:
        raise SystemExit("native forward source conversation correlation mismatch")
    if result.dispatch.evidence.get("telegram_web.source_message_handle") != source_message_handle:
        raise SystemExit("native forward source message correlation mismatch")
    if result.dispatch.evidence.get("telegram_web.conversation_handle") != target_conversation_handle:
        raise SystemExit("native forward target correlation mismatch")

    resolver = TelegramWebUncertainEffectResolver(client, payloads)
    observed = resolver.resolve(result.operation, result.attempt, result.dispatch)
    if observed.state is not OutcomeState.ACHIEVED:
        raise SystemExit("material native forward authoritative readback failed")

    events = state.event_records()
    durable_intent = any(
        item.get("kind") == "state.dispatch_intent.persisted"
        and item.get("entity_id") == result.attempt.attempt_id
        for item in events
    )
    if not durable_intent:
        raise SystemExit("durable native-forward dispatch intent missing")

    safe = {
        "state": "ACHIEVED",
        "source_target_opaque": True,
        "destination_target_opaque": True,
        "native_forward": True,
        "kernel_dispatch_intent": True,
        "provider_acknowledged": result.observation.ack_state.value == "ACKNOWLEDGED",
        "provider_confirmed": result.observation.detail == "provider_confirmed",
        "authoritative_forward_readback": True,
        "reconciliation_readback": "ACHIEVED",
        "provider_content_model_visible": False,
    }
    print(json.dumps(safe, separators=(",", ":")))
finally:
    state.close()
PY
  printf 'PCG_WEB_MATERIAL_FORWARD_CANARY=pass\n'
  exit 0
fi

if [[ "$mode" == material-delete-canary ]]; then
  sequence="$(python3 - "$release/manifest.json" <<'PY'
import json,sys
print(int(json.load(open(sys.argv[1],encoding='utf-8')).get('sequence',0)))
PY
)"
  [[ "$sequence" -ge 35 ]] || { echo "PCG_WEB_MATERIAL_DELETE_RUNTIME=too-old" >&2; exit 45; }

  source_commit="$(tr -d '\r\n' < "$release/source-commit")"
  [[ "$source_commit" =~ ^[0-9a-f]{40}$ ]] || { echo "PCG_WEB_MATERIAL_DELETE_SOURCE=invalid" >&2; exit 45; }
  repo_cache=/var/lib/capability-fabric/deploy/pcg/repo.git
  [[ -d "$repo_cache" ]] || { echo "PCG_WEB_MATERIAL_DELETE_SOURCE=cache-missing" >&2; exit 45; }
  git --git-dir="$repo_cache" cat-file -e "$source_commit^{commit}"

  work="$(mktemp -d "$run_root/.material-delete-src.XXXXXX")"
  cleanup_material_delete() { rm -rf "$work"; }
  trap cleanup_material_delete EXIT
  chmod 0755 "$work"
  git --git-dir="$repo_cache" archive "$source_commit" src/capability_fabric | tar -x -C "$work"
  chown -R 65534:65534 "$work"
  find "$work" -type d -exec chmod 0755 {} +
  find "$work" -type f -exec chmod 0644 {} +

  image='python:3.12-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e'
  docker pull "$image" >/dev/null
  docker run --rm --network none --user 65534:65534 \
    -e PYTHONPATH=/src \
    -v "$work/src:/src:ro" \
    -v /var/lib/capability-fabric/pcg/core-state:/state:rw \
    -v /var/lib/capability-fabric/pcg/run:/run/pcg:rw \
    "$image" python - <<'PY'
import json
from uuid import uuid4

from capability_fabric.communications_runtime import PrivatePayloadBroker
from capability_fabric.domain import OutcomeState
from capability_fabric.persistence import SqliteExecutionStateStore
from capability_fabric.telegram_web_runtime import (
    TelegramWebSocketClient,
    TelegramWebUncertainEffectResolver,
    build_telegram_web_kernel_runtime,
)

client = TelegramWebSocketClient("/run/pcg/web.sock", timeout=45.0)
self_target = client.call({"op": "material.self_target"})
conversation_handle = self_target.get("conversation_handle")
if not isinstance(conversation_handle, str) or not conversation_handle.startswith("tgchat:"):
    raise SystemExit("self delete conversation resolution failed")

state = SqliteExecutionStateStore("/state/web-material-send.sqlite3")
payloads = PrivatePayloadBroker(
    "/state/web-material-payloads",
    ttl_seconds=86400,
    max_payload_bytes=8192,
)
try:
    runtime = build_telegram_web_kernel_runtime(
        client=client,
        payloads=payloads,
        state_store=state,
        journal=state,
    )

    canary_text = "pcg-delete-source-" + str(uuid4())
    source = runtime.send_text(
        conversation_handle=conversation_handle,
        text=canary_text,
    )
    if source.outcome.state is not OutcomeState.ACHIEVED:
        raise SystemExit("delete source send did not achieve")
    source_payload = str(source.dispatch.evidence["payload.handle"])
    payloads.remove(source_payload)

    target = client.call({
        "op": "material.self_delete_target",
        "expected_text": canary_text,
    })
    delete_conversation = target.get("conversation_handle")
    message_handle = target.get("message_handle")
    if delete_conversation != conversation_handle:
        raise SystemExit("self delete conversation correlation mismatch")
    if target.get("deletion_scope") != "SELF_ONLY":
        raise SystemExit("self delete scope resolution mismatch")
    if not isinstance(message_handle, str) or not message_handle.startswith("tgmsg:"):
        raise SystemExit("self delete message resolution failed")

    result = runtime.delete_message(
        conversation_handle=conversation_handle,
        message_handle=message_handle,
        scope="SELF_ONLY",
    )
    if result.outcome.state is not OutcomeState.ACHIEVED:
        raise SystemExit("material delete did not achieve")
    if result.dispatch.evidence.get("telegram_web.message_handle") != message_handle:
        raise SystemExit("delete target correlation mismatch")
    if result.dispatch.evidence.get("telegram_web.delete_scope") != "SELF_ONLY":
        raise SystemExit("delete scope correlation mismatch")

    resolver = TelegramWebUncertainEffectResolver(client, payloads)
    observed = resolver.resolve(result.operation, result.attempt, result.dispatch)
    if observed.state is not OutcomeState.ACHIEVED:
        raise SystemExit("material delete authoritative absence readback failed")

    events = state.event_records()
    durable_intent = any(
        item.get("kind") == "state.dispatch_intent.persisted"
        and item.get("entity_id") == result.attempt.attempt_id
        for item in events
    )
    if not durable_intent:
        raise SystemExit("durable delete dispatch intent missing")

    safe = {
        "state": "ACHIEVED",
        "self_target_opaque": True,
        "message_target_opaque": True,
        "deletion_scope": "SELF_ONLY",
        "kernel_dispatch_intent": True,
        "provider_acknowledged": result.observation.ack_state.value == "ACKNOWLEDGED",
        "provider_confirmed": result.observation.detail == "provider_confirmed",
        "authoritative_absence": True,
        "reconciliation_readback": "ACHIEVED",
        "provider_content_model_visible": False,
    }
    print(json.dumps(safe, separators=(",", ":")))
finally:
    state.close()
PY
  printf 'PCG_WEB_MATERIAL_DELETE_CANARY=pass\n'
  exit 0
fi

if [[ "$mode" == material-edit-canary ]]; then
  sequence="$(python3 - "$release/manifest.json" <<'PY'
import json,sys
print(int(json.load(open(sys.argv[1],encoding='utf-8')).get('sequence',0)))
PY
)"
  [[ "$sequence" -ge 34 ]] || { echo "PCG_WEB_MATERIAL_EDIT_RUNTIME=too-old" >&2; exit 44; }

  source_commit="$(tr -d '\r\n' < "$release/source-commit")"
  [[ "$source_commit" =~ ^[0-9a-f]{40}$ ]] || { echo "PCG_WEB_MATERIAL_EDIT_SOURCE=invalid" >&2; exit 44; }
  repo_cache=/var/lib/capability-fabric/deploy/pcg/repo.git
  [[ -d "$repo_cache" ]] || { echo "PCG_WEB_MATERIAL_EDIT_SOURCE=cache-missing" >&2; exit 44; }
  git --git-dir="$repo_cache" cat-file -e "$source_commit^{commit}"

  work="$(mktemp -d "$run_root/.material-edit-src.XXXXXX")"
  cleanup_material_edit() { rm -rf "$work"; }
  trap cleanup_material_edit EXIT
  chmod 0755 "$work"
  git --git-dir="$repo_cache" archive "$source_commit" src/capability_fabric | tar -x -C "$work"
  chown -R 65534:65534 "$work"
  find "$work" -type d -exec chmod 0755 {} +
  find "$work" -type f -exec chmod 0644 {} +

  image='python:3.12-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e'
  docker pull "$image" >/dev/null
  docker run --rm --network none --user 65534:65534 \
    -e PYTHONPATH=/src \
    -v "$work/src:/src:ro" \
    -v /var/lib/capability-fabric/pcg/core-state:/state:rw \
    -v /var/lib/capability-fabric/pcg/run:/run/pcg:rw \
    "$image" python - <<'PY'
import json
from uuid import uuid4

from capability_fabric.communications_runtime import PrivatePayloadBroker
from capability_fabric.domain import OutcomeState
from capability_fabric.persistence import SqliteExecutionStateStore
from capability_fabric.telegram_web_runtime import (
    TelegramWebSocketClient,
    TelegramWebUncertainEffectResolver,
    build_telegram_web_kernel_runtime,
)

client = TelegramWebSocketClient("/run/pcg/web.sock", timeout=45.0)
self_target = client.call({"op": "material.self_target"})
conversation_handle = self_target.get("conversation_handle")
if not isinstance(conversation_handle, str) or not conversation_handle.startswith("tgchat:"):
    raise SystemExit("self edit conversation resolution failed")

state = SqliteExecutionStateStore("/state/web-material-send.sqlite3")
payloads = PrivatePayloadBroker(
    "/state/web-material-payloads",
    ttl_seconds=86400,
    max_payload_bytes=8192,
)
try:
    runtime = build_telegram_web_kernel_runtime(
        client=client,
        payloads=payloads,
        state_store=state,
        journal=state,
    )

    source = runtime.send_text(
        conversation_handle=conversation_handle,
        text="pcg-edit-source-" + str(uuid4()),
    )
    if source.outcome.state is not OutcomeState.ACHIEVED:
        raise SystemExit("edit source send did not achieve")
    source_payload = str(source.dispatch.evidence["payload.handle"])
    payloads.remove(source_payload)

    target = client.call({"op": "material.self_edit_target"})
    edit_conversation = target.get("conversation_handle")
    message_handle = target.get("message_handle")
    if edit_conversation != conversation_handle:
        raise SystemExit("self edit conversation correlation mismatch")
    if not isinstance(message_handle, str) or not message_handle.startswith("tgmsg:"):
        raise SystemExit("self edit message resolution failed")

    result = runtime.edit_text(
        conversation_handle=conversation_handle,
        message_handle=message_handle,
        text="pcg-edit-canary-" + str(uuid4()),
    )
    if result.outcome.state is not OutcomeState.ACHIEVED:
        raise SystemExit("material edit did not achieve")
    if result.dispatch.evidence.get("telegram_web.message_handle") != message_handle:
        raise SystemExit("edit target correlation mismatch")

    resolver = TelegramWebUncertainEffectResolver(client, payloads)
    observed = resolver.resolve(result.operation, result.attempt, result.dispatch)
    if observed.state is not OutcomeState.ACHIEVED:
        raise SystemExit("material edit authoritative readback failed")

    events = state.event_records()
    durable_intent = any(
        item.get("kind") == "state.dispatch_intent.persisted"
        and item.get("entity_id") == result.attempt.attempt_id
        for item in events
    )
    if not durable_intent:
        raise SystemExit("durable edit dispatch intent missing")

    payload_handle = str(result.dispatch.evidence["payload.handle"])
    payloads.remove(payload_handle)
    payload_removed = False
    try:
        payloads.resolve(payload_handle)
    except KeyError:
        payload_removed = True
    if not payload_removed:
        raise SystemExit("edit payload cleanup failed")

    safe = {
        "state": "ACHIEVED",
        "self_target_opaque": True,
        "message_target_opaque": True,
        "kernel_dispatch_intent": True,
        "provider_acknowledged": result.observation.ack_state.value == "ACKNOWLEDGED",
        "provider_confirmed": result.observation.detail == "provider_confirmed",
        "reconciliation_readback": "ACHIEVED",
        "payload_removed": True,
        "provider_content_model_visible": False,
    }
    print(json.dumps(safe, separators=(",", ":")))
finally:
    state.close()
PY
  printf 'PCG_WEB_MATERIAL_EDIT_CANARY=pass\n'
  exit 0
fi

if [[ "$mode" == material-reply-canary ]]; then
  sequence="$(python3 - "$release/manifest.json" <<'PY'
import json,sys
print(int(json.load(open(sys.argv[1],encoding='utf-8')).get('sequence',0)))
PY
)"
  [[ "$sequence" -ge 31 ]] || { echo "PCG_WEB_MATERIAL_REPLY_RUNTIME=too-old" >&2; exit 41; }

  source_commit="$(tr -d '\r\n' < "$release/source-commit")"
  [[ "$source_commit" =~ ^[0-9a-f]{40}$ ]] || { echo "PCG_WEB_MATERIAL_REPLY_SOURCE=invalid" >&2; exit 41; }
  repo_cache=/var/lib/capability-fabric/deploy/pcg/repo.git
  [[ -d "$repo_cache" ]] || { echo "PCG_WEB_MATERIAL_REPLY_SOURCE=cache-missing" >&2; exit 41; }
  git --git-dir="$repo_cache" cat-file -e "$source_commit^{commit}"

  work="$(mktemp -d "$run_root/.material-reply-src.XXXXXX")"
  cleanup_material_reply() { rm -rf "$work"; }
  trap cleanup_material_reply EXIT
  chmod 0755 "$work"
  git --git-dir="$repo_cache" archive "$source_commit" src/capability_fabric | tar -x -C "$work"
  chown -R 65534:65534 "$work"
  find "$work" -type d -exec chmod 0755 {} +
  find "$work" -type f -exec chmod 0644 {} +

  image='python:3.12-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e'
  docker pull "$image" >/dev/null
  docker run --rm --network none --user 65534:65534 \
    -e PYTHONPATH=/src \
    -v "$work/src:/src:ro" \
    -v /var/lib/capability-fabric/pcg/core-state:/state:rw \
    -v /var/lib/capability-fabric/pcg/run:/run/pcg:rw \
    "$image" python - <<'PY'
import json
from uuid import uuid4

from capability_fabric.communications_runtime import PrivatePayloadBroker
from capability_fabric.domain import OutcomeState
from capability_fabric.persistence import SqliteExecutionStateStore
from capability_fabric.telegram_web_runtime import (
    TelegramWebSocketClient,
    TelegramWebUncertainEffectResolver,
    build_telegram_web_kernel_runtime,
)

client = TelegramWebSocketClient("/run/pcg/web.sock", timeout=35.0)
target = client.call({"op": "material.self_reply_target"})
conversation_handle = target.get("conversation_handle")
source_message_handle = target.get("source_message_handle")
if not isinstance(conversation_handle, str) or not conversation_handle.startswith("tgchat:"):
    raise SystemExit("self reply conversation target resolution failed")
if not isinstance(source_message_handle, str) or not source_message_handle.startswith("tgmsg:"):
    raise SystemExit("self reply source target resolution failed")

state = SqliteExecutionStateStore("/state/web-material-send.sqlite3")
payloads = PrivatePayloadBroker(
    "/state/web-material-payloads",
    ttl_seconds=86400,
    max_payload_bytes=4096,
)
try:
    runtime = build_telegram_web_kernel_runtime(
        client=client,
        payloads=payloads,
        state_store=state,
        journal=state,
    )
    result = runtime.reply_text(
        conversation_handle=conversation_handle,
        source_message_handle=source_message_handle,
        text="pcg-material-reply-canary-" + str(uuid4()),
    )
    if result.outcome.state is not OutcomeState.ACHIEVED:
        raise SystemExit("material reply did not achieve")

    resolver = TelegramWebUncertainEffectResolver(client, payloads)
    observed = resolver.resolve(result.operation, result.attempt, result.dispatch)
    if observed.state is not OutcomeState.ACHIEVED:
        raise SystemExit("material reply authoritative readback failed")

    events = state.event_records()
    durable_intent = any(
        item.get("kind") == "state.dispatch_intent.persisted"
        and item.get("entity_id") == result.attempt.attempt_id
        for item in events
    )
    if not durable_intent:
        raise SystemExit("durable reply dispatch intent missing")

    payload_handle = str(result.dispatch.evidence["payload.handle"])
    payloads.remove(payload_handle)
    payload_removed = False
    try:
        payloads.resolve(payload_handle)
    except KeyError:
        payload_removed = True
    if not payload_removed:
        raise SystemExit("reply payload cleanup failed")

    safe = {
        "state": "ACHIEVED",
        "self_target_opaque": True,
        "source_message_opaque": True,
        "kernel_dispatch_intent": True,
        "provider_acknowledged": result.observation.ack_state.value == "ACKNOWLEDGED",
        "provider_confirmed": result.observation.detail == "provider_confirmed",
        "reply_relationship_authoritative": True,
        "reconciliation_readback": "ACHIEVED",
        "payload_removed": True,
        "provider_content_model_visible": False,
    }
    print(json.dumps(safe, separators=(",", ":")))
finally:
    state.close()
PY
  printf 'PCG_WEB_MATERIAL_REPLY_CANARY=pass\n'
  exit 0
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
