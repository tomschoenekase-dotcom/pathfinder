# Prospect-to-customer conversion

Conversion is a human-only, audited relationship operation. It never replaces or deletes the prospect.

`ProspectCustomerRelationship` connects one prospect organization to one exact customer `Tenant` for a relationship generation. `ProspectLocationConversion` children connect individual `ProspectVenue` locations to exact live `Venue` records and carry the same required tenant scope.

This permits partial conversion, several locations over time, replacement/offboarding history, and revival without duplicating the prospect organization. Unique idempotency keys and relationship/location generation constraints make replay safe without forbidding legitimate later history.

`linkProspectConversionAction` validates that the live venue belongs to the requested tenant and that the prospect venue belongs to the organization. The same active target replays; another location can join the same active relationship. A first conversion moves the canonical opportunity to `WON`, appends stage history and relationship activity, and writes strict audit evidence.

Research, contacts, imports, campaigns, drafts, correspondence, activities, and provenance remain attached to the prospect. Reverse reads from a customer tenant/live venue resolve originating intelligence under exact tenant isolation. Agents cannot convert. Customer creation/invitations stay separate human workflows. Offboarding must not erase prospect or correspondence history.

Disposable database coverage proves two location conversions, same-target replay, exact tenant/venue validation, and retained prospect history.
