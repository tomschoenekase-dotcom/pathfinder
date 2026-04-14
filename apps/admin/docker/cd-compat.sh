#!/bin/sh
# Railway persists a stale start command and execs "cd" as a binary.
# Whatever directory it tries to cd to, we ignore it and always boot
# the admin server from its actual location.
exec node /app/apps/admin/server.js
