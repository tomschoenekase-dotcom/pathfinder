---
name: torchiko-venue-authoring
description: Build, repair, check, import or test a Torchiko venue guide (venue package JSON, places, knowledge topics, hours, events, voice, visitor chat model) through the Torchiko operator MCP. Use when asked to research or create a venue package, fix a weak or stale guide, import or re-import venue records, check a package, test visitor answers, change a guide's tone or length, or switch a venue's AI model.
---

# Torchiko venue authoring

> Integration scope (November 1, 2026): this branch includes the contract, skill, offline
> `venue:check` and package authoring advisories from the authoring candidate. It does not yet
> include the candidate's `operator.get_manual` section/schema delivery or `venue:answer-test`
> tooling. Read the repository contract directly; check tool availability before using those
> candidate instructions. This is not deployment, live-test evidence or import permission.


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
- Test on the live guide. After gate 2 passes and the owner authorizes it, `venues.propose_publish`
  makes the guide reachable by its link; an unshared link is the test environment. Never share
  the link. There is one environment: change a guide visitors already use outside venue hours.
- Ask at least 25 visitor-style questions on the live guide (see the gate 4 list in the manual)
  and check each answer against the ledger. Then check the guest page at phone width and
  desktop.
- Record a re-check date: the earliest date any record goes out of date (`EXPIRES_SOON`), so
  someone updates the guide before it says something stale.
- Report the highest gate with evidence. Blocked or unrun checks are reported as such, never as
  passes.

## Answer test

Use `pnpm venue:answer-test --url <guest link> --questions <file> --out <new directory>`
with `--viewport mobile|desktop` and optional `--offline <package.json>` after live-turn
authorization. Prepare at least 25 ledger-backed cases covering hours-today, price,
named-thing, list, family-access, food, follow-up, not-offered, and unknown. Start from
the fictional `scripts/fixtures/venue-answer-questions.json`; see
`scripts/visitor-speed-harness.md` for the full JSON contract and commands.

Without `--url`, `--offline` runs only the package precheck using the actual preview
renderer's default text. Missing expected facts block a live run before browser launch.
Expected facts never go to chat. Each root question has a fresh browser context;
follow-ups share their root's conversation. Keep `followUpOf` chains linear; duplicate
the root to test a separate branch. `askedAt` is expectation context, not a
server-clock override; the real `actualAskedAt` is recorded and date mismatches need
human review. Review `results.json`, `REVIEW.md`, and each answer's screenshot against
the ledger. Conservative normalized literal checks fail known omissions and banned
claims; extra claims, unprovable semantics, or DOM/stream answer mismatches are
`needs-human`. Exit 0 can mean only an offline precheck passed; failed, precheck-failed,
error, and needs-human results exit 1. Human review is required before claiming the
gate is proven. Automated matching
never substitutes for human source-ledger review. Keep output in a machine workspace
and report blocked or unrun checks plainly.

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

## Guest evidence labels

These optional labeled lines stay inside record prose; no new JSON fields are needed. Use exact
record titles or aliases for targets, separated by semicolons. Scope belongs on the governing
rule; link the thing back to that rule. Keep facts on their own thing and do not copy policies.

```text
Kind: admission offer
Also called: Comet wristband
Applies to: Thunder Run; Comet; all coasters
Does not apply to: Splash Pad
Governed by: Ride rules
See also: Guest services
Condition: valid only on weekdays
Exception: not valid on public holidays
Consequence: accepting the pass ends the visitor's visit that day
Must mention: Accepting a rain pass ends your visit for the rest of that day.
Unknown: companion height for Comet
Effective: May 1, 2026 to September 7, 2026
```

Each `Must mention:` must be one self-contained visitor-facing sentence, at most 240 characters.
It can be appended verbatim to an answer when evidence assembly is enabled. Write the full
meaning, including the thing and consequence, without pronouns needing earlier text. A
`Consequence:` alone is highlighted but is not enforced. Never invent an unknown value, infer
scope beyond the named things, or treat `Effective:` as automatic expiration.

`venue:check` and `venues.check_package` report `LINK_TARGET_MISSING`, `SCOPE_TARGET_MISSING`,
`MUST_MENTION_TOO_LONG`, `MUST_MENTION_NOT_SENTENCE`, `CONSEQUENCE_WITHOUT_NOTICE`,
`SCOPE_CONFLICT` and `GOVERNING_SCOPE_CONFLICT` under
`authoring`. They are advisory and never change readiness or importability. Target checks see
only records in the package, so verify unchanged targets separately for a partial update.
Aliases resolve targets; broad scopes such as "all coasters" need human source review.
These checks do not fact-check scope, sentence completeness, dates or consequences.

Treat an explicit exemption as a known boundary of that policy, not an unknown rule. It does
not settle other policies. `See also:` is informational; `Governed by:` is a rule link. A broad
scope with a named exception is valid, while conflicting exact targets or a governing link to
a policy that excludes the thing need source review. Preserve conditional role requirements,
including strict versus inclusive bounds and exceptions.

Use `venues.preview_guest_evidence` for a deterministic view of a live venue's guest-visible
records, parsed scopes, unknowns and notices before a paid answer test. It does not run semantic
retrieval or predict the final answer. Respect its unavailable/partial status and bounds; no
content write or model call occurs.
