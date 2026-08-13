-- PostgreSQL requires a newly added enum value to be committed before the next
-- migration can use it in defaults, checks, and typed sidecar constraints.
ALTER TYPE "NormalizedContentModuleKind" ADD VALUE IF NOT EXISTS 'ITEM' BEFORE 'SERVICE';
