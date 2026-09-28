# Make a venue character

This is the local readiness path for turning an approved venue concept into a reviewed Torchiko character candidate. It describes the current `@pathfinder/character-factory` core; the core is not an image-generation service and does not publish characters.

## Inputs Torchiko needs

Collect these from the venue before production work starts:

- A written character brief: name, role, audience, personality, and the interaction contexts where it should appear.
- A short list of identity traits that must stay fixed (for example silhouette, colors, face, and accessories), plus traits the artist may vary.
- Rights evidence for every supplied sketch, logo, photo, font, and reference. Record the creator, license or permission, attribution, source URL/revision, and approved use. A venue brief alone does not grant rights to reference art.
- Brand colors, accessibility constraints, tone and safety instructions, target sizes/backgrounds, and requested idle/listening/speaking/reaction behavior.
- A named venue owner for factual and brand review, and a Torchiko reviewer for safety, provenance, and technical acceptance.

Do not send confidential guest data or personal information as character input. The sample below uses none.

## Steps, tools, and models

1. **Intake and rights review.** Save the brief and source inventory in the authorized project record. A human confirms the source may be used and the requested identity is appropriate for the venue.
2. **Create the visual master.** A human illustrator or approved design tool creates original art or adapts licensed art. A vector editor such as Figma or Inkscape can produce a clean SVG master. Preserve editable source and record the exact revision and rights. Avoid active SVG features, embedded scripts, remote images, and external references.
3. **Prepare rig slots.** A designer manually separates the body and face (and other rig-required parts) into named layers, establishes pivots/anchors, and creates a static fallback. Today, the factory inspects a normalized 72×72 SVG and checks its declared slots and provenance; it does not segment art, infer pivots, or rasterize layers for you.
4. **Run the local candidate workflow.** Use `CharacterFactoryEngine` with a `MemoryCharacterFactoryStore`: import/create, inspect compatibility, preview a declared state, validate identity and source integrity, and export a local artifact. The package tests exercise this API. Keep the artifact in a controlled local workspace until the review gates below pass.
5. **Prepare and verify a runtime pack if animation is requested.** Supply the normalized raster/vector assets, explicit family-rig metadata, state fallbacks, anchors, dimensions, hashes, and static/reduced-motion fallbacks. `createCharacterBundle` and `readCharacterRuntimePack` verify the declared pack against exact asset bytes. The factory will not derive this pack from the master image.
6. **Human review and venue acceptance.** The illustrator checks the art and each prepared state. The venue owner checks identity, brand, facts, and tone. Torchiko checks rights records, safe assets, provenance, bundle integrity, accessibility/reduced motion, and the venue mapping. Resolve findings and export a new version after changes.
7. **Enable for one venue.** Only after those approvals, an authorized platform operator associates the reviewed character version with the intended venue through the existing venue-character registry/feature controls (`venueCharacterMode`, `characterRegistry`, and `tochiVenueCharacter`). Verify the venue ID and fallback behavior in the approved environment. This runbook does not toggle those controls or specify hosted settings.

### Tools and models

The M6 sample used the existing TypeScript factory engine, its in-memory store, the deterministic compatibility checks, and Vitest. It used no external provider, generative model, database, hosted service, or real venue material. For production art, use a human illustrator and a vector editor, or another explicitly approved tool with documented terms and rights. No image or animation model is required by the current factory API; if a model is later proposed, review its data handling, output rights, and venue approval before use.

## Review gates

- **Rights:** documented permission/license and required attribution for every non-original input.
- **Identity:** venue approves the concept, protected traits, and final master.
- **Safety and technical:** no active/remote SVG content; provenance hashes and byte length match; rig slots and state coverage validate; static and reduced-motion fallbacks work.
- **Animation:** every state and pivot is reviewed in the actual renderer; unsupported states fall back cleanly. A metadata preview is not a rendered-art review.
- **Enablement:** an authorized operator verifies the approved pack/version is mapped to the correct venue and that other venues cannot select it.

## Effort and time estimate

Planning estimate for one simple, original character, assuming the venue returns a complete brief and owns or has licensed its references:

- Intake and rights check: 30–60 minutes.
- One static concept and one venue revision: 2–4 hours of illustration/design work.
- Slot cleanup, fallback, and a small set of reviewed motion states: 2–5 hours, depending on anatomy and renderer readiness.
- Factory checks, accessibility review, venue sign-off, and controlled enablement: 1–2 hours.

Plan about one working day for a simple character and additional review time for custom anatomy, more states, or unclear rights. These are estimates, not measured service commitments. The M6 synthetic sample took only the automated local engine path; it did not measure production art labor.

## Animation supported today

The factory recognizes semantic rig families (`morph-v1`, `compact-creature-v1`, and `humanoid-v1`) and states including idle, attention, listening, thinking, speaking, happy, sad, success, error, and reaction. Rig definitions declare controls such as breathing, focus, speech energy, stretch, wing lift, and arm lift. The engine's `preview` action returns the chosen state and rig metadata; it does not render animation frames.

An imported master is quarantined source. A candidate cannot become a reviewed runtime character merely because compatibility passes. Layer segmentation, raster normalization, pivots, interpolation/timing, polished state art, runtime bundle creation, and visual review require explicit prepared assets and a renderer check. Static fallback and reduced-motion assets must be included in an animation-capable runtime pack. The Asty proof does not claim any animation-ready output.

## Local Asty proof

The local proof invents a friendly asteroid named Asty as a tiny original SVG, then runs create/import, inspect, speaking-state preview, validate, and local export against an in-memory store. It has no real venue, external artwork, provider/model call, persistence, registry mutation, or publish step. The exact command, commit, test count, and outcome are recorded in the task QA log at `C:\Users\tomsc\MachineWorkspaces\torchiko\20260928-voice-characters\qa\character\asty-pipeline.md`.
