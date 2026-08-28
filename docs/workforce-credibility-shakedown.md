# Workforce credibility shakedown

Status: provider-dark disposable proof implemented. Hosted bridge connectivity and provider-backed
work remain separately gated.

`pnpm test:agent-bridge:disposable` starts isolated PostgreSQL, Redis, MinIO, and ClamAV resources,
applies the complete reviewed migration lineage, exercises the authenticated HTTP bridge through
real database state, and verifies that every exact disposable resource is absent afterward.

The workforce scenario registers heterogeneous researcher, venue-builder, and analyst workers,
including two independent researcher instances. Four system-initiated runs are claimed
concurrently. Each run declares required worker roles and capabilities in its immutable scope
snapshot, and the bridge skips incompatible work. A bounded candidate scan also continues after a
concurrent claimant wins an earlier task.

The same scenario expires one researcher's execution lease and proves takeover by the second
researcher. The database permits only that fenced `RUNNING`-to-`RUNNING` ownership transfer: the old
lease must already be expired, the attempt must increment exactly once, and the new lease token and
bridge owner must both change. The stale worker cannot settle the run, and a repeated completion by
the current worker is rejected. Exactly one completion event remains.

All completed runs retain initiating actor, agent identity, tenant and venue scope, requested
operation, provider and model, exact fixed-point cost status, durable artifacts, timestamps, and
terminal state. The system-initiated workflow uses no approval or founder-question shortcut; it
proves execution continuity, not broader authority. Customer communication, publication, billing,
deployment, production, destructive changes, and provider spend remain governed by their existing
independent permission and approval boundaries.

This proof does not claim a live subscription bridge, live provider quality, distributed load
capacity, or production readiness. Those require an explicitly admitted hosted worker and separate
provider-backed staging evidence.
