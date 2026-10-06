#!/usr/bin/env python3
import json
import os
import signal
import socket
import time

SOCKET_PATH = os.environ.get("PCG_TELEGRAM_SOCKET", "/run/pcg/telegram.sock")
STATE_PATH = os.environ.get("PCG_CORE_HEALTH", "/state/core-health.json")
STOP = False

def stop_handler(_signum, _frame):
    global STOP
    STOP = True

signal.signal(signal.SIGTERM, stop_handler)
signal.signal(signal.SIGINT, stop_handler)

def probe():
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(2.0)
    try:
        client.connect(SOCKET_PATH)
        client.sendall(b'{"op":"health"}')
        raw = client.recv(4096)
    finally:
        client.close()
    data = json.loads(raw.decode("utf-8"))
    if data.get("ok") is not True or data.get("component") != "pcg-telegram":
        raise RuntimeError("telegram stub health contract mismatch")
    return data

def write_state(payload):
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    temp = STATE_PATH + ".tmp"
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, sort_keys=True, separators=(",", ":"))
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp, STATE_PATH)

while not STOP:
    try:
        telegram = probe()
        state = {
            "ok": True,
            "component": "pcg-core",
            "telegram_runtime": "REACHABLE",
            "telegram_runtime_mode": telegram.get("mode", "UNKNOWN"),
            "tdlib_version": telegram.get("tdlib_version"),
            "tdlib_client": telegram.get("tdlib_client"),
            "provider_network": telegram.get("provider_network"),
            "telegram_authorization": telegram["authorization"],
            "telegram_authorization_state": telegram.get("authorization_state"),
            "startup_reconciliation": telegram["startup_reconciliation"],
            "material_send_admission": "CLOSED",
            "presence_control": telegram.get("presence_control", "UNKNOWN"),
            "online_effective": telegram.get("online_effective", "UNCHECKED"),
            "provisioning_surface": telegram.get("provisioning_surface", "UNKNOWN"),
            "model_content_admission": telegram.get("model_content_admission", "CLOSED"),
            "model_visible_contract": "LOCAL_ONLY",
            "updated_at": int(time.time()),
        }
    except Exception:
        state = {
            "ok": False,
            "component": "pcg-core",
            "telegram_runtime": "UNREACHABLE",
            "telegram_runtime_mode": "UNKNOWN",
            "tdlib_version": None,
            "tdlib_client": "UNKNOWN",
            "provider_network": "UNKNOWN",
            "telegram_authorization": "UNKNOWN",
            "telegram_authorization_state": "UNKNOWN",
            "startup_reconciliation": "BLOCKED",
            "material_send_admission": "CLOSED",
            "presence_control": "UNKNOWN",
            "online_effective": "UNKNOWN",
            "provisioning_surface": "UNKNOWN",
            "model_content_admission": "CLOSED",
            "model_visible_contract": "LOCAL_ONLY",
            "updated_at": int(time.time()),
        }
    write_state(state)
    for _ in range(20):
        if STOP:
            break
        time.sleep(0.1)
