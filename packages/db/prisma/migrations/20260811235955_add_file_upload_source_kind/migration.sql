-- PostgreSQL requires a newly added enum value to be committed before later
-- constraints may reference it. Keep this migration separate from the upload
-- table changes in 20260811235960_add_quarantined_intake_upload.
ALTER TYPE "IntakeSourceKind" ADD VALUE IF NOT EXISTS 'FILE_UPLOAD';
