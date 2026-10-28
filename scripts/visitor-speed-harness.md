# Visitor speed browser harness

This script measures the public guide in Chromium and writes one JSON file plus
a Markdown summary for each run. It records click-to-first-visible assistant
text, click-to-complete NDJSON event, request-to-response headers, click-to-
headers, click-to-first-delta, delta count, rendered text changes, response
headers, click-to-visible working indicator, and the packet's 100 ms
first-to-last-delta buffering flag. The indicator selector follows
`ChatWindow`'s direct `aria-hidden` child under the conversation log.

## Run

Use a disposable local guide with a provider stub for harness validation. The
retained synthetic browser and NDJSON fixture can be rerun from this task's QA
folder with `node C:\Users\tomsc\MachineWorkspaces\torchiko\20260927-visitor-speed\qa\visitor-speed\local-stream-fixture.mjs`.
It tests the actual ChatWindow selector contract and an in-process streamed
chat-response stub without contacting a model provider. The full local
application stack still needs Docker.

```powershell
@'
["Where is the entrance?", "What can children do?"]
'@ | Set-Content -Encoding utf8 C:\Users\tomsc\MachineWorkspaces\torchiko\20260927-visitor-speed\qa\visitor-speed-questions.json
node scripts/visitor-speed-harness.mjs `
  --url http://localhost:3000/guide/quillbrook `
  --questions C:\Users\tomsc\MachineWorkspaces\torchiko\20260927-visitor-speed\qa\visitor-speed-questions.json `
  --out-dir C:\Users\tomsc\MachineWorkspaces\torchiko\20260927-visitor-speed\qa\visitor-speed
```

Each string opens a new browser context, so both are first-message samples.
For a first message followed by follow-ups in one fresh context:

```json
[
  {
    "venue": "Quillbrook",
    "questions": ["Where is the entrance?", "Is parking available?"]
  }
]
```

Do not point this at a hosted guide without the explicit live-turn authorization
required by Packet 2. Outputs contain the submitted questions and full guide
URL; keep them in the assigned machine workspace and do not commit them.

The harness wraps the page's fetch stream with a transparent `TransformStream`
tap. It timestamps NDJSON delta and completion events as the browser consumes
them, and counts text states observed on animation frames for the last
assistant message. This adds minimal local instrumentation and measures the
client-visible route through the browser, including the actual guide's paint
path.

## Visitor answer regression gate

The answer harness checks visitor answers against a separate source ledger. It
does not send expected facts, ledger quotes, source URLs, or forbidden phrases
to the chat. Use it after package checks and before claiming visitor-answer
quality. Live runs require authorization for the guide and model turns.

```powershell
pnpm venue:answer-test `
  --url http://localhost:3000/guide/quillbrook `
  --questions scripts/fixtures/venue-answer-questions.json `
  --out C:\Users\tomsc\MachineWorkspaces\torchiko\answer-test\quillbrook-mobile `
  --viewport mobile `
  --offline C:\Users\tomsc\MachineWorkspaces\torchiko\quillbrook-package.json
```

`--questions` and `--out` are required; the output directory must be new.
`--viewport` accepts `mobile` or `desktop`. Repeat with a different new output
directory to check both widths. `--offline` is optional alongside `--url`:
it runs the package precheck first and blocks the live run before browser
launch if expected facts are missing. Omitting `--url` runs only the offline
precheck and requires `--offline`; that is not evidence of a live answer pass.
The precheck uses the actual preview renderer with its default text, rather
than searching the raw package JSON.

The questions file is a JSON array of at least 25 cases. Include every kind
listed below except `other`, which is optional:

`hours-today`, `price`, `named-thing`, `list`, `family-access`, `food`,
`follow-up`, `not-offered`, `unknown`, `other`.

Each case has this shape (the fictional example is one case, not a full suite):

```json
{
  "id": "quillbrook-admission",
  "question": "How much is adult admission?",
  "askedAt": "2026-10-29T10:00:00-05:00",
  "timeZone": "America/Chicago",
  "kind": "price",
  "expect": [
    {
      "fact": "Adult admission is $12",
      "ledgerQuote": "Adult admission is $12.",
      "sourceUrl": "https://quillbrook.example/admission"
    }
  ],
  "mustNotSay": ["Adult admission is free"]
}
```

Use unique `id` values, ISO timestamps with an explicit offset for `askedAt`,
and an IANA `timeZone`. A follow-up references its earlier case with
`"followUpOf": "quillbrook-admission"`. Each root question gets a fresh browser
context; its follow-ups share that conversation. Keep expectations grounded in
the source ledger and review all list members and unknown/not-offered cases.
`followUpOf` chains must be linear. Duplicate the root as a new case to test a
separate conversation branch.
The retained suite at `scripts/fixtures/venue-answer-questions.json` uses the
fictional Quillbrook venue; replace its expectations with your venue's evidence
before testing a real guide.

`askedAt` describes the expectation's date context. It does not override the
server clock. The harness records the real `actualAskedAt` for each question;
a date mismatch is `needs-human`, especially for “today” and seasonal answers.

The run writes `results.json`, `REVIEW.md`, and a screenshot for each answer.
Keep these artifacts in the assigned machine workspace: they contain questions,
guide URLs, and answers. Review the transcript and screenshots against the
ledger before reporting a gate result.

Matching is deliberately conservative: normalized literal expected facts must
appear, and forbidden phrases must not appear. Known omissions and forbidden
claims fail. Extra claims or semantics that literal matching cannot establish
need human review (`needs-human`). A matching answer is not proof that every
claim is supported; the harness never replaces source-ledger review. Report
offline-only, blocked, failed, and unreviewed results explicitly.
Disagreement between the rendered DOM answer and streamed answer is also
`needs-human`. Exit code 0 can mean an offline-only precheck succeeded; it does
not prove the live gate. Failed, precheck-failed, error, and needs-human results
exit 1; needs-human requires review before the gate can be considered proven.
