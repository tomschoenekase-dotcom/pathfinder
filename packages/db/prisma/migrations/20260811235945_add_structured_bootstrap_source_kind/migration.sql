-- PostgreSQL requires a newly added enum value to be committed before later
-- constraints may reference it. Keep this migration separate from the intake
-- table changes in 20260811235950_add_onboarding_bootstrap_intake.
ALTER TYPE "IntakeSourceKind" ADD VALUE IF NOT EXISTS 'STRUCTURED_BOOTSTRAP';
