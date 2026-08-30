# Gmail source retrieval from CRM

The platform-admin prospect workspace treats Gmail as the canonical source for complete email
content. Torchiko's primary correspondence view reads compact operational previews and provenance;
it does not select retained plain-text or HTML bodies.

When ingestion recorded a valid `https://mail.google.com/mail/u/...` source reference, the view
offers a touch-sized **Open source email in Gmail** link. The browser uses the operator's existing
Google session. Torchiko does not retrieve credentials, proxy the message body, mark the message
read, or change correspondence state.

Source URLs fail closed. Links must use HTTPS, the exact `mail.google.com` host, no credentials or
custom port, and the Gmail `/mail/u/` path. Missing, malformed, non-Gmail, or attacker-controlled
references render as unavailable rather than becoming clickable.

This surface remains platform-admin only through the existing prospect router and dashboard
authorization. The separately scoped Company Brain account-history tool continues to return bounded
snippets and provenance for authorized workers.
