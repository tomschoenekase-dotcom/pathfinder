# Venue Media Lab

The Venue Media Lab is a platform-admin-only workflow for turning a ZIP of venue photos, videos,
audio, manifests, prior analysis, and notes into reviewed PathFinder import JSON.

## Product flow

1. Open a venue in platform admin and choose **Media lab**.
2. Give the intake a name, paste any useful context or handoff notes, select a fidelity mode, and
   choose a ZIP up to 5 GB.
3. The browser uploads directly to S3-compatible object storage in 16 MB multipart chunks. Three
   chunks run concurrently; the archive never passes through a Next.js request body.
4. A single-concurrency BullMQ worker safely extracts supported files with a 10,000-file and 20 GB
   expanded-size ceiling.
5. Every supported image is inventoried and analyzed by default. Exact SHA-256 duplicates reuse an
   existing analysis while retaining their own source row. Videos are sampled at the configured
   interval with a 120-frame ceiling. Standalone narration and video audio are transcribed.
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
- ZIP paths are flattened to generated local names, so archive path traversal cannot select the
  extraction destination.
- Temporary extracted data is removed after success or failure.

## Current supported formats

Images: JPEG, PNG, WebP, HEIC, TIFF. Videos: MP4, MOV, M4V, AVI, WebM. Audio: MP3, M4A, WAV, AAC,
OGG. Text context: TXT, Markdown, CSV, JSON. PDFs are inventoried and flagged for manual review; PDF
text extraction is not yet part of the worker.

## Known follow-ups

- Add multipart-abort and retry/resume controls in the UI for interrupted uploads.
- Add perceptual (not merely byte-exact) duplicate grouping and cross-batch exhibit reconciliation.
- Persist token usage and calculate estimated/actual spend from a versioned pricing table.
- Add server-driven polling or push updates on the intake detail screen.
- Add a source gallery and per-finding correction UI before direct venue import is enabled.
