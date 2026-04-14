#!/bin/sh
set -eu

# Railway persists a stale start command and execs "cd" as a binary.
# This shim handles any "cd <dir> [&& <cmd> ...]" pattern:
#   cd apps/admin && node server.js
#   cd /app/apps/admin && node server.js
#   cd /app/apps/dashboard && node server.js

dir="${1:-}"
if [ -z "$dir" ]; then
  echo "cd-compat: no directory argument" >&2
  exit 1
fi

shift || true

# Strip leading && if Railway passes it as a separate arg
if [ "${1:-}" = "&&" ]; then
  shift || true
fi

cd "$dir"

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

exec node server.js
