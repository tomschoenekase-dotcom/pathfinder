#!/bin/sh
set -eu

# Railway can persist an old start command override and try to exec:
#   cd apps/admin && node server.js
# as a binary instead of through a shell. Handle that exact pattern here.
if [ "${1:-}" = "apps/admin" ]; then
  shift || true
  if [ "${1:-}" = "&&" ]; then
    shift || true
  fi
  cd /app/apps/admin
  if [ "$#" -gt 0 ]; then
    exec "$@"
  fi
  exec node server.js
fi

echo "Unsupported cd invocation: $*" >&2
exit 1
