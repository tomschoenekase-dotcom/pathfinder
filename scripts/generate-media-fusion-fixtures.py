#!/usr/bin/env python3
"""Generate small, deterministic, fictional multimodal venue benchmark sources.

The outputs contain no customer material, downloaded media, people, or real venue facts.
They are truth fixtures for pipeline/reducer benchmarking, not evidence of model quality.
"""

from __future__ import annotations

import hashlib
import json
import platform
import shutil
import subprocess
import tempfile
from pathlib import Path

import PIL
from PIL import Image, ImageDraw, ImageFont
from reportlab import Version as REPORTLAB_VERSION
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[1]
FIXTURE_ROOT = ROOT / "scripts" / "fixtures" / "media-fusion-v1"
GENERATOR_VERSION = "media-fusion-fixture-generator/1.0.0"
SEED = 1007
WIDTH, HEIGHT = 640, 360
FONT = ImageFont.load_default(size=22)
SMALL_FONT = ImageFont.load_default(size=15)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def base_image(title: str, subtitle: str) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    image = Image.new("RGB", (WIDTH, HEIGHT), "#F3EFE5")
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, WIDTH, 58), fill="#12372A")
    draw.text((22, 15), title, fill="#FFFFFF", font=FONT)
    draw.text((22, 327), f"SYNTHETIC BENCHMARK - {subtitle}", fill="#24352F", font=SMALL_FONT)
    return image, draw


def save_png(path: Path, image: Image.Image) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG", optimize=False, compress_level=9)


def bot_scene(offset: int = 0) -> Image.Image:
    image, draw = base_image("Juniper Civic Gallery", "FICTIONAL EXHIBIT")
    x = 238 + offset
    draw.rounded_rectangle((x, 98, x + 164, 278), radius=18, fill="#A94F3D", outline="#612D25", width=5)
    draw.ellipse((x + 28, 121, x + 64, 157), fill="#E9C46A", outline="#5D4915", width=3)
    draw.ellipse((x + 100, 121, x + 136, 157), fill="#E9C46A", outline="#5D4915", width=3)
    draw.rectangle((x + 50, 185, x + 114, 204), fill="#F5E6CA")
    draw.text((38, 95), "EXHIBIT BOT-014", fill="#12372A", font=FONT)
    draw.text((38, 132), "Copper Service Automaton", fill="#24352F", font=SMALL_FONT)
    draw.text((38, 161), "Inventory label is visible", fill="#24352F", font=SMALL_FONT)
    return image


def doorway_scene(offset: int = 0) -> Image.Image:
    image, draw = base_image("Juniper Civic Gallery - East Room", "COVERAGE ENDS AT DOOR")
    draw.rectangle((42, 86, 414, 302), fill="#D9C9AE", outline="#6A5D4D", width=4)
    door_x = 398 + offset
    draw.rectangle((door_x, 112, door_x + 126, 302), fill="#263238", outline="#101619", width=5)
    draw.text((72, 109), "EAST ROOM", fill="#12372A", font=FONT)
    draw.text((72, 150), "Doorway visible", fill="#24352F", font=SMALL_FONT)
    draw.line((524, 112, 594, 82), fill="#A12622", width=5)
    draw.text((470, 68), "BEYOND FRAME", fill="#A12622", font=SMALL_FONT)
    draw.text((455, 91), "route not observed", fill="#A12622", font=SMALL_FONT)
    return image


def twin_scene(offset: int = 0) -> Image.Image:
    image, draw = base_image("Linden Learning Garden", "FICTIONAL LOOKALIKE ROOMS")
    for x, identifier in [(72 + offset, "GH-N"), (354 + offset, "GH-S")]:
        draw.polygon([(x, 170), (x + 94, 88), (x + 188, 170)], fill="#B9D8C2", outline="#315E48")
        draw.rectangle((x, 170, x + 188, 292), fill="#CFE7D5", outline="#315E48", width=4)
        draw.line((x + 94, 88, x + 94, 292), fill="#315E48", width=3)
        draw.text((x + 58, 206), "PALM HOUSE", fill="#12372A", font=SMALL_FONT)
        draw.text((x + 68, 241), identifier, fill="#7B241C", font=FONT)
    return image


