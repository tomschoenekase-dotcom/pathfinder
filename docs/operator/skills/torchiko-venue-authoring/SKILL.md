---
name: torchiko-venue-authoring
description: Build, repair, check, import or test a Torchiko venue guide (venue package JSON, places, knowledge topics, hours, events, voice, visitor chat model) through the Torchiko operator MCP. Use when asked to research or create a venue package, fix a weak or stale guide, import or re-import venue records, check a package, test visitor answers, change a guide's tone or length, or switch a venue's AI model.
---

# Torchiko venue authoring

The contract lives in the server, not in this skill, so it always matches what the server
accepts. This skill is the order of work and the rules agents most often break.

## Start

1. Call `operator.get_manual` with `{"section": "venue-authoring"}`. Read `text` in full: the
   quality gates, where information belongs, unknown/seasonal/status rules, voice, examples. Use
   `schema` (generated from the live validator) to build the package. Without the MCP, read
   `docs/operator/venue-authoring.md` in the repository at the release you will import into.
2. Confirm the exact venue: official domain, city and state, and the target `venueId`. Two venues
   can share a name. Check whether another agent already owns this venue before starting.
3. Reuse existing research and packages for the venue. Repair them; do not restart.

## Build (gates 1 and 2)

- Keep a source ledger outside the package: each record's source URL, the date read, and the
  exact supporting sentence. Record each conflict and the decision.
- One visitor-named thing per record; its first sentence says what it is and where. Facts a
  visitor asks about a thing (location, hours, price, height) go on that thing's own record, not
  only in an overview.
- Every date has month, day and year. Date every status ("closed for the 2026 season after
  October 25, 2026"). Never "next year", "this fall", "currently" without a date.
- Records talk about the place, never about themselves or their sources ("covered here",
  "confirmed here", "its page says", "linked menus").
- Without a venue yet, check offline from a repository checkout:
  `pnpm venue:check <package.json> --official-domain <venue domain>` (same rules, no database).
- `venues.check_package` until `ready`. Fix every `errors`, `guideQuality` and
  `DUPLICATE_IN_PACKAGE`; fix or justify in writing every `authoring` finding; follow
  `venueSetup`. `ready` is gate 2 only. Re-run it on the day of import, because dated records
  expire.

## Import, test, demonstrate (gates 3 to 5)

Only with authorization for that venue.

- `venues.propose_package_import` once with a new UUID `operationId`. On an unclear outcome, keep
  the same `operationId` and follow the manual's import recovery. To correct an imported venue,
  use `venues.list_content` ids and v3 `update` operations, never a second `create`.
- Drafts stay hidden until an authorized `venues.propose_publish`. Never publish only to get past
  a gate.
- Ask at least 20 visitor-style questions (see the gate 4 list in the manual) and check each
  answer against the ledger. Then check the guest page at phone width and desktop.
- Report the highest gate with evidence. Blocked or unrun checks are reported as such, never as
  passes.

## Voice and model

Voice: `venues.propose_update` (`tonePreset`, `responseDepth`, `aiGuideName`, `greeting`,
`aiGuideNotes`). Never put facts in voice notes.

Model: `venues.get_guest_model`, then match the owner's words against each choice's `alsoKnownAs`
and `model`. If nothing matches, say the model is not available. `venues.propose_guest_model` and
`venues.propose_guest_model_reset` change one venue only and return a before/after receipt.

## Distribution

Any MCP client finds this workflow without the skill: the server's `initialize` instructions and
the `operator.get_manual` and `venues.check_package` descriptions point to the same section. This
file helps agents that load skills before connecting. Copy the folder into the agent's skills
directory (for example `.agents/skills/` in a Codex workspace or `~/.claude/skills/`).
