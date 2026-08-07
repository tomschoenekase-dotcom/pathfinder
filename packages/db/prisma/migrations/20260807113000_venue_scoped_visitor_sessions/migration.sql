-- Expand phase: add the venue-scoped identity used by the new application
-- while retaining the global anonymous-token unique index for rolling-deploy
-- compatibility with old instances. Drop the old index only in a later,
-- separately verified contract migration after every service runs new code.
CREATE UNIQUE INDEX "visitor_sessions_venue_id_anonymous_token_key"
ON "visitor_sessions"("venue_id", "anonymous_token");