def temporal_scene() -> Image.Image:
    image, draw = base_image("Marigold Local History Center", "FICTIONAL TEMPORARY NOTICE")
    draw.rounded_rectangle((84, 82, 556, 300), radius=14, fill="#FFF8D7", outline="#8A6A00", width=5)
    draw.text((127, 105), "SPECIAL CONSERVATION WEEK", fill="#6F3200", font=FONT)
    draw.text((174, 157), "SEPTEMBER 7-13", fill="#12372A", font=FONT)
    draw.text((194, 203), "OPEN 10 AM-4 PM", fill="#12372A", font=FONT)
    draw.text((133, 253), "Regular hours resume September 14", fill="#5F5540", font=SMALL_FONT)
    return image


def write_pdf(path: Path, title: str, rows: list[tuple[str, str]], note: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pdf = canvas.Canvas(str(path), pagesize=letter, invariant=1, pageCompression=1)
    pdf.setTitle(title)
    pdf.setAuthor("Torchiko deterministic fixture generator")
    pdf.setSubject("Synthetic fictional venue benchmark source")
    pdf.setFillColor(HexColor("#12372A"))
    pdf.rect(0, 710, 612, 82, stroke=0, fill=1)
    pdf.setFillColor(HexColor("#FFFFFF"))
    title_size = 20
    while pdf.stringWidth(title, "Helvetica-Bold", title_size) > 524:
        title_size -= 1
    pdf.setFont("Helvetica-Bold", title_size)
    pdf.drawString(44, 748, title)
    pdf.setFillColor(HexColor("#24352F"))
    pdf.setFont("Helvetica", 10)
    pdf.drawString(44, 690, "SYNTHETIC BENCHMARK - FICTIONAL VENUE - NO CUSTOMER DATA")
    y = 640
    for label, value in rows:
        pdf.setFont("Helvetica-Bold", 12)
        pdf.drawString(52, y, label)
        pdf.setFont("Helvetica", 12)
        pdf.drawString(190, y, value)
        y -= 42
    pdf.setStrokeColor(HexColor("#B7C9C0"))
    pdf.line(44, y + 16, 568, y + 16)
    pdf.setFont("Helvetica-Oblique", 11)
    note_lines: list[str] = []
    line = ""
    for word in note.split():
        candidate = f"{line} {word}".strip()
        if line and pdf.stringWidth(candidate, "Helvetica-Oblique", 11) > 508:
            note_lines.append(line)
            line = word
        else:
            line = candidate
    if line:
        note_lines.append(line)
    for index, note_line in enumerate(note_lines):
        pdf.drawString(52, y - 8 - (index * 17), note_line)
    pdf.setFont("Helvetica", 9)
    pdf.drawRightString(568, 34, "Synthetic source page 1 of 1")
    pdf.showPage()
    pdf.save()


def write_video(path: Path, frames: list[Image.Image], fps: int = 4) -> float:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="media-fusion-frames-") as temp_dir:
        frame_dir = Path(temp_dir)
        for index, frame in enumerate(frames):
            save_png(frame_dir / f"frame-{index:03d}.png", frame)
        subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-framerate",
                str(fps),
                "-i",
                str(frame_dir / "frame-%03d.png"),
                "-an",
                "-c:v",
                "libx264",
                "-preset",
                "veryslow",
                "-crf",
                "25",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                "-map_metadata",
                "-1",
                "-fflags",
                "+bitexact",
                "-flags:v",
                "+bitexact",
                str(path),
            ],
            check=True,
        )
    return len(frames) / fps


def ffmpeg_version() -> str:
    first = subprocess.check_output(["ffmpeg", "-version"], text=True).splitlines()[0]
    return first.replace("ffmpeg version ", "", 1).split(" Copyright", 1)[0]


def asset(path: Path, media_type: str, *, duration_seconds: float | None = None, pages: int | None = None) -> dict:
    relative = path.relative_to(FIXTURE_ROOT).as_posix()
    result = {
        "path": relative,
        "mediaType": media_type,
        "sha256": sha256(path),
        "bytes": path.stat().st_size,
        "synthetic": True,
        "rights": "self-created synthetic fixture; no people, customer data, or real venue facts",
    }
    if media_type == "IMAGE":
        result.update({"format": "png", "width": WIDTH, "height": HEIGHT})
    elif media_type == "VIDEO":
        result.update({"format": "mp4", "durationSeconds": duration_seconds, "hasAudio": False})
    else:
        result.update({"format": "pdf", "pages": pages})
    return result


