# Bot Maker: Tochi Production Start

This is the shortest honest start path for producing Tochi through the shared character system.

## What is ready

- The founder-approved visual board is bound by filename, byte length, and SHA-256 in `assets/characters/tochi/production-brief-v1.json`.
- Tochi's locked identity, requested spark correction, forbidden redesigns, expression evidence, initial motion target, provider capability requirements, and human review gates are machine-readable.
- The existing factory retains imported candidates, validates and exports portable bundles, fences revisions, supports exact candidate review, and keeps publication fail-closed.
- Export verification preserves the runtime pack needed to create the server-owned publication receipt.

## Reusable baseline acceptance

Static import and founder acceptance are only the candidate boundary. The reusable all-bot baseline is ready when the accepted `EXPORT` request has been claimed by a credential with `characters:execute`, renewed once through the bridge, and completed against the exact tenant, venue, request ID, candidate revision, and verified artifact reference. The completion read-back must include the server-side export receipt and a verified `family-rig-v1` runtime pack; record the export job ID and receipt identity before treating the baseline as usable.

The shared baseline pack uses the selected built-in family (`morph-v1` for this candidate), `rigid-source` capability, a static fallback, and a reduced-motion fallback. Its directly supported public states are `idle`, `attention`, `listening`, `thinking`, `speaking`, `success`, and `error`; every other public `RuntimePackStateSchema` state (`processing`, `uploadReceiving`, `uploadComplete`, `question`, `handoff`, `sleeping`, and `minimized`) must resolve through an explicit fallback. The separate factory authoring grammar has ten states and includes `happy`, `sad`, and `reaction`; those names are not public runtime-pack states. The exporter must use the public vocabulary, while the existing adapter provides normalized whole-image layers and runtime state control. This proves reusable state choreography and safe fallback behavior. It does not prove deforming flame contours, fluid billow/flare/compress motion, a wordmark, or the later consumer website redesign.

### Exact remaining steps after import and queued `EXPORT`

1. Preserve the accepted candidate's exact `EXPORT` job ID and artifact fingerprint. Do not resubmit with a new request ID.
2. Prepare the shared runtime pack from the exact stored master/static fallback bytes. Its asset digests, dimensions, character ID/version, source SHA, family, fallbacks, state list, and context list must pass `CharacterRuntimePackSchema`; do not alter the approved appearance.
3. Upload or retain that exact pack through the executor's approved artifact-upload lifecycle, then run `apps/workers/src/scripts/character-factory-executor.ts` with the exact request ID, exported spec, and verified artifact reference. The executor is provider-dark and does not invoke an image model.
4. Read back the succeeded job and verified export receipt. Check every shared state and its fallback at representative size, including reduced motion and interruption-to-idle, then retain the bounded proof with the job and receipt IDs.
5. Keep publication disabled. A later shared runtime/renderer capability review is required before claiming fluid flame motion or moving beyond the reusable baseline into bespoke consumer-site poses, animation, or wordmark work.

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
