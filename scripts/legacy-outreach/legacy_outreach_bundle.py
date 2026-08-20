#!/usr/bin/env python3
"""Read-only exporter and reconciler for the retired PathFinder Outreach ledger.

The source database is always opened with SQLite ``mode=ro`` and
``PRAGMA query_only``.  The exporter produces a deterministic, provider-neutral
NDJSON bundle.  It deliberately does not connect to Postgres: applying a bundle
is a separate reviewed Torchiko domain action.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import sqlite3
import sys
import uuid
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Sequence


BUNDLE_VERSION = "torchiko.legacy-outreach-bundle/v1"
LEGACY_SYSTEM = "pathfinder-outreach-sqlite"
ID_NAMESPACE = uuid.UUID("a560c122-a6f2-5f4a-9c4e-b602e385fd53")

TABLE_PRIMARY_KEYS: dict[str, tuple[str, ...]] = {
    "schema_meta": ("key",),
    "prospects": ("id",),
    "contacts": ("id",),
    "templates": ("id",),
    "campaigns": ("id",),
    "campaign_prospects": ("id",),
    "drafts": ("id",),
    "interactions": ("id",),
    "followups": ("id",),
    "send_batches": ("id",),
    "send_batch_items": ("id",),
    "audit_log": ("id",),
    "agent_runs": ("id",),
    "agent_questions": ("id",),
    "agent_question_messages": ("id",),
    "agent_resume_dispatches": ("id",),
}

REQUIRED_COLUMNS: dict[str, set[str]] = {
    "prospects": {"id", "territory", "venue_name", "city", "state", "raw_json", "source_fingerprint"},
    "contacts": {"id", "prospect_id", "email", "do_not_contact"},
    "templates": {"id", "name", "purpose", "source_fingerprint"},
    "campaigns": {"id", "name", "selection_json", "status"},
    "campaign_prospects": {"id", "campaign_id", "prospect_id", "stage"},
    "drafts": {"id", "campaign_prospect_id", "subject", "body", "status"},
    "interactions": {"id", "prospect_id", "direction", "occurred_at", "interaction_type"},
    "followups": {"id", "campaign_prospect_id", "due_at", "status"},
    "send_batches": {"id", "name", "status"},
    "send_batch_items": {"id", "send_batch_id", "draft_id", "status"},
    "audit_log": {"id", "actor", "action", "entity_type", "entity_id", "detail_json"},
}

KIND_BY_TABLE = {
    "prospects": "legacy-prospect-source",
    "contacts": "prospect-contact",
    "templates": "legacy-outreach-template",
    "campaigns": "outreach-campaign",
    "campaign_prospects": "campaign-member",
    "drafts": "outreach-draft",
    "interactions": "correspondence-activity",
    "followups": "prospect-followup",
    "send_batches": "send-batch",
    "send_batch_items": "send-item",
    "audit_log": "legacy-audit-event",
    "agent_runs": "agent-run",
    "agent_questions": "agent-question",
    "agent_question_messages": "agent-question-message",
    "agent_resume_dispatches": "agent-resume-dispatch",
}


class MigrationError(RuntimeError):
    pass


def _jsonable(value: Any) -> Any:
    if isinstance(value, bytes):
        return {"$base64": base64.b64encode(value).decode("ascii")}
    return value


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=_jsonable)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_json(value: Any) -> str:
    return sha256_bytes(canonical_json(value).encode("utf-8"))


def stable_id(kind: str, legacy_id: str | int) -> str:
    return str(uuid.uuid5(ID_NAMESPACE, f"{LEGACY_SYSTEM}:{kind}:{legacy_id}"))


def source_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def assert_checkpointed_source(path: Path) -> None:
    wal_path = path.with_name(path.name + "-wal")
    if wal_path.exists() and wal_path.stat().st_size > 0:
        raise MigrationError(
            "source has a non-empty WAL; make a checkpointed filesystem copy before inventory/export"
        )


def open_read_only(path: Path) -> sqlite3.Connection:
    resolved = path.expanduser().resolve(strict=True)
    if not resolved.is_file() or resolved.stat().st_size == 0:
        raise MigrationError(f"source is not a non-empty SQLite file: {resolved}")
    assert_checkpointed_source(resolved)
    uri = f"file:{resolved.as_posix()}?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only = ON")
    if int(connection.execute("PRAGMA query_only").fetchone()[0]) != 1:
        connection.close()
        raise MigrationError("SQLite read-only enforcement failed")
    return connection


def quote_identifier(name: str) -> str:
    if name not in TABLE_PRIMARY_KEYS:
        raise MigrationError(f"unexpected table name: {name}")
    return '"' + name.replace('"', '""') + '"'


def table_names(connection: sqlite3.Connection) -> list[str]:
    return [
        str(row[0])
        for row in connection.execute(
            "SELECT name FROM sqlite_master "
            "WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
    ]


def table_columns(connection: sqlite3.Connection, table: str) -> list[str]:
    return [str(row[1]) for row in connection.execute(f"PRAGMA table_info({quote_identifier(table)})")]


def validate_schema(connection: sqlite3.Connection) -> dict[str, list[str]]:
    names = table_names(connection)
    unexpected = sorted(set(names) - set(TABLE_PRIMARY_KEYS))
    if unexpected:
        raise MigrationError(f"unreviewed legacy tables present: {', '.join(unexpected)}")
    missing_tables = sorted(set(REQUIRED_COLUMNS) - set(names))
    if missing_tables:
        raise MigrationError(f"required legacy tables missing: {', '.join(missing_tables)}")
    columns = {table: table_columns(connection, table) for table in names}
    problems: list[str] = []
    for table, required in REQUIRED_COLUMNS.items():
        missing = sorted(required - set(columns[table]))
        if missing:
            problems.append(f"{table}: {', '.join(missing)}")
    if problems:
        raise MigrationError("required legacy columns missing: " + "; ".join(problems))
    integrity = str(connection.execute("PRAGMA integrity_check").fetchone()[0])
    if integrity != "ok":
        raise MigrationError(f"SQLite integrity_check failed: {integrity}")
    return columns


def iter_rows(connection: sqlite3.Connection, table: str) -> Iterator[dict[str, Any]]:
    keys = TABLE_PRIMARY_KEYS[table]
    order = ", ".join(quote_column(key) for key in keys)
    for row in connection.execute(f"SELECT * FROM {quote_identifier(table)} ORDER BY {order}"):
        yield {key: _jsonable(row[key]) for key in row.keys()}


def quote_column(name: str) -> str:
    if not name.replace("_", "").isalnum():
        raise MigrationError(f"unsafe column name: {name}")
    return '"' + name.replace('"', '""') + '"'


def table_digest(rows: Iterable[Mapping[str, Any]]) -> str:
    digest = hashlib.sha256()
    for row in rows:
        digest.update(canonical_json(row).encode("utf-8"))
        digest.update(b"\n")
    return digest.hexdigest()


def _scalar(connection: sqlite3.Connection, query: str) -> int:
    return int(connection.execute(query).fetchone()[0])


def build_inventory(path: Path, connection: sqlite3.Connection) -> dict[str, Any]:
    columns = validate_schema(connection)
    names = table_names(connection)
    counts = {table: _scalar(connection, f"SELECT COUNT(*) FROM {quote_identifier(table)}") for table in names}
    table_hashes = {table: table_digest(iter_rows(connection, table)) for table in names}
    schema_rows = [
        dict(row)
        for row in connection.execute(
            "SELECT type, name, tbl_name, sql FROM sqlite_master "
            "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
        )
    ]
    foreign_key_violations = [dict(row) for row in connection.execute("PRAGMA foreign_key_check")]
    schema_version_row = connection.execute(
        "SELECT value FROM schema_meta WHERE key='schema_version'"
    ).fetchone()
    legacy_data_rows = sum(count for table, count in counts.items() if table != "schema_meta")
    return {
        "format": "torchiko.legacy-outreach-inventory/v1",
        "legacySystem": LEGACY_SYSTEM,
        "databaseSha256": source_sha256(path),
        "databaseSizeBytes": path.stat().st_size,
        "schemaVersion": str(schema_version_row[0]) if schema_version_row else None,
        "schemaSha256": sha256_json(schema_rows),
        "tables": {
            table: {
                "columns": columns[table],
                "rowCount": counts[table],
                "contentSha256": table_hashes[table],
            }
            for table in names
        },
        "foreignKeyViolationCount": len(foreign_key_violations),
        "derived": {
            "legacyDataRows": legacy_data_rows,
            "mappedLegacyRows": legacy_data_rows,
            "unmappedLegacyRows": 0,
            "metadataRowsNotEmittedAsRecords": counts.get("schema_meta", 0),
            "orphanContacts": _scalar(connection, "SELECT COUNT(*) FROM contacts c LEFT JOIN prospects p ON p.id=c.prospect_id WHERE p.id IS NULL"),
            "duplicateNormalizedEmails": _scalar(connection, "SELECT COUNT(*) FROM (SELECT lower(trim(email)) e FROM contacts WHERE trim(email)<>'' GROUP BY e HAVING COUNT(*)>1)"),
            "duplicateSourceFingerprints": _scalar(connection, "SELECT COUNT(*) FROM (SELECT source_fingerprint FROM prospects GROUP BY source_fingerprint HAVING COUNT(*)>1)"),
            "duplicateNormalizedDomains": _scalar(connection, "SELECT COUNT(*) FROM (SELECT lower(trim(replace(replace(website,'https://',''),'http://',''))) d FROM prospects WHERE trim(COALESCE(website,''))<>'' GROUP BY d HAVING COUNT(*)>1)"),
            "doNotContactContacts": _scalar(connection, "SELECT COUNT(*) FROM contacts WHERE do_not_contact=1"),
            "inactiveProspects": _scalar(connection, "SELECT COUNT(*) FROM prospects WHERE active=0"),
            "prospectsWithoutExplicitContacts": _scalar(connection, "SELECT COUNT(*) FROM prospects p WHERE NOT EXISTS (SELECT 1 FROM contacts c WHERE c.prospect_id=p.id)"),
            "prospectsWithMultipleExplicitContacts": _scalar(connection, "SELECT COUNT(*) FROM (SELECT prospect_id FROM contacts GROUP BY prospect_id HAVING COUNT(*)>1)"),
        },
    }


def legacy_meta(database_hash: str, table: str, legacy_id: Any, row: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "system": LEGACY_SYSTEM,
        "databaseSha256": database_hash,
        "table": table,
        "id": str(legacy_id),
        "rowSha256": sha256_json(row),
    }


def mapped_record(
    kind: str,
    database_hash: str,
    table: str,
    legacy_id: Any,
    data: Mapping[str, Any],
    *,
    links: Mapping[str, str] | None = None,
    source_row: Mapping[str, Any] | None = None,
    record_identity: Any | None = None,
) -> dict[str, Any]:
    return {
        "bundleVersion": BUNDLE_VERSION,
        "kind": kind,
        "id": stable_id(kind, legacy_id if record_identity is None else record_identity),
        "legacy": legacy_meta(database_hash, table, legacy_id, source_row or data),
        "links": dict(sorted((links or {}).items())),
        "data": dict(data),
    }


def prospect_records(
    database_hash: str,
    row: Mapping[str, Any],
    explicit_contact_emails: set[str],
) -> Iterator[dict[str, Any]]:
    legacy_id = row["id"]
    organization_id = stable_id("prospect-organization", legacy_id)
    venue_id = stable_id("prospect-venue", legacy_id)
    opportunity_id = stable_id("prospect-opportunity", legacy_id)
    provenance = legacy_meta(database_hash, "prospects", legacy_id, row)
    organization = {
        "canonicalName": row.get("venue_name"),
        "website": row.get("website"),
        "territoryName": row.get("territory"),
        "source": LEGACY_SYSTEM,
        "prioritySourceValue": row.get("outreach_priority"),
        "relationshipTierSourceValue": row.get("estimated_value_tier"),
        "archived": not bool(row.get("active")),
        "legacyProvenance": provenance,
    }
    yield {
        "bundleVersion": BUNDLE_VERSION,
        "kind": "prospect-organization",
        "id": organization_id,
        "legacy": provenance,
        "links": {"venueId": venue_id, "opportunityId": opportunity_id},
        "data": organization,
    }
    venue = {
        "organizationId": organization_id,
        "name": row.get("venue_name"),
        "venueType": row.get("venue_type"),
        "venueSubtype": row.get("venue_subtype"),
        "city": row.get("city"),
        "region": row.get("state"),
        "website": row.get("website"),
        "phone": row.get("phone"),
        "fitSource": {
            "score": row.get("pathfinder_fit_score"),
            "personalizationHook": row.get("personalization_hook"),
            "researchConfidence": row.get("research_confidence"),
            "researchDate": row.get("research_date"),
        },
        "sourceUrls": row.get("source_urls"),
        "sourceFingerprint": row.get("source_fingerprint"),
        "rawSourceJson": row.get("raw_json"),
        "archived": not bool(row.get("active")),
    }
    yield mapped_record(
        "prospect-venue",
        database_hash,
        "prospects",
        legacy_id,
        venue,
        links={"organizationId": organization_id},
        source_row=row,
    )
    yield mapped_record(
        "prospect-opportunity",
        database_hash,
        "prospects",
        legacy_id,
        {
            "organizationId": organization_id,
            "stage": "DISCOVERED",
            "ownerDisplayName": row.get("owner_name"),
            "prioritySourceValue": row.get("outreach_priority"),
            "source": LEGACY_SYSTEM,
        },
        links={"organizationId": organization_id},
        source_row=row,
    )
    embedded_candidates = (
        (
            "general_email",
            row.get("general_email"),
            None,
            None,
            "general",
        ),
        (
            "contact_email",
            row.get("contact_email"),
            row.get("contact_name"),
            row.get("contact_title"),
            "named",
        ),
    )
    emitted: set[str] = set()
    for source_field, raw_email, name, title, email_type in embedded_candidates:
        email = str(raw_email or "").strip()
        normalized = email.casefold()
        if not normalized or normalized in explicit_contact_emails or normalized in emitted:
            continue
        emitted.add(normalized)
        synthetic_legacy_id = f"{legacy_id}:{source_field}"
        record = mapped_record(
            "prospect-contact",
            database_hash,
            "prospects",
            legacy_id,
            {
                "organizationId": organization_id,
                "venueId": venue_id,
                "fullName": name,
                "title": title,
                "email": email,
                "emailType": email_type,
                "source": LEGACY_SYSTEM,
                "sourceField": source_field,
                "readiness": "UNKNOWN_REQUIRES_REVIEW",
                "doNotContact": False,
            },
            links={"organizationId": organization_id, "venueId": venue_id},
            source_row=row,
            record_identity=synthetic_legacy_id,
        )
        record["legacy"]["sourceField"] = source_field
        yield record


def record_links(table: str, row: Mapping[str, Any]) -> dict[str, str]:
    links: dict[str, str] = {}
    prospect_id = row.get("prospect_id")
    if prospect_id is not None:
        links["organizationId"] = stable_id("prospect-organization", prospect_id)
        links["venueId"] = stable_id("prospect-venue", prospect_id)
    campaign_id = row.get("campaign_id")
    if campaign_id is not None:
        links["campaignId"] = stable_id("outreach-campaign", campaign_id)
    campaign_prospect_id = row.get("campaign_prospect_id")
    if campaign_prospect_id is not None:
        links["campaignMemberId"] = stable_id("campaign-member", campaign_prospect_id)
    send_batch_id = row.get("send_batch_id")
    if send_batch_id is not None:
        links["sendBatchId"] = stable_id("send-batch", send_batch_id)
    draft_id = row.get("draft_id")
    if draft_id is not None:
        links["draftId"] = stable_id("outreach-draft", draft_id)
    run_id = row.get("run_id")
    if run_id is not None:
        links["agentRunId"] = stable_id("agent-run", run_id)
    question_id = row.get("question_id")
    if question_id is not None:
        links["agentQuestionId"] = stable_id("agent-question", question_id)
    return links


def iter_bundle_records(connection: sqlite3.Connection, database_hash: str) -> Iterator[dict[str, Any]]:
    explicit_by_prospect: dict[str, set[str]] = {}
    for row in connection.execute("SELECT prospect_id, email FROM contacts ORDER BY prospect_id, id"):
        normalized = str(row["email"] or "").strip().casefold()
        if normalized:
            explicit_by_prospect.setdefault(str(row["prospect_id"]), set()).add(normalized)
    for row in iter_rows(connection, "prospects"):
        yield from prospect_records(
            database_hash,
            row,
            explicit_by_prospect.get(str(row["id"]), set()),
        )
    for table in TABLE_PRIMARY_KEYS:
        if table in {"schema_meta", "prospects"} or table not in table_names(connection):
            continue
        kind = KIND_BY_TABLE[table]
        for row in iter_rows(connection, table):
            legacy_id = row[TABLE_PRIMARY_KEYS[table][0]]
            yield mapped_record(kind, database_hash, table, legacy_id, row, links=record_links(table, row))


def write_bundle(source: Path, output_dir: Path) -> dict[str, Any]:
    output = output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    records_path = output / "records.ndjson"
    manifest_path = output / "manifest.json"
    if records_path.exists() or manifest_path.exists():
        raise MigrationError("output directory already contains a legacy migration bundle")
    source_before = source_sha256(source)
    with open_read_only(source) as connection:
        inventory = build_inventory(source, connection)
        digest = hashlib.sha256()
        counts: dict[str, int] = {}
        with records_path.open("wb") as destination:
            for record in iter_bundle_records(connection, inventory["databaseSha256"]):
                line = canonical_json(record).encode("utf-8") + b"\n"
                destination.write(line)
                digest.update(line)
                counts[record["kind"]] = counts.get(record["kind"], 0) + 1
    assert_checkpointed_source(source)
    if source_sha256(source) != source_before:
        raise MigrationError("source database changed during export; discard the bundle and retry from a safe copy")
    manifest = {
        "bundleVersion": BUNDLE_VERSION,
        "legacySystem": LEGACY_SYSTEM,
        "sourceInventory": inventory,
        "recordCounts": dict(sorted(counts.items())),
        "recordsSha256": digest.hexdigest(),
        "recordFile": records_path.name,
        "applyPolicy": "reviewed-postgres-domain-actions-only",
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return manifest


def reconcile(source: Path, bundle_dir: Path) -> dict[str, Any]:
    manifest_path = bundle_dir / "manifest.json"
    records_path = bundle_dir / "records.ndjson"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("bundleVersion") != BUNDLE_VERSION:
        raise MigrationError("unsupported bundle version")
    with open_read_only(source) as connection:
        current = build_inventory(source, connection)
    expected = manifest.get("sourceInventory")
    if current != expected:
        raise MigrationError("source inventory no longer matches the exported bundle")
    digest = hashlib.sha256()
    observed_counts: dict[str, int] = {}
    observed_ids: set[str] = set()
    with records_path.open("rb") as records:
        for raw_line in records:
            digest.update(raw_line)
            record = json.loads(raw_line)
            if record.get("bundleVersion") != BUNDLE_VERSION:
                raise MigrationError("record has unsupported bundle version")
            record_id = str(record.get("id"))
            if record_id in observed_ids:
                raise MigrationError(f"duplicate deterministic record id: {record_id}")
            observed_ids.add(record_id)
            kind = str(record.get("kind"))
            observed_counts[kind] = observed_counts.get(kind, 0) + 1
            legacy = record.get("legacy", {})
            if legacy.get("databaseSha256") != current["databaseSha256"]:
                raise MigrationError("record provenance does not match source database")
    if digest.hexdigest() != manifest.get("recordsSha256"):
        raise MigrationError("records.ndjson hash does not match manifest")
    if dict(sorted(observed_counts.items())) != manifest.get("recordCounts"):
        raise MigrationError("record counts do not match manifest")
    return {
        "format": "torchiko.legacy-outreach-reconciliation/v1",
        "ok": True,
        "databaseSha256": current["databaseSha256"],
        "recordsSha256": digest.hexdigest(),
        "sourceTableCounts": {name: detail["rowCount"] for name, detail in current["tables"].items()},
        "recordCounts": dict(sorted(observed_counts.items())),
        "foreignKeyViolationCount": current["foreignKeyViolationCount"],
        "derived": current["derived"],
    }


def emit(value: Any, output: Path | None) -> None:
    rendered = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if output:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(rendered, encoding="utf-8")
    else:
        sys.stdout.write(rendered)


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    inventory_parser = subparsers.add_parser("inventory", help="inspect a ledger without exporting personal data")
    inventory_parser.add_argument("--source", required=True, type=Path)
    inventory_parser.add_argument("--output", type=Path)
    export_parser = subparsers.add_parser("export", help="create a deterministic reviewed-migration bundle")
    export_parser.add_argument("--source", required=True, type=Path)
    export_parser.add_argument("--output-dir", required=True, type=Path)
    reconcile_parser = subparsers.add_parser("reconcile", help="verify a bundle against its immutable source")
    reconcile_parser.add_argument("--source", required=True, type=Path)
    reconcile_parser.add_argument("--bundle-dir", required=True, type=Path)
    reconcile_parser.add_argument("--output", type=Path)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    try:
        if args.command == "inventory":
            with open_read_only(args.source) as connection:
                emit(build_inventory(args.source.resolve(), connection), args.output)
        elif args.command == "export":
            emit(write_bundle(args.source.resolve(), args.output_dir), None)
        elif args.command == "reconcile":
            emit(reconcile(args.source.resolve(), args.bundle_dir.resolve()), args.output)
        else:  # pragma: no cover - argparse enforces this
            raise MigrationError(f"unknown command: {args.command}")
    except (MigrationError, OSError, sqlite3.DatabaseError, json.JSONDecodeError) as error:
        sys.stderr.write(f"legacy outreach migration error: {error}\n")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
