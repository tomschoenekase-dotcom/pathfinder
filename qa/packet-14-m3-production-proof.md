# Packet 14 M3 production exclusion proof (local interim)

2026-09-28 on the Packet 14 R1.1 worktree, before R2 publication. The final exact-head CI run must repeat this proof after integration. No real service key was supplied; a clean allowlisted child environment used `NODE_ENV=production`, the task-local egress preload, mocked local fonts, and app-relative `NEXT_DIST_DIR=.next-p14-prod`.

| Check                                                                             | Observed result                                                                                                                   |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Normal web `next build`, fixture flag absent                                      | Pass: compiled, typechecked, 15 static pages, traced output.                                                                      |
| Normal dashboard `next build`, fixture flag absent                                | Pass: compiled, typechecked, 7 static pages, traced output without a Clerk key.                                                   |
| `node scripts/verify-local-fixture-auth-bundle.mjs <web-build> <dashboard-build>` | Pass: fixture auth absent from 10,697 production JavaScript and manifest files; rerun after moving outputs to owner/proof passed. |
| Flag-on web and dashboard production config loads                                 | Both exited nonzero at config load with `Local fixture authentication is forbidden outside development`.                          |

Successful build trees are preserved outside resettable data at `C:/Users/tomsc/MachineWorkspaces/torchiko/20260928-local-full-stack/proof/prod-web-success` and `.../proof/prod-dashboard-success`. The first web attempt used a dist directory outside the app and failed Next's generated-type resolution; it is not counted as proof. Next-generated source diffs from successful builds were reviewed and restored. No local auth browser journey or exact-head CI is implied by these production checks.
