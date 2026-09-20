# Bot Maker: Tochi Production Start

This is the shortest honest start path for producing Tochi through the shared character system.

## What is ready

- The founder-approved visual board is bound by filename, byte length, and SHA-256 in `assets/characters/tochi/production-brief-v1.json`.
- Tochi's locked identity, requested spark correction, forbidden redesigns, expression evidence, initial motion target, provider capability requirements, and human review gates are machine-readable.
- The existing factory retains imported candidates, validates and exports portable bundles, fences revisions, supports exact candidate review, and keeps publication fail-closed.
- Export verification preserves the runtime pack needed to create the server-owned publication receipt.

## What is not automatic

The factory does not invoke an image model. Candidate artwork must first be created with an authorized image tool that can actually receive the approved board, then imported through `CREATE_FROM_IMPORT`. A text prompt containing the board's filename is not visual conditioning. Current family rigs are `rigid-source`; they do not yet prove Tochi's required deforming flame contour.

For founder-side creation, prefer Codex using Tom's ChatGPT account and included plan allowance. ChatGPT subscription usage is separate from OpenAI API billing: the subscription is not a server API key and does not power visitor chatbots. The Bot Maker review screen itself makes no model request.

## Agent procedure

1. Read `assets/characters/tochi/production-brief-v1.json` as the identity and capability contract.
2. Prepare the exact approved board and brief:

   ```powershell
   pnpm bot-maker:tochi-prepare --reference "C:\Users\tomsc\Downloads\AwesomeVault\95 AI Staging\TorchikoBotReferenceImages.png"
   ```

   Stop if the hash check fails.

3. Use a provider with real reference-image input and image generation. Record the provider/model and available settings. If reference input is unavailable, label the attempt text-only and do not present it as equivalent.
4. Generate a small bounded candidate set. Preserve every locked trait. The only requested default change is to remove or substantially reduce detached diamond-like sparks.
5. Retain each clean candidate and its provenance. Package the exact master and static fallback with the existing `createCharacterBundle` function as a candidate `.character.json` bundle. Keep the original master bytes unchanged. Import that bundle in **Control Room → Bot Maker**, with the exact tenant/venue scope, source provenance, review brief and rationale. The authenticated importer uses the existing `CREATE_FROM_IMPORT` path and submits the exact artifact for founder review; it does not approve or publish it. Keep the same request identity for a retry of an unchanged upload. A different appearance is a new candidate, not an overwrite of an approved one.
6. Open **Control Room → Bot Maker** and show Tom the verified preview at a comparable size against the approved Tochi reference. **All good — prepare animation** approves only that exact appearance and queues a basic rigid-source animation/export job. It does not publish the character or claim fluid flame motion is complete.
7. Acceptance queues one exact `EXPORT` preparation request; it does not invoke a model or automatically run the explicit character executor. Record the resulting job identity and distinguish queued work from completed motion. Treat contour animation as the next engineering gate. The current `morph-v1` runtime contract is intentionally `rigid-source`; it can prove safe state choreography and fallbacks, but it cannot honestly export the required billow/flare/compress contour motion yet. Extend the shared renderer/runtime contract before calling this motion complete—do not create a private Tochi-only bypass.
8. After that shared capability exists, build the first motion proof: calm idle, attention/listening, thinking, speaking, success, error, and reduced/static fallback. Inspect face stability, silhouette, small-size readability, light/dark surfaces, transitions, interruption return-to-idle, and reduced motion. Whole-body bobbing is a fallback, not deformation proof.
9. Export an immutable animated runtime pack only after the new capability passes its contract and renderer tests. Until then, keep animation explicitly pending and do not mislabel a rigid-source export.
10. Keep the release non-publishable until Tom approves the exact static identity and later animation proof. Do not replace `tochi-dev-v0` in place.

## Canonical distinction

Tom approved founder draft 06's appearance in the Codex review conversation on 2026-09-19 (America/Chicago). Its PNG SHA-256 is `e4fd9b99ffd5da097b5db22b7c1dcee32f3b7ac801f2fe8b84bec35ae3133d9a`. The retained source is `tochi-founder-draft-06.png` in the vault's Tochi Founder Review staging packet. This approval covers that exact appearance, not animation or publication. Verify the hosted candidate against the master before recording the corresponding review decision. `tochi-dev-v0` remains a blue non-publishable engineering placeholder and must never be used as Tochi's visual identity source.
