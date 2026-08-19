-- Add the normalized dimensions used by the bounded custom-personality contract.
-- Legacy verbosity/humor columns remain for forward compatibility; new code
-- reads and writes only warmth/brevity/energy/formality on a 0..100 scale.
ALTER TABLE "personality_profiles"
  ADD COLUMN "brevity" INTEGER NOT NULL DEFAULT 50,
  ADD COLUMN "energy" INTEGER NOT NULL DEFAULT 50;

-- The immediately preceding foundation used a temporary 1..5 scale. Preserve
-- relative intent while moving those two shared columns onto the canonical
-- normalized scale.
UPDATE "personality_profiles"
SET "warmth" = ("warmth" - 1) * 25
WHERE "warmth" BETWEEN 1 AND 5;

UPDATE "personality_profiles"
SET "formality" = ("formality" - 1) * 25
WHERE "formality" BETWEEN 1 AND 5;

ALTER TABLE "personality_profiles"
  ALTER COLUMN "warmth" SET DEFAULT 50,
  ALTER COLUMN "formality" SET DEFAULT 50;

ALTER TABLE "personality_profiles"
  ADD CONSTRAINT "personality_profiles_normalized_dimensions_check"
  CHECK (
    "warmth" BETWEEN 0 AND 100 AND
    "brevity" BETWEEN 0 AND 100 AND
    "energy" BETWEEN 0 AND 100 AND
    "formality" BETWEEN 0 AND 100
  );
