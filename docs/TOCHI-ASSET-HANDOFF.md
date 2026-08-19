# Tochi Asset Pack Handoff

Status: development placeholder contract
Character ID: `tochi`
Current pack: `tochi-dev-v0` / `0-development`
Final art approved: **No**

This document is the exact handoff contract for replacing the temporary Tochi development assets. The final design may use layered SVG, a single static image, or a future renderer adapter such as Rive/Lottie. The product, settings, chat, controller, and character ID must not need redesign when the approved pack arrives.

## What the design handoff must contain

Minimum static pack:

```text
TOCHI_ASSET_PACK/
  manifest.json
  preview.svg | preview.webp | preview.avif
  fallback.svg | fallback.webp | fallback.avif
```

Preferred initial layered SVG pack:

```text
TOCHI_ASSET_PACK/
  manifest.json
  preview.svg
  fallback.svg
  body.svg
  eyes.svg
  embers.svg
  glow.svg        # optional
  shadow.svg      # optional
```

Optional future richer pack:

```text
TOCHI_ASSET_PACK/
  manifest.json
  preview.webp
  fallback.svg
  character.riv | character.lottie.json | scene.glb
  poster.webp
  voice-profile.json   # metadata only; does not enable voice
```

Do not include source PSD/AI/Figma files in the runtime directory. Store editable design sources in the approved design archive and export only reviewed web assets into the pack.

## Manifest identity

The character definition keeps the stable ID `tochi`. Every art delivery gets a new immutable asset-pack ID/version, for example:

```json
{
  "schemaVersion": 1,
  "id": "tochi-brand-v1",
  "version": "1.0.0",
  "characterId": "tochi",
  "renderer": "layered-svg-v1",
  "artStatus": "approved",
  "publishable": true
}
```

Never overwrite a previously approved version in place. Preview/publication records pin the pack ID and version so an approved visitor preview cannot silently change appearance.

## Supported initial formats

| Purpose                 | Preferred        | Also accepted           | Notes                                                                                         |
| ----------------------- | ---------------- | ----------------------- | --------------------------------------------------------------------------------------------- |
| Layer                   | SVG              | —                       | Local reviewed file, rendered as an image/resource rather than arbitrary inline tenant markup |
| Preview                 | WebP or SVG      | AVIF, PNG               | Selection and admin preview; keep transparent background                                      |
| Static fallback         | SVG or WebP      | AVIF, PNG               | Mandatory and visually complete by itself                                                     |
| Reduced-motion fallback | SVG or WebP      | same as static fallback | Mandatory reference; may reuse static fallback                                                |
| Future animation        | New adapter only | Rive/Lottie/GLB         | Requires measured bundle/runtime budget and static fallback                                   |

Unsupported without a new reviewed adapter:

- FBX;
- executable scripts;
- remote URLs;
- HTML;
- CSS supplied inside tenant content;
- video as the only fallback;
- SVG with scripts, foreign objects, external references, or remote fonts.

## Canvas and coordinate system

The pack manifest is the authority. Recommended neutral working canvas:

```text
viewBox: 0 0 240 300
origin: 120, 270
safe bounds: x 20..220, y 16..284
eye anchor: 120, 132
ember anchor: 120, 250
```

These values are recommendations, not permanent character anatomy. A final pack may use a different canvas if it declares all dimensions/anchors and passes the Character Lab.

Rules:

- Every layer in one pack uses the same view box and origin.
- Artwork stays within declared safe bounds at maximum animation intensity.
- The visual center must remain stable when switching semantic states.
- Allow transparent padding for lean, scale, eye movement, glow, and embers.
- Do not make the renderer infer eye or ember locations from pixels.
- Preview and fallback assets use the same recognizable silhouette and colors as the layers.

## Layer conventions

### Body

- Complete primary silhouette.
- No dependency on hands, legs, or a mouth.
- Must remain recognizable at approximately 28–36 CSS pixels.
- Avoid fine internal lines that disappear on mobile.

### Eyes

- Transparent canvas aligned to the body.
- Neutral position at the declared eye anchor.
- Provide enough internal transparent margin for the declared look-at range.
- The system moves/clamps this layer; the page does not know pupil geometry.

