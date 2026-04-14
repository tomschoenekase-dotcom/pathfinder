// Railway's stale start command: cd /app/apps/dashboard && node server.js
// This file lives at /app/apps/dashboard/server.js and proxies to the real
// Next.js standalone server at /app/apps/admin/server.js.
require('/app/apps/admin/server.js');
