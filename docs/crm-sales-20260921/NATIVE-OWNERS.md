# Native owners: local PREPARE / REVIEW / STATE

This is the first integrated sales slice on the accepted CRM branch, not a new CRM.
Inspection started at `aace14ae6ee8bc87b8556dcdfda208004d20c87d` and used
`docs/crm-research-20260921/SALES-COMPONENT-INTEGRATION.md`, actual Prisma schema,
native action helpers, and the original vault component implementations.

| Capability                                  | Existing owner retained                                                                                       | Integration decision                                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prospect, venue, contact and import lineage | `ProspectOrganization`, `ProspectVenue`, `ProspectContact`, `ProspectImportSourceRecord`                      | Read existing IDs and all original source cells. No import, identity replacement or contact promotion.                                                     |
| Source / research evidence                  | `ProspectSourceEvidence`                                                                                      | Append derived `CRM_SALES_PREPARATION_V1` writing-context snapshots; explicitly not new website/contact verification. Original evidence remains unchanged. |
| Draft identity and revisions                | `ProspectOutreachDraft`                                                                                       | Add a mutually exclusive non-campaign preparation mode to this existing owner. No second draft table.                                                      |
| Campaign approval                           | Existing `reviewProspectOutreachDraftAction`, draft approval fields                                           | Reject local preparation drafts. Never set `APPROVED`, `approvedBy` or `approvedAt`.                                                                       |
| Operator read-review                        | Append-only `ProspectActivity`                                                                                | Exact draft ID/hash/version review receipt; never an email-send approval or semantic certification.                                                        |
| Frozen recipients and delivery              | `ProspectSendItem`, `ProspectSendBatch`, `ProspectSendOutbox`                                                 | Remain empty. Native API checks and a database trigger reject preparation drafts before frozen-recipient creation.                                         |
| Provider/thread/message identity            | `CorrespondenceProviderAccount`, `ProspectEmailThread`, `ProspectEmailThreadProvider`, `ProspectEmailMessage` | Only explicitly synthetic local history on one disabled `FAKE` provider. No provider adapter or connection.                                                |
| Human inbound classification review         | `ProspectInboundReplyReview`                                                                                  | Untouched. Reducer projections do not impersonate human classification/review.                                                                             |
| Suppression                                 | Native contactability fields, `ProspectContactSuppressionEvent`, opportunity/archival state                   | Reuse native projections and the native suppression writer for the isolated hold fixture. No second suppression ledger.                                    |
| Follow-up                                   | `ProspectFollowup`                                                                                            | Retained and zero; no scheduler or follow-up executor added.                                                                                               |

## Proven schema gap and the one migration

Before this change, `ProspectOutreachDraft` required a campaign, campaign member and
email recipient. A form route or UNKNOWN contact could not have a native non-campaign
writing revision without inventing delivery ownership. The additive migration
`20260921050000_native_sales_no_send` therefore:

- makes campaign/member/email nullable only under a disjoint owner-mode CHECK;
- adds `preparation_key` plus unique `(preparation_key, version)` and lookup index;
- fixes local status to `NEEDS_REVIEW`, requires native venue and false send authority;
- prevents updating/deleting local revisions, changing their mode, or approving them;
- rejects their insertion into frozen send items;
- protects derived preparation snapshots and exact review activities from mutation.

No tables were added. The migration was applied only to the retained local database
through the guarded launcher. Existing campaign draft behavior remains separately
owned, with focused regression tests. This is not production migration authorization.

## Native suppression precedence

Archived organizations/venues, parked/do-not-contact/lost opportunity state, and
native contact do-not-contact/prohibited/opt-out/suppression/complaint/hard-bounce
state are checked before preparation. Candidate and normalized-address holds are
conservatively venue-blocking in this slice.

A verified public routing snapshot can differ from the workbook's candidate email.
Its exact email is therefore checked against the native address-wide contactability
projection **before Composer** and again inside each Serializable write/review
transaction. The adapter does not bypass a hold by switching contacts or routes.

The one added hold organization/venue/contact is clearly named SYNTHETIC, uses an
`example.invalid` address and the existing suppression action. Original contact
records and their UNKNOWN readiness/permission remain byte-identical.
