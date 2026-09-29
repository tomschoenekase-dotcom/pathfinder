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
  --url http://localhost:3000/guide/space-museum `
  --questions C:\Users\tomsc\MachineWorkspaces\torchiko\20260927-visitor-speed\qa\visitor-speed-questions.json `
  --out-dir C:\Users\tomsc\MachineWorkspaces\torchiko\20260927-visitor-speed\qa\visitor-speed
```

Each string opens a new browser context, so both are first-message samples.
For a first message followed by follow-ups in one fresh context:

```json
[
  {
    "venue": "Space Museum",
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
