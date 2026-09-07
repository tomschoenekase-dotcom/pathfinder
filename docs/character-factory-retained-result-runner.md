# Complete a named character request

`pnpm --filter @pathfinder/workers character:complete-request` submits an already prepared result for one existing factory request. An authorized agent supplies the result and, when applicable, an already retained character bundle. The runner claims that exact request, renews its lease, and calls canonical completion. It does not generate artwork, discover queued work, invoke a model, upload artifact bytes, or activate a character.

Use a deployed bridge with its HTTP rollout gate enabled and an operator-issued credential accepted by the character executor boundary. Keep the credential in the process environment; never include it in the result or repository.

| Environment variable                                 | Value                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------- |
| `TORCHIKO_AGENT_BRIDGE_URL`                          | Exact tenant/venue bridge URL                                       |
| `TORCHIKO_AGENT_BRIDGE_SECRET`                       | Issued machine credential                                           |
| `TORCHIKO_AGENT_BRIDGE_VENUE_ID`                     | Exact venue ID                                                      |
| `TORCHIKO_CHARACTER_FACTORY_REQUEST_ID`              | Existing factory request ID                                         |
| `TORCHIKO_CHARACTER_FACTORY_RESULT_JSON`             | Bounded JSON object describing the prepared result                  |
| `TORCHIKO_CHARACTER_FACTORY_SPEC_JSON`               | Optional complete character spec                                    |
| `TORCHIKO_CHARACTER_FACTORY_ARTIFACT_REFERENCE_JSON` | Optional retained bundle reference; required together with the spec |

The spec and retained reference must identify the same character/version. Canonical completion checks the frozen job action/revision and verifies retained artifact bytes before persisting character changes. This runner's input checks do not replace those server checks.

The CLI has a 60-second deadline and stops on interrupt. A request it cannot claim receives no completion write. Once completion has been attempted, a lost response or malformed success response is indeterminate: the runner does not send a failure write. Read the exact request through the existing character job read interface before deciding whether to retry. A later invocation returning `not-claimed` is not proof of successful completion; inspect its retained status.

The retained PostgreSQL proof in `docs/evidence/character-executor-native-postgres-2026-09-07.json` covers an INSPECT job, completed-job replay, and cancellation. Its HTTP core runs in-process with fixture credential verification and registry adapters; it does not prove deployed networking, model generation, or artifact storage.
