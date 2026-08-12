# Quarantined document and image intake

PathFinder accepts one private file per intake source for human review. This path is separate from
Media Lab: it does not start extraction, AI analysis, package creation, approval, apply, or
publication.

## Supported boundary

- PDF, JPEG, PNG, WebP, HEIC, HEIF, and TIFF; at most 25 MiB per file and 20 files per browser
  selection.
- Tenant members reserve an exact tenant/venue/request/file identity before storage signing.
- The server creates a deployment-scoped opaque object key and generation. Filenames never appear
  in storage keys or audit state.
- The signed private PUT is create-only and binds content type, byte count, SHA-256 checksum, and
  generation. A repeated HTTP 412 is treated as an ambiguous prior success and proceeds to exact
  verification.
- Verification claims use a ten-minute durable lease. HEAD must prove generation, bytes, MIME,
  checksum, and an immutable storage version before an append-only `FILE_UPLOAD` intake run is
  created.
- Invalid bytes are deleted only by the exact inspected object version. Storage unavailability
  leaves the same claim retryable and creates no intake run.

`AWAITING_REVIEW` means transport identity was verified. It does not mean the format was parsed,
malware-scanned, safe to render, approved, applied, or published. Client and admin projections omit
the object key, generation, checksum, storage version, signed URL, raw file bytes, and raw transport
errors.
No download or inline preview exists pending owner-approved retention, malware, derivative, and raw
file access policy.

The additive migration is intentionally unapplied. Local checks may format, generate, and validate
Prisma with a dummy loopback URL; they do not establish storage compatibility or live database
readiness.

## Storage rollout prerequisites

The private bucket must have object versioning enabled and must preserve S3-compatible conditional
PUT and SHA-256 checksum behavior. Browser CORS must allow `PUT` from the exact dashboard origins
and allow the signed `content-type`, `if-none-match`, `x-amz-checksum-sha256`, and
`x-amz-meta-pf-intake-upload-generation` request headers. Do not add wildcard origins, public-read
access, GET signing, or unversioned deletion. Rollout must fail closed if HEAD does not return the
immutable `VersionId`, checksum, generation metadata, content type, and byte count.

The API reuses `STORAGE_BUCKET`, `STORAGE_REGION`, optional `STORAGE_ENDPOINT`,
`STORAGE_ACCESS_KEY_ID`, and `STORAGE_SECRET_ACCESS_KEY`. The associated principal must be
least-privilege: allow only the equivalent of `PutObject`, `GetObjectAttributes`/`HeadObject`, and
version-specific `DeleteObjectVersion` needed by the configured provider, scoped to the deployment's
`intake-quarantine/` prefix. It must not grant bucket administration, public ACL changes,
unversioned broad deletion, listing unrelated prefixes, or read access through the client. Exact IAM
syntax is provider-specific and must be reviewed during the authorized rollout rehearsal rather than
copied from Media Lab's broader role.

Before enabling the UI in a deployed environment, rehearse one explicitly authorized test object in
an isolated target: prove create-only PUT, exact HEAD evidence, 412 replay reconciliation, and
version-specific deletion of a deliberately invalid object. No such live storage rehearsal has been
performed in this repository wave.
