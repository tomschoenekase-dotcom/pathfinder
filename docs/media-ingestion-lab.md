# Venue Media Lab

The Venue Media Lab is a platform-admin-only workflow for turning a ZIP of venue photos, videos,
audio, manifests, prior analysis, and notes into reviewed PathFinder import JSON.

## Product flow

1. Open a venue in platform admin and choose **Media lab**.
2. Give the intake a name, paste any useful context or handoff notes, select a fidelity mode, and
   choose a ZIP up to 5 GB.
3. The browser uploads directly to S3-compatible object storage in 16 MB multipart chunks. Three
   chunks run concurrently; the archive never passes through a Next.js request body. The API signs
   only the declared number of parts, requires one contiguous completed part set, then reads the
   completed object's actual size from storage before it can queue processing.
4. After the global-admission rollout gate below is complete, BullMQ admits at most one media job
   across all healthy-Redis worker replicas, with local concurrency also held at one. The admitted
   worker safely extracts supported files with a 10,000-entry and 20 GB actual expanded-byte ceiling.
   Every non-directory entry counts, including ignored formats, and the crossing chunk is rejected
   before it reaches disk.
5. Every supported image is inventoried and analyzed by default. Exact SHA-256 duplicates reuse an
   existing analysis while retaining their own source row. Videos are sampled at the configured
   interval with a 120-frame ceiling by default. Before upload, the UI discloses that the venue name,
   supported photos, sampled video frames, optional audio, extracted supported text, generated
   evidence summaries (including Google analysis when enabled), and up to 12,000 characters of
   operator context are sent to OpenAI for analysis and draft synthesis, while the source ZIP itself
   is not sent as an archive. An operator may explicitly opt a new intake
   into Google Gemini complete-video understanding so motion, narration, visible text, and
   timestamped events are analyzed together; the UI separately discloses that the video, its
   filename, and up to 12,000 characters of project operator context cross the Google provider
   boundary before opt-in. An extracted video above Google's 2,000,000,000-byte Files API per-file
   limit never crosses the Google boundary and instead uses the disclosed OpenAI sampled fallback
   with an explicit review limitation. Each retained video finding identifies whether it came from
   Google complete-video analysis, ordinary sampled analysis, or sampled analysis after a Google
   fallback so reviewers do not have to infer provider provenance from generated prose. Each FFmpeg
   invocation has stdin disabled, a 15-minute
   wall-clock limit, and a 64 KiB per-stream output limit. FFmpeg is invoked directly as a leaf
   process, without a shell. Generated frame dimensions are bounded on both axes. Frame JPEGs and
   audio MP3 are streamed through one attempt-wide byte budget before crossing bytes can reach a
   scratch file; each video's frame/audio directory is removed before the next asset. Standalone
   narration and video audio are transcribed.
6. Source-level analyses retain visible text, object confidence, spatial clues, and uncertainties.
   Larger visits are summarized hierarchically before synthesis so one request does not need to hold
   the entire visual corpus.
7. The result becomes a set of material questions plus editable, downloadable PathFinder JSON.
   Nothing is automatically imported into the venue database.

## Fidelity modes

- **Economy** compresses images more aggressively and uses low-detail vision input.
- **Balanced** is the default: every image, audio transcription, exact duplicate detection, and an
  eight-second base video interval.
- **Forensic** increases image dimensions and uses high-detail vision input. It is intended for dense
  labels and provenance work.

The reviewed model strings are code-owned contracts. `MEDIA_ANALYSIS_MODEL` and
`MEDIA_SYNTHESIS_MODEL` default to and currently admit only `gpt-5.6-luna`;
`MEDIA_TRANSCRIPTION_MODEL` defaults to and currently admits only `gpt-4o-mini-transcribe`.
The optional complete-video route currently admits only `gemini-3.7-flash`; it is never selected by
an environment variable alone because every intake must persist the explicit
`useGeminiVideoUnderstanding` choice. Provider SDK retries are disabled so one durable reservation
maps to one request attempt.
Deployment configuration may repeat those exact values, but an unreviewed override fails before
archive processing or provider dispatch. Changing price or quality now requires a code-reviewed,
versioned model-contract update rather than an arbitrary environment edit. OpenAI currently
publishes `gpt-5.6-luna` as the only stable identifier for this model (no dated snapshot is listed),
with Chat Completions, structured outputs, and image input supported.

