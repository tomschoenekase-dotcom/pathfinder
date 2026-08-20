from __future__ import annotations

import hashlib
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("legacy_outreach_bundle.py")


SCHEMA = """
PRAGMA foreign_keys=ON;
CREATE TABLE schema_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE prospects(
 id TEXT PRIMARY KEY,territory TEXT NOT NULL,venue_name TEXT NOT NULL,venue_type TEXT,
 venue_subtype TEXT,city TEXT NOT NULL,state TEXT NOT NULL,website TEXT,general_email TEXT,
 contact_name TEXT,contact_title TEXT,contact_email TEXT,phone TEXT,owner_name TEXT,
 pathfinder_fit_score REAL,estimated_value_tier TEXT,outreach_priority TEXT,
 recommended_outreach_type TEXT,personalization_hook TEXT,research_confidence TEXT,
 research_date TEXT,source_urls TEXT,raw_json TEXT NOT NULL,source_fingerprint TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1,imported_at TEXT,updated_at TEXT
);
CREATE TABLE contacts(id INTEGER PRIMARY KEY,prospect_id TEXT NOT NULL REFERENCES prospects(id),name TEXT,title TEXT,email TEXT NOT NULL,email_type TEXT,source_url TEXT,confidence TEXT,verified_at TEXT,is_primary INTEGER,do_not_contact INTEGER,created_at TEXT,updated_at TEXT);
CREATE TABLE templates(id TEXT PRIMARY KEY,name TEXT NOT NULL,purpose TEXT NOT NULL,use_when TEXT,tone TEXT,rewrite_strength TEXT,subject_seed TEXT,body_seed TEXT,required_fields_json TEXT,active INTEGER,status TEXT,source_path TEXT,source_fingerprint TEXT NOT NULL,version INTEGER,updated_at TEXT);
CREATE TABLE campaigns(id INTEGER PRIMARY KEY,name TEXT NOT NULL,territory TEXT,purpose TEXT,status TEXT NOT NULL,selection_json TEXT NOT NULL,created_by TEXT,created_at TEXT,updated_at TEXT);
CREATE TABLE campaign_prospects(id INTEGER PRIMARY KEY,campaign_id INTEGER NOT NULL REFERENCES campaigns(id),prospect_id TEXT NOT NULL REFERENCES prospects(id),rank INTEGER,stage TEXT NOT NULL,template_id TEXT,attempt_count INTEGER,last_contact_at TEXT,next_action_at TEXT,outcome TEXT,notes TEXT,created_at TEXT,updated_at TEXT);
CREATE TABLE drafts(id INTEGER PRIMARY KEY,campaign_prospect_id INTEGER NOT NULL REFERENCES campaign_prospects(id),template_id TEXT,subject TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,generated_by TEXT,similarity_to_template REAL,approved_by TEXT,approved_at TEXT,created_at TEXT,updated_at TEXT);
CREATE TABLE interactions(id INTEGER PRIMARY KEY,prospect_id TEXT NOT NULL REFERENCES prospects(id),campaign_id INTEGER,direction TEXT NOT NULL,channel TEXT,interaction_type TEXT NOT NULL,occurred_at TEXT NOT NULL,subject TEXT,summary TEXT,external_id TEXT,created_by TEXT,created_at TEXT);
CREATE TABLE followups(id INTEGER PRIMARY KEY,campaign_prospect_id INTEGER NOT NULL REFERENCES campaign_prospects(id),due_at TEXT NOT NULL,sequence_step INTEGER,reason TEXT,status TEXT NOT NULL,completed_at TEXT,created_by TEXT,created_at TEXT);
CREATE TABLE send_batches(id INTEGER PRIMARY KEY,name TEXT NOT NULL,status TEXT NOT NULL,created_by TEXT,approved_by TEXT,approved_at TEXT,provider TEXT,external_batch_id TEXT,created_at TEXT);
CREATE TABLE send_batch_items(id INTEGER PRIMARY KEY,send_batch_id INTEGER NOT NULL REFERENCES send_batches(id),draft_id INTEGER NOT NULL REFERENCES drafts(id),status TEXT NOT NULL,error TEXT);
CREATE TABLE audit_log(id INTEGER PRIMARY KEY,occurred_at TEXT,actor TEXT NOT NULL,action TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,detail_json TEXT NOT NULL);
"""


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run_cli(*args: str, expected: int = 0) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != expected:
        raise AssertionError(
            f"command returned {result.returncode}, expected {expected}\nstdout={result.stdout}\nstderr={result.stderr}"
        )
    return result


class LegacyOutreachBundleTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.database = self.root / "legacy.sqlite3"
        connection = sqlite3.connect(self.database)
        connection.executescript(SCHEMA)
        connection.execute("INSERT INTO schema_meta VALUES('schema_version','2')")
        connection.execute(
            "INSERT INTO prospects(id,territory,venue_name,city,state,website,general_email,contact_email,raw_json,source_fingerprint,active) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (
                "legacy-prospect-1",
                "Test Territory",
                "Fixture Museum",
                "Chicago",
                "IL",
                "https://fixture.invalid",
                "hello@fixture.invalid",
                "person@fixture.invalid",
                '{"fixture":true}',
                "source-hash",
                1,
            ),
        )
        connection.execute(
            "INSERT INTO contacts(id,prospect_id,name,email,email_type,is_primary,do_not_contact) VALUES(1,'legacy-prospect-1','Fixture Contact','person@fixture.invalid','person',1,0)"
        )
        connection.execute(
            "INSERT INTO templates(id,name,purpose,source_fingerprint) VALUES('template-1','Fixture','test','template-hash')"
        )
        connection.execute(
            "INSERT INTO campaigns(id,name,status,selection_json) VALUES(1,'Fixture Campaign','planning','{}')"
        )
        connection.execute(
            "INSERT INTO campaign_prospects(id,campaign_id,prospect_id,stage) VALUES(1,1,'legacy-prospect-1','selected')"
        )
        connection.execute(
            "INSERT INTO drafts(id,campaign_prospect_id,subject,body,status) VALUES(1,1,'Fixture subject','Fixture body','needs-review')"
        )
        connection.execute(
            "INSERT INTO interactions(id,prospect_id,direction,interaction_type,occurred_at) VALUES(1,'legacy-prospect-1','outbound','fixture','2026-08-20T00:00:00Z')"
        )
        connection.execute(
            "INSERT INTO followups(id,campaign_prospect_id,due_at,status) VALUES(1,1,'2026-08-21T00:00:00Z','open')"
        )
        connection.execute("INSERT INTO send_batches(id,name,status) VALUES(1,'Fixture Batch','staged')")
        connection.execute(
            "INSERT INTO send_batch_items(id,send_batch_id,draft_id,status) VALUES(1,1,1,'staged')"
        )
        connection.execute(
            "INSERT INTO audit_log(id,actor,action,entity_type,entity_id,detail_json) VALUES(1,'fixture','created','prospect','legacy-prospect-1','{}')"
        )
        connection.commit()
        connection.close()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_inventory_is_read_only_and_contains_no_rows(self) -> None:
        before = sha256(self.database)
        result = run_cli("inventory", "--source", str(self.database))
        after = sha256(self.database)
        inventory = json.loads(result.stdout)
        self.assertEqual(before, after)
        self.assertEqual(inventory["foreignKeyViolationCount"], 0)
        self.assertEqual(inventory["tables"]["prospects"]["rowCount"], 1)
        self.assertNotIn("Fixture Museum", result.stdout)
        self.assertNotIn("person@fixture.invalid", result.stdout)

    def test_export_is_deterministic_and_reconciles(self) -> None:
        first = self.root / "first"
        second = self.root / "second"
        run_cli("export", "--source", str(self.database), "--output-dir", str(first))
        run_cli("export", "--source", str(self.database), "--output-dir", str(second))
        self.assertEqual((first / "records.ndjson").read_bytes(), (second / "records.ndjson").read_bytes())
        self.assertEqual((first / "manifest.json").read_bytes(), (second / "manifest.json").read_bytes())
        reconciliation = json.loads(
            run_cli("reconcile", "--source", str(self.database), "--bundle-dir", str(first)).stdout
        )
        self.assertTrue(reconciliation["ok"])
        records = [json.loads(line) for line in (first / "records.ndjson").read_text(encoding="utf-8").splitlines()]
        organization = next(record for record in records if record["kind"] == "prospect-organization")
        self.assertEqual(organization["legacy"]["id"], "legacy-prospect-1")
        self.assertEqual(organization["legacy"]["system"], "pathfinder-outreach-sqlite")
        contacts = [record for record in records if record["kind"] == "prospect-contact"]
        self.assertEqual(len(contacts), 2)
        embedded = next(record for record in contacts if record["legacy"]["table"] == "prospects")
        self.assertEqual(embedded["data"]["readiness"], "UNKNOWN_REQUIRES_REVIEW")

    def test_tampered_bundle_fails_closed(self) -> None:
        bundle = self.root / "bundle"
        run_cli("export", "--source", str(self.database), "--output-dir", str(bundle))
        with (bundle / "records.ndjson").open("ab") as destination:
            destination.write(b"{}\n")
        result = run_cli(
            "reconcile", "--source", str(self.database), "--bundle-dir", str(bundle), expected=2
        )
        self.assertIn("unsupported bundle version", result.stderr)

    def test_unknown_table_requires_review(self) -> None:
        connection = sqlite3.connect(self.database)
        connection.execute("CREATE TABLE surprise(id INTEGER PRIMARY KEY)")
        connection.commit()
        connection.close()
        result = run_cli("inventory", "--source", str(self.database), expected=2)
        self.assertIn("unreviewed legacy tables present", result.stderr)

    def test_export_refuses_to_overwrite_an_existing_bundle(self) -> None:
        bundle = self.root / "bundle"
        run_cli("export", "--source", str(self.database), "--output-dir", str(bundle))
        result = run_cli(
            "export", "--source", str(self.database), "--output-dir", str(bundle), expected=2
        )
        self.assertIn("already contains", result.stderr)

    def test_non_empty_wal_requires_a_checkpointed_copy(self) -> None:
        wal = self.database.with_name(self.database.name + "-wal")
        wal.write_bytes(b"not-a-checkpointed-database")
        result = run_cli("inventory", "--source", str(self.database), expected=2)
        self.assertIn("checkpointed filesystem copy", result.stderr)


if __name__ == "__main__":
    unittest.main()
