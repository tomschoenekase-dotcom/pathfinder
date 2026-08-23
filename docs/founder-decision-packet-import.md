# Founder decision packet intake

Torchiko can admit a bounded founder-authored decision packet into Company Brain through
`admin.applyFounderDecisionPacket`.

The checked-in August 22 packet is `docs/founder-decision-packet-2026-08-22.json`. It contains only
firm current direction. Intentionally unresolved prices, thresholds, legal terms, production rollout
details, customer promises, and live-money authority are not converted into decisions.

## Safety contract

- Only an authenticated human platform administrator can execute the procedure.
- One packet contains at most 50 uniquely keyed decisions and carries an exact source reference and
  effective time.
- The action runs as one serializable transaction. An exact packet replay is a no-op.
- A newer packet with the same stable decision key creates a new current record and preserves the
  old record as superseded history in both Company Knowledge and Company Decision lineage.
- A packet cannot supersede a decision with an equal or later effective time.
- Multiple current records for one key fail closed for human reconciliation.
- Each applied decision receives strict human audit evidence.
- The action creates no provider call, message, billing effect, deployment, customer mutation, legal
  commitment, or execution authority beyond the decision text itself.

The file is not applied automatically during migration or deployment. That prevents a code rollout
from silently changing operational policy. A human platform administrator must deliberately submit
the exact validated packet to the admin procedure in the intended environment.
