# Golden Venue run report — 2026-08-19

Fixture: `golden-venue-riverside-aquarium-v1` (synthetic)

| Evidence                               | Status                       | Notes                                                                                                    |
| -------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| Fixture contract                       | VERIFIED                     | Static validator passed when recorded in the implementation report.                                      |
| Seed/reset safety                      | VERIFIED_STATIC              | Existing seed has explicit staging host/database confirmations; reset is disposable-database recreation. |
| Full lifecycle                         | NOT_RUN                      | Staging-changing seed/use was not authorized by this packet.                                             |
| Provider-backed chat/evaluation/report | UNVERIFIED_PROVIDER_DISABLED | No provider success was fabricated.                                                                      |
| Failure injection                      | NOT_RUN                      | Requires disposable runtime execution.                                                                   |

This report is intentionally truthful: it preserves the durable harness and distinguishes harness readiness from operational proof.
