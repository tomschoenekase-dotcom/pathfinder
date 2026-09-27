# Website guide installation

The current Distribution RC-1 website contract is in [Visitor distribution](distribution/README.md) and [website installation](distribution/website-installation.md). It covers the floating launcher, inline guide, exact venue origins, readiness probe, and host CSP.

This earlier staging preview document was replaced by the durable per-venue distribution contract. The legacy `data-pathfinder-venue` attribute and `EMBED_PREVIEW_ENABLED` alias remain supported. No hosted environment was changed by RC-1.

Before a staging rollout, the existing `pnpm verify:staging-widget` exact-revision admission check remains required; it does not replace third-party browser proof.
