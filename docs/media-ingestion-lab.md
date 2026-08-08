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
   interval with a 120-frame ceiling. Each FFmpeg invocation has stdin disabled, a 15-minute
   wall-clock limit, and a 64 KiB per-stream output limit. FFmpeg is invoked directly as a leaf
   process, without a shell. Generated frame dimensions are bounded on both axes, and each video's
   frame/audio directory is removed before the next asset. Standalone narration and video audio are
   transcribed.
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

The model strings are deployment configuration, not product constants. `MEDIA_ANALYSIS_MODEL` and
`MEDIA_SYNTHESIS_MODEL` default to `gpt-5.6-luna`; `MEDIA_TRANSCRIPTION_MODEL` defaults to
`gpt-4o-mini-transcribe`. This allows price/quality changes without migrations.

## Required deployment configuration

Set the existing storage credentials plus:

```text
STORAGE_BUCKET=
STORAGE_REGION=
STORAGE_ENDPOINT=        # optional, for R2/MinIO/S3-compatible storage
STORAGE_ACCESS_KEY_ID=
STORAGE_SECRET_ACCESS_KEY=
OPENAI_API_KEY=
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

## Current supported formats

Images: JPEG, PNG, WebP, HEIC, TIFF. Videos: MP4, MOV, M4V, AVI, WebM. Audio: MP3, M4A, WAV, AAC,
OGG. Text context: TXT, Markdown, CSV, JSON. PDFs are inventoried and flagged for manual review; PDF
text extraction is not yet part of the worker.

## Known follow-ups

- Select and validate a stricter commercial/provider budget below the technical 10,000-operation
  safety ceiling once pricing and media tier policy are approved.
- Add perceptual (not merely byte-exact) duplicate grouping and cross-batch exhibit reconciliation.
- Persist token usage and calculate estimated/actual spend from a versioned pricing table.
- Add server-driven polling or push updates on the intake detail screen.
- Add a source gallery and per-finding correction UI before direct venue import is enabled.