### Embers

- Transparent canvas aligned to the body.
- A small number of restrained elements.
- Must look acceptable when fully static.
- Motion must not contain essential status information.

### Glow/shadow

- Optional.
- Must be safe to omit on low-power/reduced/static paths.
- Do not rely on blur filters so large that they exceed safe bounds or cause mobile GPU churn.

## Semantic states

The character system recognizes these state names exactly:

```text
idle
attention
listening
thinking
speaking
success
processing
uploadReceiving
uploadComplete
question
handoff
error
sleeping
minimized
```

Not every pack needs unique art for every state. The manifest must declare mappings and fallbacks. The product requests semantic states; it never references animation filenames directly.

Expected design intent:

| State             | Functional intent                      | Optional visual language                            |
| ----------------- | -------------------------------------- | --------------------------------------------------- |
| `idle`            | Present, calm                          | Slow subtle deformation/embers                      |
| `attention`       | Conversation opened/new relevant event | Small lift, brightening, eye focus                  |
| `listening`       | User composing/speaking                | Lean/focus toward user                              |
| `thinking`        | Awaiting an answer                     | Deliberate inner motion or orbit, not fake progress |
| `speaking`        | Real streaming/voice signal only       | Audio/stream-responsive intensity in future         |
| `success`         | Confirmed successful action/result     | Brief settle/brighten                               |
| `processing`      | Real work in progress                  | Calm directional movement                           |
| `uploadReceiving` | Bytes actively arriving                | Inward motion, no fabricated percentage             |
| `uploadComplete`  | Upload verified/accepted               | Brief confirmed reaction                            |
| `question`        | Client attention required              | Focus/tilt, not alarm                               |
| `handoff`         | Confirmed request sent to team         | Outward/transfer cue                                |
| `error`           | Recoverable failure                    | Brief dim/tilt; textual error remains primary       |
| `sleeping`        | Long inactivity                        | Static/very low motion                              |
| `minimized`       | Compact affordance                     | Small recognizable static/low-motion form           |

Do not encode success/error only through color. Meaningful state always has text outside the character.

## State fallback requirements

The manifest must resolve every requested state through this chain:

```text
requested state
  -> explicit manifest fallback state
  -> idle
  -> pack static fallback
  -> Torchiko brand fallback
  -> no character, with the product still usable
```

Fallback mappings must be acyclic. The validator rejects loops and a pack without a static and reduced-motion fallback.

## Light and dark backgrounds

The handoff must include either:

- one pack proven to work on the declared light and dark contexts; or
- explicit light/dark asset variants in the manifest.

Test backgrounds:

- warm off-white `#fffdf7`;
- light portal surface `#f8fafb`;
- deep navy `#0f2a4a`;
- transparent/checkerboard diagnostic background.

Eyes, silhouette, and focus details must retain sufficient visible contrast. Decorative art does not replace text contrast requirements.

## Required preview assets

`preview` is used for selection/admin review and should:

- be a neutral, recognizable pose;
- include no baked marketing copy;
- have a transparent background;
- remain readable around 80–160 CSS pixels;
- match the approved fallback and body silhouette;
- avoid animation-specific cropping.

`fallback` is used whenever optional rendering fails or motion is reduced and must:

- be visually complete without other layers;
- work at compact and stage sizes;
- contain no “loading” implication;
- contain no text;
- be under the documented byte budget.

## Naming

- Lowercase kebab-case filenames.
- No spaces, timestamps, “final-final”, or source-application suffixes.
- Stable pack folder by immutable version.
- State names use the exact camelCase semantic identifiers above.
- Layer IDs use functional names (`body`, `eyes`, `embers`, `glow`, `shadow`).

Example:

```text
assets/characters/tochi/v1/
  manifest.json
  tochi-preview.webp
  tochi-fallback.svg
  tochi-body.svg
  tochi-eyes.svg
  tochi-embers.svg
```

## Byte and runtime targets

Initial target budgets for an approved SVG/static pack:

