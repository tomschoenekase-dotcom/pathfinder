-- An evaluation can now freeze and execute against the exact approved client package
-- reviewed during remote onboarding, without reading later live venue content.
ALTER TYPE "EvalContentSnapshotKind" ADD VALUE IF NOT EXISTS 'APPROVED_VENUE_PACKAGE_V1';
