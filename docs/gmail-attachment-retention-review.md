# Gmail attachment retention review

Gmail remains the canonical source for correspondence and its attachments. Inbound sync records a
bounded attachment metadata snapshot only; it does not download attachment bytes.

Platform administrators can prepare a case-by-case retention review from an exact canonical email
and provider attachment identifier. The server re-derives filename, media type, byte size, and
source linkage from the stored metadata rather than trusting client-supplied values. A request must
state one reviewed business-record category and why the attachment may be operationally useful.

The terminal human decision is either:

- `APPROVED_FOR_IMPORT`: authority evidence for a future, separate import executor; or
- `DECLINED_SOURCE_ONLY`: keep Gmail as the source and do not import the file.

Both preparation and review are replay-safe, race-guarded, and strictly audited. At most one active
review or approval can exist for one exact message/attachment pair. Approval itself never calls
Gmail, downloads bytes, writes object storage, creates an intake upload, establishes a retention
duration, or promotes attachment contents into Company Brain. A future importer must separately
enforce authorized Gmail access, malware/resource-safety checks, storage policy, provenance, and
retention rules before recording any imported asset.

The prospect CRM query continues to exclude full email text and HTML. It selects compact previews,
safe Gmail source references, attachment metadata, and bounded review evidence only.
