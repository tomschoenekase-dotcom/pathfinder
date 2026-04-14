-- AlterTable
ALTER TABLE "venues"
  ADD COLUMN "ai_featured_place_id" TEXT,
  ADD COLUMN "ai_guide_notes" TEXT,
  ADD COLUMN "ai_tone" TEXT DEFAULT 'FRIENDLY';
