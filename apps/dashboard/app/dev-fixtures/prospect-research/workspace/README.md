# Synthetic selected-workspace browser proof

Use only the existing local preview with its existing development, visual-fixture, local-research, local-sales, and local-rehearsal flags. Do not start a service solely for this page and do not use a hosted or authenticated URL.

Open this explicitly synthetic selection (replace `r007` only with a current staged synthetic revision):

`/dev-fixtures/prospect-research/workspace?organizationId=SYN-CRM-FIRSTSEND-ORG-r007&organizationId=SYN-CRM-FIRSTSEND-ORG-r999`

Check the following in the existing browser session:

- The amber fixture boundary states that the surface has no authenticated CRM or provider access.
- The present record resolves to its native `SYN-CRM-FIRSTSEND-VENUE-rNNN` identity. The missing record is shown as an independent partial-selection hold.
- The guide section states that saved-guide readiness is unavailable and does not expose **Prepare current record**. An already persisted preparation/draft, if returned by the native owner, remains visible as its own record state.
- Open the existing detailed review link; it remains beneath `/dev-fixtures/prospect-research/SYN-CRM-FIRSTSEND-ORG-rNNN`.
- At desktop, tablet, and mobile widths, confirm no horizontal clipping and that venue/thread selection remains reachable by keyboard.

The page has no route for real organization or venue IDs: its data and sales adapters reject those values before the reader or sales workflow is invoked. No successful render establishes authenticated CRM, guide, model, mailbox, provider, or send behavior.
