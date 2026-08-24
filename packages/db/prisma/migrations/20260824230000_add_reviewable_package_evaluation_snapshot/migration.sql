-- Reviewable DRAFT and APPROVED packages need a truthful discriminator so evaluation can run
-- before lifecycle approval without pretending that a draft is client-approved.
ALTER TYPE "EvalContentSnapshotKind" ADD VALUE IF NOT EXISTS 'REVIEWABLE_VENUE_PACKAGE_V1';
