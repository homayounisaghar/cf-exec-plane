#!/usr/bin/env bash
set -euo pipefail
echo "PCG_ACL_CAPABILITY_BEGIN"
if command -v setfacl >/dev/null 2>&1 && command -v getfacl >/dev/null 2>&1; then
  echo "setfacl=yes"
  getfacl -cp /run/capability-fabric 2>/dev/null || true
else
  echo "setfacl=no"
fi
stat -c 'run_capability_fabric_mode=%a owner=%U group=%G' /run/capability-fabric
echo "PCG_ACL_CAPABILITY_END"
