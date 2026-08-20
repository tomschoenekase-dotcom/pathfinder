# Prospect-to-customer conversion

## Contract

Conversion is an explicit platform-admin operation that runs after the existing retry-safe customer/venue creation action succeeds. It creates one `ProspectConversion` record linking:

- the immutable prospect organization;
- an optional prospect venue/location;
- the new customer `Tenant`;
- an optional live customer `Venue`;
- the authenticated human actor, timestamp, and request evidence.

The source prospect, contacts, activities, source evidence, import history, and duplicate decisions remain in the CRM. Conversion does not rename, delete, or repurpose `ProspectVenue` as `Venue`.

## Operator flow

1. Open a prospect detail page.
2. Select **Convert to customer**. The existing create-client form opens with client name, venue name, primary email, prospect organization ID, and prospect venue ID prefilled.
3. Confirm the customer and venue details. Customer creation still uses the existing `createClientAndVenue` request identity and invitation behavior.
4. After that action succeeds, `linkProspectConversion` validates that the live venue belongs to the new tenant and that the prospect venue belongs to the prospect.
5. The conversion action creates the unique link, moves the opportunity to `WON`, appends stage history, appends a `CONVERTED_TO_CUSTOMER` activity, and writes the strict audit log.
6. The operator is impersonated into the new customer workspace using the existing onboarding flow.

## Retry and conflict behavior

Repeating the same prospect-to-tenant-and-venue link returns the existing conversion with `replayed: true`. Attempting to link the prospect to a different tenant or venue fails with a conflict. The database also enforces one conversion per prospect, one source prospect venue per conversion, one target tenant per conversion, and one target live venue per conversion.

The customer creation call runs first and is already retry-safe through its request ID. If the conversion link fails after customer creation, the form retains that request ID for a retry; customer creation replays and the conversion is attempted again. Operators should investigate any conflict rather than creating another customer workspace.

## What conversion does not do

- It does not send invitations beyond the existing customer-creation behavior.
- It does not send prospect outreach or copy a prospect contact into an unreviewed mailing list.
- It does not delete or merge prospect records.
- It does not make platform research visible in the client portal.
- It does not backfill customer analytics, billing, deployment, or Golden Venue data.

Any future contact-copy or communications activation must be a separate reviewed domain action that enforces consent, suppression, do-not-contact, and tenant visibility rules.

## Verification expectations

Before release, verify the database migration on a disposable database and run the prospect CRM lifecycle test. That test proves one conversion, same-target replay, a single `WON` transition, and a single conversion activity. The dashboard conversion test proves prefill and the exact link request derived from the created tenant/venue.
