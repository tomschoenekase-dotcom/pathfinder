---
name: Feedback — Working approach
description: How Tom likes Claude to approach work on this project
type: feedback
---

**Use Codex for multi-phase implementation tasks.** Write a structured instruction file (like `docs/codex-backlog.md`) with numbered tasks, exact file paths, and acceptance criteria. Tom hands this to Codex and reports back with summaries. Claude then reviews Codex's output and fixes any issues.

**Why:** Tom goes away while Codex works. He wants to come back and have it done.

**Always verify Codex's work before saying it's clean.** Read the key files, run typecheck mentally, check for CLAUDE.md violations (missing writeAuditLog on admin mutations, wrong base procedure, etc.).

**Why:** Codex made several mistakes that needed fixing — missing audit log on triggerDigest, wrong module resolution in tsconfig, etc.

**Keep responses short and direct.** Tom doesn't need lengthy explanations. A table or bullet list beats paragraphs.

**Why:** Confirmed by Tom's communication style throughout the session.

**Don't deploy speculatively.** Tom manages Railway himself. Claude pushes code to GitHub, Tom triggers deploys and reports errors back.

**Why:** Railway interaction is manual. Claude can't access it.

**When Tom hits a deployment error, read the full error before suggesting a fix.** Several errors in this session required understanding the pnpm monorepo structure (symlinks, hoisting, workspace packages) before the right fix was obvious.

**Why:** Early fixes (tsc compile, separate runner stage) failed because the root cause wasn't fully understood first.
