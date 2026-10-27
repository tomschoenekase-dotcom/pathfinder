---
name: torchiko-venue-authoring
description: Build, fix or customize a Torchiko venue guide through the Torchiko operator MCP (venue package JSON, places, topics, hours, events, voice, visitor chat model). Use when asked to create a venue, import or correct venue records, change a guide's tone or length, or switch a venue's AI model.
---

# Torchiko venue authoring

The contract lives in the server, not in this skill, so it always matches what the server accepts.

1. Call `operator.get_manual` with `{"section": "venue-authoring"}`. Read `text` (workflow, where
   information belongs, unknown and seasonal facts, voice, examples) and use `schema` (the
   schemaVersion 3 package JSON Schema generated from the live validator) to build the package.
2. Keep a private source ledger outside the package. Never invent a fact to fill a field;
   visitor-facing record text can reach visitors, so keep research notes outside those fields.
3. `venues.check_package` until `ready` is true. Fix every `errors` entry using its `fix` and
   `example`, every `guideQuality` finding and `DUPLICATE_IN_PACKAGE`; resolve or justify every
   `authoring` finding; follow each `venueSetup` finding's guidance for appearance or venue settings.
4. `venues.propose_package_import` once, with a new UUID `operationId`. `APPLIED` changed the
   records. An already-published guide changes immediately; drafts stay hidden until an authorized
   `venues.propose_publish`. On any other failure, keep the
   same `operationId` and follow the manual's import recovery before sending anything else.
5. `venues.get_guest_link` must say `usable`; then ask the guide the manual's self-test questions.

Voice: `venues.propose_update` (`tonePreset`, `responseDepth`, `aiGuideName`, `greeting`,
`aiGuideNotes`). Never put facts in voice notes.

Model: `venues.get_guest_model`, then match the owner's words against each choice's `alsoKnownAs`
and `model`. If nothing matches, say the model is not available. `venues.propose_guest_model` and
`venues.propose_guest_model_reset` change one venue only and return a before/after receipt.

## Distribution

Any MCP client finds this workflow without the skill: the server's `initialize` instructions and
the `operator.get_manual` and `venues.check_package` descriptions point to the same section. This
file only helps agents that load skills before connecting. To use it, copy the folder into that
agent's skills directory, for example `.agents/skills/` in a Codex workspace or `~/.claude/skills/`
for Claude Code. It is not served by the MCP and is not loaded from this repository automatically.
