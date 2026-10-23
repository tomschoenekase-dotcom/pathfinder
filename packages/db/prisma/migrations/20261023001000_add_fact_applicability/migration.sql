-- Declarations belong to an immutable fact revision. Existing facts remain unknown.
ALTER TABLE operational_fact_content
  ADD COLUMN applicability_scope text NULL,
  ADD COLUMN applicability_subject_module_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN applicability_place_ids text[] NOT NULL DEFAULT '{}';

-- CHECK expressions cannot contain subqueries. Keep array validation explicit and
-- fail closed for SQL NULL elements, duplicates, noncanonical dimensions and blanks.
CREATE FUNCTION operational_fact_applicability_ids_valid(ids text[])
RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT (
    cardinality(ids) BETWEEN 0 AND 50
    AND (cardinality(ids) = 0 OR (array_ndims(ids) = 1 AND array_lower(ids, 1) = 1))
    AND NOT EXISTS (SELECT 1 FROM unnest(ids) AS target(id) WHERE id IS NULL OR btrim(id) = '')
    AND cardinality(ids) = (SELECT count(DISTINCT id) FROM unnest(ids) AS target(id))
  ) IS TRUE
$$;

ALTER TABLE operational_fact_content
  ADD CONSTRAINT operational_fact_applicability_shape_check CHECK ((
    CASE
      WHEN applicability_scope IS NULL OR applicability_scope = 'VENUE' THEN
        cardinality(applicability_subject_module_ids) = 0
        AND cardinality(applicability_place_ids) = 0
      WHEN applicability_scope = 'SUBJECTS' THEN
        cardinality(applicability_subject_module_ids) + cardinality(applicability_place_ids) > 0
      ELSE false
    END
    AND operational_fact_applicability_ids_valid(applicability_subject_module_ids)
    AND operational_fact_applicability_ids_valid(applicability_place_ids)
  ) IS TRUE);

-- Existing append-only and no-truncate triggers remain in force for the new columns.
