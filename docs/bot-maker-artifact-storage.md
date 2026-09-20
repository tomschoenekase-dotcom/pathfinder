# Bot Maker character artifact storage

Character factory exports use content-addressed keys under `character-factory/`. The
`character-bundle-content-v1` reference is used when the configured S3-compatible provider does
not return object versions. It contains no fabricated `versionId`: the SHA-256 in the reference,
the object metadata, the exact byte length, and the downloaded bytes are all checked on every read.
Writes remain conditional (`IfNoneMatch: *`). A retry after `412` accepts only an existing object
whose length and SHA-256 metadata match, then performs the same full verified read.

Legacy `character-bundle-v1` references remain version-pinned and continue sending `VersionId` on
reads. The content-addressed mode provides integrity and replay identity, but it cannot recover an
older object after an out-of-band overwrite or deletion; a changed object fails closed on checksum
verification. Final artifacts are retained by policy and this storage path does not delete them.

Quarantined intake uploads keep their separate immutable-version contract. They still require a
provider-generated `VersionId` and version-specific deletion, so the non-versioned Railway bucket
is not admitted for quarantine storage.

Publication bindings currently remain version-pinned: a content-addressed artifact can be imported,
reviewed, and retained, but publication fails closed until its binding schema has an explicit
content identity. The SHA-256 is not placed into the existing `artifactVersionId` field.