Every image-analysis, evidence-condensation, synthesis, and transcription dispatch writes a
tenant- and venue-attributed `AiUsageEvent` through the shared worker sink. The event retains the
capability, model, pricing version, latency, attempt/success state, normalized error code, exact
observed token categories, and an estimated USD cost. A billed response that fails bounded schema
validation is recorded as a failed usage event with its observed tokens; persistence is best-effort
and cannot cause another provider attempt. Luna's documented long-context multiplier is applied
when observed input exceeds 272,000 tokens. The project-level `estimatedCostCents` and
`actualCostCents` display fields remain legacy scaffolding and are not treated as the canonical
ledger.

The same dispatches now participate in the existing optional tenant `gateway-v1` hard budget. Each
attempt reserves the full documented model maximum before provider I/O: Luna uses its 1,050,000
input-token and 128,000 output-token limits at the dearer long-context rates, while transcription
uses its 16,000-token context and 2,000-token output limits. A configured budget denial therefore
stops the call before dispatch. Observed responses settle to exact estimated cost; failures without
an observed usage envelope conservatively settle at the reserved maximum. The reservation is
released when provider initialization or the durable dispatch fence fails before provider I/O.
No budget is invented when the tenant has not configured one, and this technical boundary does not
choose a commercial media tier or customer price.

## Required deployment configuration

Set the existing storage credentials plus:

```text
STORAGE_BUCKET=
STORAGE_REGION=
STORAGE_ENDPOINT=        # optional, for R2/MinIO/S3-compatible storage
STORAGE_ACCESS_KEY_ID=
STORAGE_SECRET_ACCESS_KEY=
OPENAI_API_KEY=
# Optional. Required only for explicitly opted-in Google complete-video analysis.
GEMINI_API_KEY=
MEDIA_VIDEO_ANALYSIS_MODEL=gemini-3.7-flash
```

The bucket CORS policy must permit `PUT` from the dashboard origin and expose the `ETag` response
header. Apply the new Prisma migration and redeploy both dashboard/API and workers.

## Evidence and safety behavior

- Project context is explicitly identified to the model as context, not visual evidence.
- The vision prompt requires verbatim transcription and forbids object identification from shape
  alone.
- Uncertain items remain uncertain; synthesis is instructed not to silently merge them.
- Every extracted asset receives a stable source ID and its own database row, including failures.
- Raw media remains private in object storage. Database and logs hold IDs and analysis state, not
  image bytes or prompt payloads.
- An opted-in complete video is uploaded through Google's Files API, analyzed under a 15-minute
  attempt deadline, and deleted immediately in a separate bounded cleanup step. A deletion that
  cannot be confirmed fails closed. Google's separate API-log retention policy still applies, as
  disclosed in the intake UI. An ordinary Google provider failure falls back to bounded frame
  sampling and optional narration transcription, with that limitation inserted into review evidence.
  The known 2,000,000,000-byte per-file ceiling is enforced before AI admission, operation
  reservation, budget reservation, or upload.
- The Google call uses the shared tenant budget gate and a conservative reservation based on the
  documented post-introductory model price; observed usage settles against the versioned current
  price schedule. A live provider canary still requires separate spending and synthetic-data
  authorization.
- Multipart completion is claimed atomically before storage is touched. A concurrent completion
  loser cannot complete, delete, enqueue, or overwrite the winner's state.
- Empty, oversized, or declared-size-mismatched completed objects are removed by exact database-
  derived key and storage version when available. An unavailable size check fails closed without
  deleting a possibly valid object; a failed completion attempts to abort its multipart upload.
- ZIP paths are flattened to generated local names, so archive path traversal cannot select the
  extraction destination.
- Text context is streamed into at most a 100,000-character per-file prefix rather than loaded into
  memory in full. One job retains at most 250,000 text characters, and synthesis refuses an evidence
  batch or final evidence payload above its one-million-character memory ceiling.
- Temporary extracted data is removed after success or failure.
- Every provider request reserves one durable operation before dispatch. One upload generation can
  reserve at most 10,000 operations across all BullMQ attempts; provider failures still consume the
  reservation, exact duplicate reuse does not, and only a new upload generation resets the counter.
  The media SDK performs no hidden retries; a BullMQ retry must reserve each provider operation again.
- Worker startup writes and reads back BullMQ's environment-scoped queue-global concurrency of one
  before constructing any media consumer. Redis failure therefore prevents a new worker replica from
  starting media work. BullMQ job locks and stalled-job recovery own release after normal completion,
  failure, or process loss; the setting is never removed during ordinary shutdown.
