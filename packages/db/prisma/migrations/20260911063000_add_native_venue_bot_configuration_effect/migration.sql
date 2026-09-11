-- Native publication already records and reverts bot configuration separately
-- from venue content. Preserve those effect semantics in the database enum.
ALTER TYPE "NativeVenueDeploymentEffectKind" ADD VALUE 'VENUE_BOT_CONFIGURATION';
