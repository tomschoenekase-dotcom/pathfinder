# Physical-device evidence package

This tooling prepares the remaining human/hardware gate for `VIS-01`, `VIS-03`, `A11Y-01`, and
`PHY-01`. It validates retained evidence; it does not simulate a device, perform the review, certify
launch readiness, or change staging.

Run it only after the physical sessions are complete:

```text
pnpm physical-evidence:validate -- <path-to-reviewed-package.json>
```

Start from `scripts/physical-evidence-package/template.pending.json`. Keep the package and its local
evidence files in one private review directory. Do not commit device captures or customer data.

A passing package requires:

- exact staging release SHA and credential-free HTTPS origin;
- one real iOS session and one real Android session;
- device, OS, browser, operator, observation time, and documented weak/variable-network method;
- passing physical checks for New Chat/reset, soft keyboard and safe areas, screen reader,
  text zoom/reflow, switch or external control, printed QR scan, glare/focus, cold load, and
  attribution marker behavior on both platforms;
- local PNG, JPEG, WebP, or MP4 evidence owned by the matching session, with signature, byte count,
  SHA-256, capture time, and description; and
- a completed human review later than every session and capture.

The validator rejects path escape, symlinks, duplicate content, hash or signature drift, incomplete
scope/check coverage, failed outcomes, invalid chronology, non-physical sessions, customer/account
identifiers, unsafe origins, oversized input, and pending review. Its receipt omits local paths and
source bytes. The checked-in template is intentionally pending and cannot pass.
