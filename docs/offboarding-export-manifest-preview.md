# Offboarding export-manifest preview

The platform-admin Offboarding console can preview the metadata references that a future export implementation would need for one tenant and up to 20 explicitly selected venues. The preview is computed on demand and is never stored as an artifact.

The browser-safe manifest includes venue identity and tone-version metadata; IDs for active places and enabled knowledge entries; content-history IDs and sequence numbers; venue-package IDs, hashes, schema versions, and lifecycle statuses; and PUBLIC/CLIENT normalized module, revision, and evidence-record identifiers. Operator-audience normalized content is excluded. Every collection is capped, and the response reports returned count, available count, cap, and truncation state.

The endpoint deliberately omits content bodies, package payloads and validation reports, history snapshots, evidence source locators, private support messages and internal notes, guest conversations, media assets, credentials, and secrets. It has no mutation and cannot create or store an artifact, execute an export, revoke access, delete data, or change an offboarding plan.
