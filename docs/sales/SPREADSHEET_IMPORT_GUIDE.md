# Spreadsheet import guide

## Current safe boundary

CSV/XLSX mapping and dry-run review are internal platform-admin surfaces. Limits are 25 MB raw input, 150 MB server-inspected expanded content, 100 sheets, 100,000 total rows, 100 columns, 10,000 characters per cell, and 256 KB per row. Values are inert untrusted data; formula-like content is never executed and CSV downloads neutralize formulas.

The immutable source is checksum-uploaded to private versioned object storage. Durable workers own inspection, staging, duplicate analysis, append-only report creation, and commit; the browser only maps, reviews, approves, and observes. Job and row leases make worker restart and cross-replica claims recoverable.

## Real-workbook blocker

Do not import the real workbook yet. Remaining gaps:

- end-to-end disposable S3/Postgres rehearsal of the new raw-upload path;
- archive/repair implementation and rehearsal;
- representative database query-plan and wall-clock evidence;
- Tom's review of the real workbook dry run.

`CRM_IMPORT_SCALE_STATUS.md` records implemented limits, 20,000-row synthetic coverage, paging/search changes, and exact remaining work.

After hardening: upload/map; dry run; review every warning and duplicate disposition; inspect reconciliation; obtain Tom's approval; queue worker commit while delivery remains disabled. Preserve the source workbook and never auto-merge. No real workbook row was imported in this pass.
