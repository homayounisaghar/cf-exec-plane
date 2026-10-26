#!/usr/bin/env bash
set -euo pipefail

run_dir=/var/lib/capability-fabric/pcg/run
core_state=/var/lib/capability-fabric/pcg/core-state
telegram_state=/var/lib/capability-fabric/pcg/telegram-state
web_profile=/var/lib/capability-fabric/pcg/telegram-web-profile
correlation=/var/lib/capability-fabric/pcg/correlation
api_dir=/var/lib/capability-fabric/pcg/api-credentials
key_dir=/var/lib/capability-fabric/pcg/db-key
db_key="$key_dir/tdlib-db-key"
handoff_dir=/run/capability-fabric/pcg-provision

[[ "$(stat -c '%a %u:%g' "$run_dir")" == "770 65534:65534" ]]
[[ "$(stat -c '%a %u:%g' "$core_state")" == "700 65534:65534" ]]
[[ "$(stat -c '%a %u:%g' "$telegram_state")" == "700 65534:65534" ]]
[[ "$(stat -c '%a %u:%g' "$web_profile")" == "700 65534:65534" ]]
[[ "$(stat -c '%a %u:%g' "$correlation")" == "700 0:0" ]]
[[ "$(stat -c '%a %u:%g' "$api_dir")" == "700 65534:65534" ]]
[[ "$(stat -c '%a %u:%g' "$key_dir")" == "750 0:65534" ]]
[[ "$(stat -c '%a %u:%g' "$db_key")" == "640 0:65534" ]]
[[ "$(stat -c '%s' "$db_key")" -ge 32 ]]
[[ "$(stat -c '%a %u:%g' "$handoff_dir")" == "755 0:0" ]]

telegram_cid="$(docker compose -p "$CF_COMPOSE_PROJECT" -f "$CF_RELEASE_DIR/compose.yaml" ps -q pcg_telegram)"
asr_cid="$(docker compose -p "$CF_COMPOSE_PROJECT" -f "$CF_RELEASE_DIR/compose.yaml" ps -q pcg_asr)"
audio_transform_cid="$(docker compose -p "$CF_COMPOSE_PROJECT" -f "$CF_RELEASE_DIR/compose.yaml" ps -q pcg_audio_transform)"
perplexity_asr_cid="$(docker compose -p "$CF_COMPOSE_PROJECT" -f "$CF_RELEASE_DIR/compose.yaml" ps -q pcg_perplexity_asr)"
web_cid="$(docker compose -p "$CF_COMPOSE_PROJECT" -f "$CF_RELEASE_DIR/compose.yaml" ps -q pcg_web)"
core_cid="$(docker compose -p "$CF_COMPOSE_PROJECT" -f "$CF_RELEASE_DIR/compose.yaml" ps -q pcg_core)"
[[ -n "$telegram_cid" && -n "$asr_cid" && -n "$audio_transform_cid" && -n "$perplexity_asr_cid" && -n "$web_cid" && -n "$core_cid" ]]

# Readback: the running containers must belong to this very release directory,
# so a deploy that silently kept the previous code cannot report success.
for cid in "$telegram_cid" "$asr_cid" "$audio_transform_cid" "$perplexity_asr_cid" "$web_cid" "$core_cid"; do
  live_dir="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$cid")"
  if [[ "$live_dir" != "$CF_RELEASE_DIR" ]]; then
    echo "PCG_LIVE_RELEASE_MISMATCH live='$live_dir' expected='$CF_RELEASE_DIR'" >&2
    exit 1
  fi
done

for _ in $(seq 1 90); do
  telegram_health="$(docker inspect -f '{{.State.Health.Status}}' "$telegram_cid" 2>/dev/null || true)"
  asr_health="$(docker inspect -f '{{.State.Health.Status}}' "$asr_cid" 2>/dev/null || true)"
  audio_transform_health="$(docker inspect -f '{{.State.Health.Status}}' "$audio_transform_cid" 2>/dev/null || true)"
  perplexity_asr_health="$(docker inspect -f '{{.State.Health.Status}}' "$perplexity_asr_cid" 2>/dev/null || true)"
  web_health="$(docker inspect -f '{{.State.Health.Status}}' "$web_cid" 2>/dev/null || true)"
  core_health_status="$(docker inspect -f '{{.State.Health.Status}}' "$core_cid" 2>/dev/null || true)"
  [[ "$telegram_health" == healthy && "$asr_health" == healthy && "$audio_transform_health" == healthy && "$perplexity_asr_health" == healthy && "$web_health" == healthy && "$core_health_status" == healthy ]] && break
  sleep 1