- manifest: under 16 KB;
- each SVG layer: under 40 KB;
- total layered pack excluding previews: under 160 KB compressed source;
- preview: under 100 KB;
- static fallback: under 60 KB;
- no external font, script, network, or texture dependency.

If final art exceeds these targets, measure the actual user benefit and revise the adapter/budget explicitly. Classic Venue Bot must not download the character pack.

## Installation workflow

1. Create a new immutable folder under `assets/characters/tochi/`.
2. Copy exported runtime assets only.
3. Complete the versioned manifest with files, hashes/bytes, dimensions, anchors, states, fallbacks, themes, and approval metadata.
4. Run the asset validator.
5. Run the synchronization script that copies verified assets into both dashboard and web public roots.
6. Confirm copied hashes match the canonical source.
7. Open the protected Character Lab.
8. Inspect every state, context, viewport, background, look-at extreme, intensity extreme,
   compact/standard/future-voice presentation size, reduced-motion path, and simulated missing asset.
9. Run unit/type/lint/build gates.
10. Run real-browser desktop/tablet/mobile visual QA.
11. Test Classic chat and prove no character asset is requested.
12. Create an exact client preview that pins the new pack version.
13. Only then change the registry’s approved production pack reference behind the rollout flag.

Run the exact repository commands from the workspace root:

```powershell
pnpm characters:sync
pnpm characters:verify
pnpm --filter @pathfinder/contracts test
pnpm --filter @pathfinder/ui test
pnpm --filter @pathfinder/dashboard test
pnpm --filter @pathfinder/web test
pnpm typecheck
pnpm lint
pnpm build
```

The synchronization command copies only a successfully validated canonical pack into both app public roots. Verification then rejects byte drift rather than silently rewriting it. The full evidence record is repeated in `docs/TOCHI-QA.md`.

With `CHARACTER_REGISTRY_ENABLED=true`, the protected platform-admin lab accepts shareable query
state such as:

```text
/admin/character-lab?state=thinking&context=venue-text-chat&motion=reduced&background=ink&viewport=mobile&size=compact
/admin/character-lab?state=speaking&context=venue-voice-chat&motion=full&background=mist&viewport=desktop&size=stage
```

The second URL previews layout capacity only. It does not enable or claim voice transport.

## Character Lab acceptance checklist

- [ ] Manifest validation has no errors or warnings requiring review.
- [ ] “Temporary development assets” is absent only for approved art.
- [ ] All fourteen state requests resolve without a fallback cycle.
- [ ] Every implemented state is intentional and not random decoration.
- [ ] Static and reduced-motion modes contain all usable content.
- [ ] Light, dark, branded, and transparent backgrounds work.
- [ ] Compact client-helper and active mobile chat sizes are recognizable.
- [ ] Active mobile text chat keeps the conversation dominant.
- [ ] Future voice-stage layout can render without implying voice availability.
- [ ] Look-at is clamped and never separates eyes from the silhouette.
- [ ] Maximum intensity stays within safe bounds.
- [ ] Simulated layer failure falls back without breaking surrounding UI.
- [ ] Hidden/offscreen animation pauses and resumes safely.
- [ ] No console errors, broken resources, overflow, or inaccessible controls.

## Final design approval information

The final handoff should include, outside the runtime manifest:

- approving designer/owner;
- approval date;
- source archive location;
- usage/license statement;
- brand color references;
- intended personality notes;
- prohibited distortions/uses;
- any required credit;
- accessibility review notes;
- known rendering limitations.

Do not put private credentials, personal data, or an unrestricted source link in the runtime manifest.

## Rollback

Because pack versions are immutable, rollback means selecting the previously approved pack version and republishing through the normal reviewed configuration path. Do not delete or overwrite the broken version during incident response; retain it for evidence until normal retention policy permits removal.

## What must not change during final asset replacement

- character ID `tochi`;
- Client Tochi versus public Venue Bot trust boundary;
- Classic default;
- semantic controller API;
- the fourteen state names;
- fallback order;
- client confirmation for support handoff;
- chat transport/retry/persistence;
- tenant isolation;
- manual Venue Bot settings;
- reduced-motion and static paths.

If final art requires changing those product contracts, it is not an asset swap and needs a separate architecture review.
