CREATE TYPE "VenueBotResponseDepth" AS ENUM ('BRIEF', 'BALANCED', 'DETAILED');

ALTER TABLE "venue_bot_configurations"
ADD COLUMN "response_depth" "VenueBotResponseDepth" NOT NULL DEFAULT 'BALANCED';
