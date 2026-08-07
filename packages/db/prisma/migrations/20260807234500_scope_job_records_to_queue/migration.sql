CREATE UNIQUE INDEX "job_records_queue_bull_job_id_key"
ON "job_records"("queue", "bull_job_id");
