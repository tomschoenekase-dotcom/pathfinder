# Guest source notes (lab experiment, off by default)

Small guest models sometimes misapply facts that are present in the guide: a seat range read as a
party size, a rider minimum read as ride height, festival prices applied to ordinary admission, an
accompaniment condition dropped, a date range cut to one end. Source notes are an optional,
machine-made breakdown of one full guide record into what each value measures, who or what it
applies to, when, and the conditions and exceptions that limit it.

## Behavior

- A note binds to the exact text of one rendered guide record (`guestSourceNoteUnitText`; date
  markers added by other flags are left out of the hash). Any edit to the record, or to the note
  prompt or schema, detaches the note. The record text itself is never changed or removed.
- Every value, scope, condition, exception, evidence and unclear item must be an exact span of
  that record (compared after unescaping, NFKC, quote/dash folding and whitespace collapsing).
  A range must keep both endpoints. Labels (`attribute`, `subject`, `notSameAs`) are free text and
  remain fallible: validation proves provenance and shape, never that a label is right.
- Only rows that add a distinction are shown: a scope, date, condition, exception, "not the same
  as" label, a range, or an unknown/unclear value. A note whose rows only restate the entry shows
  nothing.
- Notes sit right after their record inside the same `<untrusted_venue_data>` block, escaped like
  all venue data, and the guide header gains one sentence (`GUEST_SOURCE_NOTES_RULE`). Notes are
  limited to 24,000 characters per guide and attach in guide order; the full-guide versus
  directory decision is made on the guide alone, so notes never change a venue's mode.
- FULL guides only. Directory and evidence-strategy guides, and dynamic retrieved records, get no
  notes.

## Activation (local only)

`GUEST_CHAT_SOURCE_NOTES=on` plus `TORCHIKO_LOCAL_SOURCE_NOTES_FILE=<path to JSONL>`, with
`NODE_ENV` set to `development` or `test`. Production never reads the file. A flag naming a missing
file throws, so a lab capture cannot silently run without its notes. Each turn logs
`guest-chat.source-notes` with counts and the file hash.

Notes are produced offline with `guestSourceNoteExtractionRequest(unitText, route)`, which sends
only the record unit, and packed with `packGuestSourceNote`. No production store, import step or
publishing workflow exists; adding one is a separate decision.

## Evidence

Fictional unit tests cover binding, detachment on edit, method change, fabricated spans,
collapsed ranges, typographic variants, injection escaping, budget order, mode stability,
same-name places and the local loader. A router test proves the flag reaches the provider
request, changes only the cached guide block and is recorded in answer evidence. No answer
quality result exists for this change; it must be measured before any default changes.
