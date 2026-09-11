ALTER TABLE "venues"
  ADD COLUMN "chat_show_photos" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "chat_show_links" BOOLEAN NOT NULL DEFAULT false;
