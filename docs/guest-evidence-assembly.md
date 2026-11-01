# Guest evidence assembly

Status: implemented behind `GUEST_CHAT_EVIDENCE_ASSEMBLY` (`off` by default, `on`, or `luna`).
With the flag off, the guest prompt and answers are unchanged.

## Problem

Traced path: authoring (labeled lines inside record prose) -> storage (legacy knowledge rows and
places; content-module IDs are mostly null) -> retrieval (fresh each turn from the current
question plus a lexical copy of the previous question) -> prompt (cached venue guide + retrieved
records + optional focus facts) -> one model call -> streamed answer.

Where meaning was lost:

1. Turn continuity carried only text. The previous answer stayed in history, but the records
   behind it were not carried. A governing policy retrieved for turn 1 was often absent from
   turn 2's retrieved records, and the model either guessed or answered from its own prior
   sentence.
2. Labeled lines (`Height:`, `Price:`, `Also called:`) were treated as prose. Roles inside a
   value ("40 in with a companion; 48 in alone"), a policy's scope, consequences and explicit
   unknowns had no structure the runtime could use.
3. Identity resolution looked at titled places only. An offer named inside an umbrella topic
   ("Comet wristband" inside "Group outings") was invisible as a distinct thing, so the
   same-name ride won silently.
4. The visitor's people were never modeled. "He is 40 inches, she is 48" lived only in history.
5. Response depth had three settings (default, expand, compare). Casual identification and
   explicit deep dives got the same budget and the same guidance.

## Chosen design

Small semantic layer on the existing "things" model. No new database, no migration, no graph.

- `guest-record-semantics.ts` parses a closed set of labeled lines from any record (knowledge
  row or place) into typed semantics: kind, aliases, scope (`Applies to:`, `Does not apply to:`),
  links (`Governed by:`, `See also:`), role-bearing facts with value/unit, conditions,
  consequences, required notices (`Must mention:`), explicit unknowns (`Unknown:`), effective
  dates. The prose stays as written; unrecognised lines remain prose. Records with no new labels
  still get kinds (inferred, and marked inferred), facts from existing labeled lines, and
  detected consequence sentences.
- `guest-conversation-party.ts` turns the visitor's own messages into a party list (person
  label, height, age, which message said it) and binds the current question's roles (rider,
  companion, accompanying adult) only when the wording states them.
- `guest-answer-shape.ts` classifies the visitor's intent (identify, fact, compare, plan, list,
  deep dive) plus independent actionable and permission flags, and descriptor words used for
  identification ("yellow", "big").
- `guest-evidence-assembly.ts` is the per-turn assembler. It resolves the subjects of the
  question (titles, aliases and embedded mentions, keeping same-name things of different kinds
  apart), carries the previous turn's subject and governing record IDs when the question refers
  back, joins governing policies by scope and links, states unknown scope and missing link
  targets, adds the party, and renders one bounded `<evidence_focus>` block. It also returns the
  next turn's state (record refs only, never assistant text) and the required notices.
- Carried refs are reloaded by ID every turn through the same authorization fence as the venue
  directory (`loadGuestVenueDirectory` with `onlyIds`), then the native-release projection. A
  carried record that is retired, unpublished, hidden or deleted is dropped and reported to the
  model only as "a record used earlier is no longer available" (no title, no content), and it is
  removed from the cached directory for this turn. A changed record is reported as changed.
- `guest-required-notices.ts` checks the final answer: when a thing with a `Must mention:` line is
  discussed and the answer lacks that notice's content, the authored notice is appended
  server-side (the same pattern as the existing recommendation disclosure). This is a
  deterministic lexical check with known limits (below), not a second model call.
- A new response intent `DEEP_DIVE` widens the reply budget for explicit "tell me everything"
  requests. Identification gets guidance to give one or two distinguishing facts. Every shape
  keeps required notices and material conditions.
- State lives in the existing per-turn `replayMetadata` JSON (`evidenceState`), which is already
  hash-verified when read back. No schema migration.

## Rejected alternatives

- Carry the previous top-N retrieved records (the diagnostic prototype). Fixes the measured
  loss but carries noise, carries nothing that was not retrieved, and has no reauthorization.
- Replace prose with JSON, CSV or tags. The diagnostic found no format effect on its own;
  scope, roles and unknowns matter, and readable records are what operators maintain.
- A new facts table or content-module migration. Staging is gated on migrations, most rows are
  legacy, and labeled lines are already the authoring standard. A table can come later if
  measured need appears; the parser output shape is what a table would store.
- Copy governing policies into every record. Breaks removability and duplicates authority.
- A second model call to verify completeness. Adds latency and cost and is not a guarantee.
- Shrink retrieval to control verbosity. The diagnostic showed compact context lost consequences
  (9/10 omissions); depth is controlled in the instructions instead.

## Authoring grammar (new labels, all optional)

```
Kind: admission offer
Also called: Comet wristband
Applies to: Thunder Run; Comet; all coasters
Does not apply to: Splash Pad
Governed by: Ride rules
Condition: valid only on weekdays
Consequence: accepting the pass ends today's visit
Must mention: Accepting a rain pass ends your visit for the rest of that day.
Unknown: companion height for Comet
Effective: May 1, 2026 to September 7, 2026
```

`Must mention:` text is shown to visitors verbatim when appended, so write it as one
self-contained visitor-facing sentence.

## Limits

- Role binding and pronoun resolution are pattern-based. Unresolved roles are stated as
  unresolved; they are never guessed. "A rides with B" is symmetric and is rendered as "riding
  together" only: in the first paid run a grammatical rider/companion binding swapped the roles
  (the shorter child needed the older cousin as companion). Explicit roles come only from
  "as a companion", "take/accompany" and "alone" wording.
- A kind cue alone ("how much is ...") never promotes a thing named inside another record over
  the titled thing; that case stays ambiguous so the answer covers both or asks.
- The required-notice check is lexical: a paraphrase with different words can cause a redundant
  append, and a negated mention can be counted as present.
- Legacy records without the new labels get inferred kinds and detected consequence sentences,
  but nothing is enforced for them.
- Kind inference from category/title words can be wrong; it only orders identity candidates and
  is marked inferred.