done
[[ "$telegram_health" == healthy && "$asr_health" == healthy && "$audio_transform_health" == healthy && "$perplexity_asr_health" == healthy && "$web_health" == healthy && "$core_health_status" == healthy ]]

for cid in "$telegram_cid" "$asr_cid" "$perplexity_asr_cid" "$web_cid" "$core_cid"; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$cid")" == "true" ]]
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$cid")" == "healthy" ]]
  [[ "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$cid")" == "true" ]]
  [[ "$(docker inspect -f '{{.HostConfig.Memory}}' "$cid")" -gt 0 ]]
  [[ "$(docker inspect -f '{{.HostConfig.NanoCpus}}' "$cid")" -gt 0 ]]
  mounts="$(docker inspect -f '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}' "$cid")"
  if printf '%s\n' "$mounts" | grep -q '/etc/capability-fabric/secrets'; then
    echo "PCG runtime unexpectedly mounts global secret material" >&2
    exit 1
  fi
done

[[ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$core_cid")" == "none" ]]
[[ -z "$(docker port "$core_cid" 2>/dev/null || true)" ]]

[[ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$asr_cid")" == "none" ]]
[[ -z "$(docker port "$asr_cid" 2>/dev/null || true)" ]]

[[ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$audio_transform_cid")" == "none" ]]
[[ -z "$(docker port "$audio_transform_cid" 2>/dev/null || true)" ]]

[[ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$perplexity_asr_cid")" == "bridge" ]]
perplexity_port_line="$(docker port "$perplexity_asr_cid" 8767/tcp)"
[[ "$perplexity_port_line" == "127.0.0.1:8767" ]]
[[ "$(docker inspect -f '{{.HostConfig.ShmSize}}' "$perplexity_asr_cid")" -ge 134217728 ]]

[[ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$telegram_cid")" == "bridge" ]]
port_line="$(docker port "$telegram_cid" 8766/tcp)"
[[ "$port_line" == "127.0.0.1:8766" ]]
all_ports="$(docker port "$telegram_cid")"
[[ "$all_ports" == "8766/tcp -> 127.0.0.1:8766" ]]

[[ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$web_cid")" == "bridge" ]]
[[ -z "$(docker port "$web_cid" 2>/dev/null || true)" ]]
[[ "$(docker inspect -f '{{.HostConfig.ShmSize}}' "$web_cid")" -ge 134217728 ]]

telegram_mounts="$(docker inspect -f '{{range .Mounts}}{{println .Source "|" .Destination "|" .RW}}{{end}}' "$telegram_cid")"
grep -Fq '/var/lib/capability-fabric/pcg/api-credentials | /api-credentials | true' <<<"$telegram_mounts"
grep -Fq '/var/lib/capability-fabric/pcg/db-key | /db-key | false' <<<"$telegram_mounts"
grep -Fq '/var/lib/capability-fabric/pcg/telegram-state | /state | true' <<<"$telegram_mounts"
grep -Fq '/run/capability-fabric/pcg-provision | /provision | false' <<<"$telegram_mounts"

web_mounts="$(docker inspect -f '{{range .Mounts}}{{println .Source "|" .Destination "|" .RW}}{{end}}' "$web_cid")"
grep -Fq '/var/lib/capability-fabric/pcg/telegram-web-profile | /profile | true' <<<"$web_mounts"
grep -Fq '/var/lib/capability-fabric/pcg/run | /run/pcg | true' <<<"$web_mounts"

asr_mounts="$(docker inspect -f '{{range .Mounts}}{{println .Source "|" .Destination "|" .RW}}{{end}}' "$asr_cid")"
grep -Fq '/var/lib/capability-fabric/pcg/run | /run/pcg | true' <<<"$asr_mounts"

audio_transform_mounts="$(docker inspect -f '{{range .Mounts}}{{println .Source "|" .Destination "|" .RW}}{{end}}' "$audio_transform_cid")"
grep -Fq '/var/lib/capability-fabric/pcg/run | /run/pcg | true' <<<"$audio_transform_mounts"

perplexity_asr_mounts="$(docker inspect -f '{{range .Mounts}}{{println .Source "|" .Destination "|" .RW}}{{end}}' "$perplexity_asr_cid")"
grep -Fq '/var/lib/capability-fabric/pcg/run | /run/pcg | true' <<<"$perplexity_asr_mounts"

core_health="$core_state/core-health.json"
[[ -s "$core_health" ]]
python3 - "$core_health" <<'PY'
import json,sys,time
with open(sys.argv[1],encoding='utf-8') as f: d=json.load(f)
expected={
    'ok': True,
    'component': 'pcg-core',
    'telegram_runtime': 'REACHABLE',
    'telegram_runtime_mode': 'REAL_TDLIB_PROVISIONABLE',
    'tdlib_version': '1.8.67',
    'provider_network': 'ENABLED_FOR_AUTH_RUNTIME',
    'startup_reconciliation': 'COMPLETE_NO_EFFECTS',
    'material_send_admission': 'CLOSED',
    'model_content_admission': 'CLOSED',
    'presence_control': 'NOT_INVOKED',
    'model_visible_contract': 'LOCAL_ONLY',
}
for key,value in expected.items():
    if d.get(key) != value:
        raise SystemExit(f'bad {key}: {d.get(key)!r}')
if d.get('telegram_authorization') not in {'PROVISIONING_REQUIRED','PROVISIONING_INCOMPLETE','READY'}:
    raise SystemExit('bad authorization state')
if d.get('telegram_authorization') == 'READY' and d.get('online_effective') != 'FALSE':
    raise SystemExit('READY requires effective online=false')
if time.time()-int(d['updated_at']) >= 15:
    raise SystemExit('stale pcg-core health')
PY

[[ -S "$run_dir/telegram.sock" ]]
[[ "$(stat -c '%a %u:%g' "$run_dir/telegram.sock")" == "660 65534:65534" ]]
[[ -S "$run_dir/asr.sock" ]]
[[ "$(stat -c '%a %u:%g' "$run_dir/asr.sock")" == "660 65534:65534" ]]
[[ -S "$run_dir/audio-transform.sock" ]]
[[ "$(stat -c '%a %u:%g' "$run_dir/audio-transform.sock")" == "660 65534:65534" ]]
[[ -S "$run_dir/perplexity-asr.sock" ]]
[[ "$(stat -c '%a %u:%g' "$run_dir/perplexity-asr.sock")" == "660 65534:65534" ]]
[[ -S "$run_dir/web.sock" ]]
[[ "$(stat -c '%a %u:%g' "$run_dir/web.sock")" == "660 65534:65534" ]]
[[ "$(stat -c '%a %u:%g' "$run_dir/ingress")" == "770 65534:65534" ]]
[[ -S "$run_dir/ingress/web.sock" ]]
[[ "$(stat -c '%a %u:%g' "$run_dir/ingress/web.sock")" == "660 65534:65534" ]]
[[ -S "$run_dir/ingress/material-upload.sock" ]]
[[ "$(stat -c '%a %u:%g' "$run_dir/ingress/material-upload.sock")" == "660 65534:65534" ]]

python3 - "$run_dir/asr.sock" <<'PY'
import json,socket,sys
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.settimeout(3)
s.connect(sys.argv[1])
s.sendall(b'{"op":"health"}\n')
buf=b''
while b'\n' not in buf:
    chunk=s.recv(262144)
    if not chunk:
        break
    buf+=chunk
s.close()
if not buf:
    raise SystemExit('empty pcg-asr health response')
d=json.loads(buf.split(b'\n',1)[0])
if d.get('ok') is not True or d.get('state') != 'READY':
    raise SystemExit('pcg-asr health not ready')
if d.get('engine_id') != 'faster-whisper':
    raise SystemExit('pcg-asr engine mismatch')
if d.get('model_id') != 'Systran/faster-whisper-medium':
    raise SystemExit('pcg-asr model mismatch')
if d.get('decoder_id') != 'pyav':
    raise SystemExit('pcg-asr decoder mismatch')
if d.get('decoder_version') != '18.1.0':
    raise SystemExit('pcg-asr decoder version mismatch')
if d.get('job_schema') != 2:
    raise SystemExit('pcg-asr job schema mismatch')
PY

python3 - "$run_dir/audio-transform.sock" <<'PY'
import json,socket,sys
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.settimeout(4)
s.connect(sys.argv[1])
s.sendall(b'{"op":"health"}\n')
buf=b''
while b'\n' not in buf:
    chunk=s.recv(65536)
    if not chunk:
        break
    buf+=chunk
s.close()
if not buf:
    raise SystemExit('empty pcg-audio-transform health response')
d=json.loads(buf.split(b'\n',1)[0])
if d.get('ok') is not True or d.get('state') != 'READY':
    raise SystemExit('pcg-audio-transform not ready')
if d.get('engine') != 'pyav-libopus-file' or d.get('opus_encoder') is not True:
    raise SystemExit('pcg-audio-transform encoder mismatch')
if d.get('sample_rate') != 48000 or d.get('bitrate_bps') != 128000:
    raise SystemExit('pcg-audio-transform policy mismatch')
PY

python3 - "$run_dir/perplexity-asr.sock" <<'PY'
import json,socket,sys
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.settimeout(5)
s.connect(sys.argv[1])
s.sendall(b'{"op":"health"}\n')
buf=b''
while b'\n' not in buf:
    chunk=s.recv(262144)
    if not chunk:
        break
    buf+=chunk
s.close()
if not buf:
    raise SystemExit('empty pcg-perplexity-asr health response')
d=json.loads(buf.split(b'\n',1)[0])
if d.get('ok') is not True or d.get('state') != 'READY':
    raise SystemExit('pcg-perplexity-asr browser not ready')
if d.get('engine_id') != 'perplexity-session-soniox':
    raise SystemExit('pcg-perplexity-asr engine mismatch')
if d.get('model_id') != 'soniox-stt-rt-v4':
    raise SystemExit('pcg-perplexity-asr model mismatch')
if d.get('whole_message') is not True or d.get('endpoint_detection') is not False:
    raise SystemExit('pcg-perplexity-asr whole-message policy mismatch')
if d.get('default_stream_speed_factor') != 4:
    raise SystemExit('pcg-perplexity-asr default stream speed mismatch')
PY

python3 - "$run_dir/web.sock" <<'PY'
import json,socket,sys

def call(payload):
    s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
    s.settimeout(3)
    s.connect(sys.argv[1])
    s.sendall((json.dumps(payload,separators=(',',':'))+'\n').encode())
    buf=b''
    while b'\n' not in buf:
        chunk=s.recv(4096)
        if not chunk:
            break
        buf+=chunk
    s.close()
    if not buf:
        raise SystemExit('empty pcg-web response')
    return json.loads(buf.split(b'\n',1)[0])

d=call({'op':'health'})
if d.get('ok') is not True:
    raise SystemExit('pcg-web health not ok')
if d.get('phase') == 'BROWSER_CLOSED':
    raise SystemExit('pcg-web browser closed')
if d.get('origin') not in (None, 'https://web.telegram.org'):
    raise SystemExit('pcg-web unexpected origin')

caps=call({'op':'semantic.list'})
if caps.get('ok') is not True:
    raise SystemExit('pcg-web semantic.list failed')
ops={item.get('operation') for item in caps.get('capabilities',[])}
required={'communication.session.status','communication.conversation.list','communication.conversation.mark_unread','communication.audio.transcribe'}
if not required.issubset(ops):
    raise SystemExit(f'pcg-web semantic capabilities missing: {required-ops!r}')

status=call({'op':'semantic.invoke','operation':'communication.session.status','args':{}})
if status.get('ok') is not True or status.get('state') != 'ACHIEVED':
    raise SystemExit('pcg-web semantic session status failed')
if status.get('operation') != 'communication.session.status':
    raise SystemExit('pcg-web semantic operation mismatch')
obs=status.get('observation') or {}
if obs.get('provider_content_model_visible') is not False:
    raise SystemExit('pcg-web semantic status must be model-content closed')
PY
printf 'CF_PCG_FINAL_CHANNEL_HEALTH=pass\n'
printf 'CF_PCG_PROVIDER_NETWORK=auth-runtime-only\n'
printf 'CF_PCG_LOOPBACK_PROVISION_PORT=pass\n'
printf 'CF_PCG_SPLIT_SECRET_MOUNTS=pass\n'
printf 'CF_PCG_ASR_SIDECAR=healthy\n'
printf 'CF_PCG_ASR_NETWORK=none\n'
printf 'CF_PCG_PERPLEXITY_ASR_BROWSER=healthy\n'
printf 'CF_PCG_PERPLEXITY_ASR_WHOLE_MESSAGE=pass\n'
printf 'CF_PCG_WEB_BROWSER=healthy\n'
printf 'CF_PCG_WEB_PROFILE=isolated\n'
printf 'CF_PCG_RESOURCE_LIMITS=pass\n'
printf 'CF_PCG_MATERIAL_SEND_ADMISSION=closed\n'
printf 'CF_PCG_MODEL_CONTENT_ADMISSION=closed\n'
