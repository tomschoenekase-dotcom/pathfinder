# Founder-approved synthetic evidence package

This fail-closed, read-only validator prepares the four remaining founder-data exercises without
inventing customer truth:

- `VIS-06`: reviewed connected venue topology;
- `VIS-07`: a local image with verified bytes, SHA-256, rights, alt text, and review evidence;
- `UPD-01`: representative history covering addition, correction, supersession, temporary,
  conflict, and duplicate/no-op;
- `UPD-02`: an explicitly bounded approve/apply/revert/schedule/deactivate exercise contract.

The command accepts one JSON package supplied and approved by the founder:

```text
pnpm founder-evidence:validate -- C:\path\to\approved-package\package.json
```

Start from `scripts/founder-evidence-package/template.pending.json`. The checked-in template is
deliberately `PENDING`, contains no approved asset or customer/database identifiers, and cannot pass
the validator until every placeholder is replaced and the founder records an approval reference.

It emits a receipt to stdout. It does not connect to a database, authenticate, upload media, call a
provider, write a report, grant publication authority, or mutate staging. Validation requires all
four scope IDs, `synthetic: true`, `customerData: false`, an explicit `APPROVED` review reference,
one connected topology, one non-symlink image contained beside the JSON package, all six semantic
change classes, and a staging-only exercise with provider calls and publication authority disabled.

Image descriptors must include a relative `localPath`, exact byte size, lowercase SHA-256, MIME
type (`image/png`, `image/jpeg`, or `image/webp`), alt text, source name, review timestamp, and rights
basis/statement/evidence reference. The validator checks the real file, signature, size, path
containment, and digest; it never prints the local path or source bytes in its receipt.

Passing this validator is intake readiness, not hosted proof and not approval to execute. A later
staging exercise still requires an authenticated human-admin session, exact current release proof,
explicit action-time approval, retained apply/revert and schedule/deactivate receipts, and cleanup.
Production remains outside this workflow.
