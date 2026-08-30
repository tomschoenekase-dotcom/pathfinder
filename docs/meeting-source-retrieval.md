# Meeting source retrieval

The prospect workspace exposes compact meeting summaries, extracted knowledge, transcript status,
and source provenance without returning raw transcript bodies.

Human-openable source actions fail closed. The dashboard accepts HTTPS links only for the exact
Google Calendar, Drive, Docs, and Meet browser hosts. It rejects lookalike hosts, credentials,
custom ports, non-HTTPS schemes, and Google Meet API resource URLs. API-only transcript provenance
is labeled honestly because it requires authorized Workspace tooling rather than a browser tab.

The prospect query returns only the newest transcript artifact's identifier, source reference,
acquisition time, and expiry. It deliberately excludes transcript text and structured entries.
Google Workspace remains the canonical location for complete transcript content.

This is a read-only retrieval surface. It does not authenticate Google Workspace, call provider
APIs, change retention, contact customers, or authorize production behavior.
