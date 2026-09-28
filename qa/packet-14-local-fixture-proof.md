# Packet 14 local fixture proof map

This map connects the checked-in fixture contracts to the packet proofs they support. The repository is pinned to R1.1 `512df5d4329ac4842b1c5e3cb9ea6cd92710d324`; Packet 12 R2 surfaces are not present in this baseline. Tests listed here are not all executed merely by being listed. The provider suite passed 10/10, the fixture-auth suite passed 8/8, the disposable stack reached ready, and one combined browser run passed all three R1.1 journeys with the R2 admin case explicitly skipped. The exact R2 and three-consecutive-run gates remain open.

The R1.1 disposable stack replayed 252 migrations and the synthetic seed. The live host network proof denied a synthetic non-loopback request before socket creation and found zero established non-loopback connections in five attributed processes at its audit point; the raw Docker proxy egress boundary remains partial. The read-only phase report is at the Packet 14 owner path `proof/r1-phase-report-20260928.txt` and is summarized in `qa/packet-14-m5-evidence-checklist.md`.

The seed also renders three deterministic, read-back-verified QR SVGs under the Packet 14 owner `data/venue-qrs`, each encoding its invented venue's loopback `/chat?source=qr` URL. The product QR-kit route has separate release and HTTPS gates and is not claimed by those files.

## Provider and progressive output

Owned implementation and tests:

- `scripts/local-provider-stub.mjs` accepts only local Responses and embeddings contracts, listens on IPv4 loopback port `56344`, serves `/health`, and rejects unknown routes/models. It uses no upstream provider or credential. The first-token wait and later token cadence are independently tunable.
- `scripts/local-provider-stub.test.mjs` checks nonstream Responses JSON, Responses SSE terminal usage, venue stability across turns, indexed base64 little-endian float32 embeddings with 1,536 dimensions, fail-closed routes/models/formats, and the installed OpenAI SDK's SSE parsing and embedding decoding.
- A per-venue streaming test checks the three invented venues (science museum, small collection museum, nature centre): every complete answer is over 40 words, contains at least three `response.output_text.delta` events, and equals the terminal response text. The fixture facts are explicitly labelled invented.

Executed command and result in this worktree:

```text
node --test scripts/local-provider-stub.test.mjs
10 passed, 0 failed
```

The `>40 words / >=3 delta events` result proves the provider fixture has enough staged material for a progressive-output exercise. It does not prove that the browser rendered three separate paint steps, that the full guide used the correct venue retrieval, or that any live model answer is factually correct.

## Fixture authentication and bundle refusal

The checked-in proof surfaces are:

- `scripts/local-fixture-auth-config.test.mjs`: probes both app Next configs for the local development aliases (edge, node, browser), absence of those aliases in an ordinary development config, and refusal when fixture auth is enabled with production `NODE_ENV`.
- `packages/auth/src/local-fixture/guard.test.ts` and `edge.test.ts`: role/tenant and edge fixture behavior tests.
- `scripts/verify-local-fixture-auth-bundle.mjs`: scans fresh JavaScript output directories from both apps for fixture-auth markers.
- `apps/web/next.config.ts` and `apps/dashboard/next.config.ts`: fail production config/build when `TORCHIKO_LOCAL_FIXTURE_AUTH=1`; fixture auth aliases are enabled only for development.

The refusal and unit suites passed. Both apps built normally with the fixture flag off, a clean child environment, mocked local fonts, and the installed egress guard. The scanner found no fixture markers in 10,697 generated JavaScript and manifest files; both flag-on production config loads refused as expected. The exact commands, output location, and limits are recorded in `qa/packet-14-m3-production-proof.md`. These checks must be repeated at the integrated R2 exact head.

## Browser journey evidence contract

`apps/dashboard/tests/visual/local-full-stack.spec.ts` is the source for the M4 artifacts. It uses the web listener at `127.0.0.1:56345` and dashboard listener at `localhost:56346` (Next development redirects to that dashboard hostname), blocks other HTTP(S) origins, and includes:

1. Visitor chat: two streamed turns against the synthetic science museum at 390×844 and 1440×900. Per-turn JSON attachments record click-to-two-visible-words time and `/api/chat-stream` NDJSON event types. Screenshots are saved for each width.
2. Tenant A: fixture sign-in, saved forest appearance, preview route verification, screenshot and sign-out at both widths.
3. Tenant isolation: tenant B has only its own seeded venue options; direct `venue.getById` access to tenant A's venue must return 404 without exposing its name. Screenshots are saved at both widths.
4. Admin: intended Good fit and visitor speed readout path, but explicitly skipped until `TORCHIKO_PACKET12_R2_SHA` is provided.

The spec's first-visible measurement is a browser text-visibility time. Its instrumented fetch records NDJSON bytes as the UI consumes the stream, and animation-frame samples record distinct painted word counts; the SQL report separately records server phase times. The configured 390×844 Playwright project owns both viewport sizes; the other project copies intentionally skip the scenarios.

## Proof boundaries

- Passing local fixture auth tests demonstrates the guarded development alias and synthetic identities, not a real Clerk session or permission to use production authentication.
- Passing the tenant test demonstrates the seeded local query boundary, not a production tenant audit or Packet 7's live CRM view.
- Passing the visitor scenario demonstrates loopback fixture transport and browser rendering only. It cannot satisfy Packet 2 hosted latency or factual-quality acceptance.
- Packet 7's admin screen proof stays pending until exact Packet 12 R2 integration supplies the screen and visitor-speed route; skipped admin assertions are not a pass.
- The separate client-portal redesign handoff says its upload, Help, billing and preview journeys were previously exercised against an in-memory fixture only. Packet 14's R1.1 M4 coverage establishes a disposable database save and public guide appearance persistence for one synthetic tenant. It does not yet establish the R2 portal upload/storage/scanning flow, real Clerk or Stripe behavior, or production frame policy.
