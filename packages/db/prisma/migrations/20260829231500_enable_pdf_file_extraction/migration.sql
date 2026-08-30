-- PDF extraction extends the existing append-only exact-file receipt. It remains provider-free,
-- review-only evidence and grants no package, approval, apply, publication, or contact authority.

ALTER TABLE "intake_file_extraction_receipts"
  DROP CONSTRAINT "intake_file_extraction_receipts_source_check";

ALTER TABLE "intake_file_extraction_receipts"
  ADD CONSTRAINT "intake_file_extraction_receipts_source_check" CHECK (
    "source_byte_size" BETWEEN 1 AND 10485760 AND
    "source_mime_type" IN (
      'application/json',
      'application/pdf',
      'text/plain',
      'text/markdown',
      'text/csv'
    ) AND
    (
      ("source_mime_type" = 'application/pdf' AND "extractor" = 'pathfinder-pdfjs-document') OR
      (
        "source_mime_type" <> 'application/pdf' AND
        "source_byte_size" <= 2097152 AND
        "extractor" = 'pathfinder-utf8-document'
      )
    )
  );