def locator(source: str, locator_type: str, **values: object) -> dict:
    return {"source": source, "locator": {"type": locator_type, **values}}


def common_manifest(split: str, cases: list[dict]) -> dict:
    return {
        "schemaVersion": 1,
        "suiteId": "media-fusion-v1",
        "split": split,
        "synthetic": True,
        "fictionalVenueNotice": "All names, facts, diagrams, and media were generated for this benchmark.",
        "providerStatus": "NOT_RUN",
        "providerStatusMeaning": "No model or external provider has processed these source bytes.",
        "generator": {
            "version": GENERATOR_VERSION,
            "seed": SEED,
            "command": "python scripts/generate-media-fusion-fixtures.py",
            "toolchain": {
                "python": platform.python_version(),
                "pillow": PIL.__version__,
                "reportlab": REPORTLAB_VERSION,
                "ffmpeg": ffmpeg_version(),
            },
        },
        "measurementBoundary": {
            "proves": [
                "fixture byte integrity",
                "expected evidence locator bounds",
                "deterministic provider-dark reducer inputs",
            ],
            "doesNotProve": [
                "model vision, OCR, or extraction accuracy",
                "provider cost, latency, or repeatability",
                "complete video-frame coverage",
            ],
        },
        "cases": cases,
    }


def generate() -> None:
    if FIXTURE_ROOT.exists():
        shutil.rmtree(FIXTURE_ROOT)
    development = FIXTURE_ROOT / "development" / "sources"
    holdout = FIXTURE_ROOT / "holdout" / "sources"
    development.mkdir(parents=True)
    holdout.mkdir(parents=True)

    bot_png = development / "bot-014-overview.png"
    bot_pdf = development / "bot-014-inventory.pdf"
    bot_mp4 = development / "bot-014-walkthrough.mp4"
    save_png(bot_png, bot_scene())
    write_pdf(
        bot_pdf,
        "Juniper Civic Gallery Inventory",
        [("Inventory ID", "BOT-014"), ("Display name", "Copper Service Automaton"), ("Room", "North Machines Hall")],
        "This inventory page describes the same fictional exhibit shown in the visual sources.",
    )
    bot_duration = write_video(bot_mp4, [bot_scene(offset) for offset in (14, 10, 6, 2, 0, -2, -4, -6)])

    door_png = development / "east-doorway-frame.png"
    door_pdf = development / "east-doorway-coverage.pdf"
    door_mp4 = development / "east-doorway-walkthrough.mp4"
    save_png(door_png, doorway_scene())
    write_pdf(
        door_pdf,
        "Juniper East Room Coverage Note",
        [("Observed", "East Room and doorway"), ("Not observed", "Corridor beyond doorway"), ("Route status", "UNKNOWN")],
        "No path, distance, destination, or accessibility beyond the doorway was recorded.",
    )
    door_duration = write_video(door_mp4, [doorway_scene(offset) for offset in (-8, -5, -2, 0, 2, 4, 6, 8)])

    twin_png = holdout / "twin-conservatories.png"
    twin_pdf = holdout / "conservatory-register.pdf"
    twin_mp4 = holdout / "conservatory-walkthrough.mp4"
    save_png(twin_png, twin_scene())
    write_pdf(
        twin_pdf,
        "Linden Learning Garden Room Register",
        [("North inventory", "GH-N"), ("South inventory", "GH-S"), ("Shared label", "Palm House")],
        "The two fictional rooms are deliberately similar but have conflicting durable identifiers.",
    )
    twin_duration = write_video(twin_mp4, [twin_scene(offset) for offset in (10, 7, 4, 1, -1, -4, -7, -10)])

    temporal_png = holdout / "special-week-placard.png"
    temporal_pdf = holdout / "visitor-guide-archive.pdf"
    save_png(temporal_png, temporal_scene())
    write_pdf(
        temporal_pdf,
        "Marigold Visitor Guide - Archived Edition",
        [("Regular hours", "Open 9 AM-5 PM"), ("Edition", "Archived"), ("Current-week authority", "NOT ESTABLISHED")],
        "Historical guide data must not override a dated current-week placard or become a permanent schedule.",
    )

    development_cases = [
        {
            "caseId": "mf-d01-exact-exhibit-cross-media",
            "title": "Exact exhibit identity across image, document, and video",
            "scope": {"tenantId": "synthetic-dev-tenant", "venueId": "juniper-gallery", "projectId": "mf-dev-project", "sourceGeneration": "10000000-0000-4000-8000-000000000001"},
            "assets": [asset(bot_png, "IMAGE"), asset(bot_pdf, "DOCUMENT", pages=1), asset(bot_mp4, "VIDEO", duration_seconds=bot_duration)],
            "expected": {
                "observations": [
                    {"observationId": "bot-image-id", "kind": "visible_text", "statement": "BOT-014", "evidenceChannel": "visible_text", "directness": "observed", "confidence": "confirmed", "evidence": locator(asset(bot_png, "IMAGE")["path"], "image_region", x=0.04, y=0.22, width=0.32, height=0.12)},
                    {"observationId": "bot-pdf-id", "kind": "visible_text", "statement": "BOT-014", "evidenceChannel": "document_text", "directness": "observed", "confidence": "confirmed", "evidence": locator(asset(bot_pdf, "DOCUMENT", pages=1)["path"], "document_page", page=1)},
                    {"observationId": "bot-video-id", "kind": "entity_candidate", "statement": "Copper Service Automaton BOT-014", "evidenceChannel": "visual", "directness": "observed", "confidence": "probable", "evidence": locator(asset(bot_mp4, "VIDEO", duration_seconds=bot_duration)["path"], "video_interval", startSeconds=0, endSeconds=2)},
                ],
                "entities": {"candidateIds": ["bot-image", "bot-document", "bot-video"], "assessment": "PROPOSE_MERGE", "requiredIdentifier": {"scheme": "inventory_id", "value": "BOT-014"}, "automaticMerge": False},
                "relations": [],
                "temporal": {"outcome": "NO_HOLDS", "heldTargetKeys": []},
                "evidence": {"expectedLocatorCount": 3, "staleGenerationAccepted": False, "allSourceHashesRequired": True},
                "privacy": {"publicAssetPaths": [], "privateEvidenceOnly": True},
            },
        },
        {
            "caseId": "mf-d04-doorway-missing-geometry",
            "title": "Visible doorway with unobserved route geometry",
            "scope": {"tenantId": "synthetic-dev-tenant", "venueId": "juniper-gallery", "projectId": "mf-dev-project", "sourceGeneration": "10000000-0000-4000-8000-000000000001"},
            "assets": [asset(door_png, "IMAGE"), asset(door_pdf, "DOCUMENT", pages=1), asset(door_mp4, "VIDEO", duration_seconds=door_duration)],
            "expected": {
                "observations": [
                    {"observationId": "door-image", "kind": "entity_candidate", "statement": "Doorway at East Room edge", "evidenceChannel": "visual", "directness": "observed", "confidence": "confirmed", "evidence": locator(asset(door_png, "IMAGE")["path"], "image_region", x=0.61, y=0.3, width=0.22, height=0.54)},
                    {"observationId": "door-coverage", "kind": "spatial_relation", "statement": "Route beyond doorway was not observed", "evidenceChannel": "document_text", "directness": "observed", "confidence": "confirmed", "evidence": locator(asset(door_pdf, "DOCUMENT", pages=1)["path"], "document_page", page=1)},
                    {"observationId": "door-video", "kind": "spatial_relation", "statement": "East Room and doorway are co-visible", "evidenceChannel": "visual", "directness": "observed", "confidence": "probable", "evidence": locator(asset(door_mp4, "VIDEO", duration_seconds=door_duration)["path"], "video_interval", startSeconds=0, endSeconds=2)},
                ],
                "entities": {"candidateIds": ["east-room", "east-doorway"], "assessment": "KEEP_DISTINCT", "automaticMerge": False},
                "relations": [{"fromCandidateId": "east-room", "toCandidateId": "east-doorway", "kind": "COVISIBLE", "reviewStatus": "PENDING", "mustNotPropose": ["TRAVERSABLE"], "accessibility": "UNKNOWN"}],
                "temporal": {"outcome": "NO_HOLDS", "heldTargetKeys": []},
                "evidence": {"expectedLocatorCount": 3, "staleGenerationAccepted": False, "allSourceHashesRequired": True},
                "privacy": {"publicAssetPaths": [], "privateEvidenceOnly": True},
            },
        },
    ]

    holdout_cases = [
        {
            "caseId": "mf-h02-lookalike-conservatories",
            "title": "Lookalike rooms with conflicting durable identifiers",
            "scope": {"tenantId": "synthetic-holdout-tenant", "venueId": "linden-garden", "projectId": "mf-holdout-project", "sourceGeneration": "20000000-0000-4000-8000-000000000002"},
            "assets": [asset(twin_png, "IMAGE"), asset(twin_pdf, "DOCUMENT", pages=1), asset(twin_mp4, "VIDEO", duration_seconds=twin_duration)],
            "expected": {
                "observations": [
                    {"observationId": "twins-image", "kind": "entity_candidate", "statement": "Two Palm House rooms labeled GH-N and GH-S", "evidenceChannel": "visible_text", "directness": "observed", "confidence": "confirmed", "evidence": locator(asset(twin_png, "IMAGE")["path"], "whole_source")},
                    {"observationId": "twins-register", "kind": "visible_text", "statement": "GH-N and GH-S are separate inventory records", "evidenceChannel": "document_text", "directness": "observed", "confidence": "confirmed", "evidence": locator(asset(twin_pdf, "DOCUMENT", pages=1)["path"], "document_page", page=1)},
                    {"observationId": "twins-video", "kind": "entity_candidate", "statement": "Two similar conservatory rooms", "evidenceChannel": "visual", "directness": "observed", "confidence": "probable", "evidence": locator(asset(twin_mp4, "VIDEO", duration_seconds=twin_duration)["path"], "video_interval", startSeconds=0, endSeconds=2)},
                ],
                "entities": {"candidateIds": ["north-palm-house", "south-palm-house"], "assessment": "KEEP_DISTINCT", "conflictingIdentifiers": [{"scheme": "inventory_id", "values": ["GH-N", "GH-S"]}], "automaticMerge": False},
                "relations": [],
                "temporal": {"outcome": "NO_HOLDS", "heldTargetKeys": []},
                "evidence": {"expectedLocatorCount": 3, "staleGenerationAccepted": False, "allSourceHashesRequired": True},
                "privacy": {"publicAssetPaths": [], "privateEvidenceOnly": True},
            },
        },
        {
            "caseId": "mf-h06-special-week-hours",
            "title": "Dated special-week placard versus archived regular hours",
            "scope": {"tenantId": "synthetic-holdout-tenant", "venueId": "marigold-history", "projectId": "mf-holdout-project", "sourceGeneration": "20000000-0000-4000-8000-000000000002"},
            "assets": [asset(temporal_png, "IMAGE"), asset(temporal_pdf, "DOCUMENT", pages=1)],
            "expected": {
                "observations": [
                    {"observationId": "week-placard", "kind": "visible_text", "statement": "September 7-13 open 10 AM-4 PM", "evidenceChannel": "visible_text", "directness": "observed", "confidence": "confirmed", "evidence": locator(asset(temporal_png, "IMAGE")["path"], "image_region", x=0.13, y=0.22, width=0.74, height=0.62)},
                    {"observationId": "archive-hours", "kind": "visible_text", "statement": "Archived guide says regular hours are 9 AM-5 PM", "evidenceChannel": "document_text", "directness": "observed", "confidence": "confirmed", "evidence": locator(asset(temporal_pdf, "DOCUMENT", pages=1)["path"], "document_page", page=1)},
                ],
                "entities": {"candidateIds": ["marigold-hours"], "assessment": "KEEP_DISTINCT", "automaticMerge": False},
                "relations": [],
                "temporal": {"outcome": "HELD", "heldTargetKeys": ["venue:marigold-history:hours"], "holdReasons": ["DATE_BOUND"], "staticCandidateIncludesTarget": False, "requiresCurrentAuthorityQuestion": True},
                "evidence": {"expectedLocatorCount": 2, "staleGenerationAccepted": False, "allSourceHashesRequired": True},
                "privacy": {"publicAssetPaths": [], "privateEvidenceOnly": True},
            },
        },
    ]

    for split, cases in (("development", development_cases), ("holdout", holdout_cases)):
        path = FIXTURE_ROOT / split / "manifest.json"
        path.write_text(json.dumps(common_manifest(split, cases), indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    generate()
