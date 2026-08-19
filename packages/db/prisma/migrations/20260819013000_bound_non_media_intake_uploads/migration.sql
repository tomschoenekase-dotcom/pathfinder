BEGIN;

ALTER TABLE "intake_uploads"
  ADD CONSTRAINT "intake_uploads_transport_size_check" CHECK (
    (
      "mime_type" IN (
        'video/mp4',
        'video/quicktime',
        'video/webm',
        'audio/mpeg',
        'audio/mp4',
        'audio/wav',
        'audio/webm'
      ) AND "byte_size" BETWEEN 1 AND 2000000000
    ) OR (
      "mime_type" NOT IN (
        'video/mp4',
        'video/quicktime',
        'video/webm',
        'audio/mpeg',
        'audio/mp4',
        'audio/wav',
        'audio/webm'
      ) AND "byte_size" BETWEEN 1 AND 104857600
    )
  );

COMMIT;
