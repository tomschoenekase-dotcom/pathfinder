// Railway's stale start command cds into a different directory before running
// this file. The Next.js standalone server uses process.cwd() to resolve
// asset paths, so we must reset it to /app before requiring.
process.chdir('/app');
require('/app/server.js');