- The media processor uses BullMQ's cancellation signal. Exact job IDs are cancelled when lock renewal
  fails, and a media-worker Redis/runtime error conservatively cancels every job tracked by that media
  Worker only. Cancellation reaches object download and extraction, hashing, text reads, OpenAI
  requests, provider reservation boundaries, FFmpeg children, generated-output cleanup, and durable
  write boundaries. A claimed generation is recorded as retryable `FAILED` before the error returns so
  stalled-job recovery can reclaim it; temporary files are removed in every path.
- Every BullMQ attempt has a six-hour technical execution fuse and one cumulative 5 GiB
  generated-output fuse. The attempt signal is created before durable job reads and is shared by every
  downstream operation; the timer is never reset per file or provider request. Generated FFmpeg
  frames/audio and Sharp provider-image buffers all consume the same byte budget, which is never
  refunded after scratch cleanup. Source ZIP and extracted-source bytes remain exclusively under the
  separate 20 GiB archive budget, so they are not double-counted. Generated-byte exhaustion is
  deterministic and unrecoverable; a whole-attempt deadline remains retryable.

## Global-admission rollout and rollback

- The setting limits newly admitted work but does not preempt media jobs that were already active
  before the first upgraded worker wrote it. Before resuming intake or declaring a rollout ready,
  drain and terminate every old media-worker replica, verify the queue has no more than one active
  media job, and record that every remaining replica uses a BullMQ version supporting queue-meta
  global concurrency. Merely pausing intake while an incompatible replica remains is insufficient.
- Production, staging, and preview queue names are distinct. Preview deployments still share the
  same preview queue if they are pointed at one Redis instance; the staging isolation runbook already
  requires separate Redis resources.
- Queue-global concurrency is persistent Redis policy. Reverting application code does not remove
  it, and normal worker cleanup must not remove it while another replica may be running. Intentional
  removal requires a separately authorized, inspected `removeGlobalConcurrency()` operation after
  pausing/draining the media queue, followed by an exact `getGlobalConcurrency()` readback.
- This is a healthy-Redis admission boundary, not a strict distributed execution mutex. Cooperative
  cancellation sharply bounds an old processor after Redis/lock loss, but it cannot revoke a provider
  request or database statement that completed in the narrow interval before that operation observed
  the signal. Generation predicates, durable provider reservations, and status claims limit the
  resulting stale-write window; a process crash still relies on BullMQ stalled-job recovery.
- The six-hour deadline bounds active media work, not compensation after cancellation. Exact
  generation-fenced failure persistence and temporary-file cleanup are intentionally allowed to finish
  after the timer fires. With three configured BullMQ attempts, a repeatedly timing-out generation can
  receive up to 18 hours of active execution and regenerate up to 15 GiB across attempts; the durable
  provider-operation ceiling remains generation-wide. Changing these technical fuses into commercial
  tiers or a generation-wide byte/time quota requires measured staging evidence and an approved policy.

## Current supported formats

Images: JPEG, PNG, WebP, HEIC, TIFF. Videos: MP4, MOV, M4V, AVI, WebM. Audio: MP3, M4A, WAV, AAC,
OGG. Text context: TXT, Markdown, CSV, JSON. PDFs are inventoried and flagged for manual review; PDF
text extraction is not yet part of the worker.

## Known follow-ups

- Select and validate any separate commercial media-tier allowance below the existing tenant dollar
  budget and technical 10,000-operation safety ceiling once pricing policy is approved.
- Add perceptual (not merely byte-exact) duplicate grouping and cross-batch exhibit reconciliation.
- The intake detail screen now polls one narrow tenant/venue/project-scoped status contract while
  work is active, backs off on failure, stops while hidden or terminal, and fetches the complete
  review only after the server reports a draft.
- Review now includes a generation-fenced source-evidence gallery with at most 50 editable findings
  per page and per-finding corrections. Original AI findings remain immutable; server-stamped
  reviewer corrections are stored beside them. Corrections do not silently rewrite the venue
  package because findings do not yet map one-to-one to package items.
- The generated download is now the frozen Venue Package v1 contract shared by the worker, API,
  and dashboard. Questions and coverage are stored outside that JSON. Drafts produced before this
  boundary used an incompatible `title`/`description` shape and remain visibly invalid until an
  operator edits or explicitly regenerates them; they are never silently transformed.
- Source assets expose bounded metadata only, while separately paginated findings expose the
  reviewable analysis; neither contract returns storage keys. Actual
  thumbnails require separately persisted derivatives, so they remain blocked on approved raw and
  derived-media privacy, retention, deletion, encryption, and storage-cost policy.
