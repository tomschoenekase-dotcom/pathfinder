# Security dependency upgrade, 2026-10-26

Next.js and eslint-config-next are pinned to 15.5.28, Sentry packages to 10.75.2,
Zod to 4.6.6, and the fast-uri override to 3.1.9. No advisory is ignored.

Zod now uses the patched v4 parser, including early upper-bound checks for
arrays, maps and sets. The repository does not route validation through v3.
Explicit string record keys and partial enum records preserve the old accepted
inputs. Object defaults use prefault so their nested fields still get parsed.
The operator catalog uses the supported JSON Schema converter instead of v3
private internals. Its independent required-key checks remain enabled.

The pnpm patch in patches/zod@4.6.6.patch preserves the existing UTF-16 string
length contract in both interpreted and compiled validation. Without it, a
5,001-code-unit value containing a surrogate pair passes the existing 5,000
limit. The patch changes only length measurement; the new collection size
gates remain intact. The bounded-parsing-security test checks early array
rejection and UTF-16 boundaries in both parsing paths. Remove this compatibility
patch only with an explicitly reviewed field-length contract migration.

The canary build continues to replace every registered server secret and scan
all browser-deliverable files. Its synthetic PostgreSQL and Redis URLs use
loopback port 1 rather than a potentially running local service.
The fact-applicability visual tests use the configured dashboard origin, just
as the other visual fixtures do; their assertions and viewport coverage remain.
