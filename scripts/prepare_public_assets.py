"""Export a minimal public website snapshot from an explicit manuscript directory.

Only curated schema descriptions, aggregate counts and two aggregate figures are
read. Original manuscript/source files are read-only. No research records, raw
source hashes, categorical values or restricted manifests are exported.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
from xml.etree import ElementTree


VERSION = "1.0.0"
SNAPSHOT_DATE = "2026-10-12"
UPDATED_DATE = "2026-10-13"
PUBLIC_COLUMNS = (
    "id", "wave", "layer", "source_table", "field", "storage_type",
    "interpretation", "missing_policy", "provenance_status", "provenance_evidence",
)
SOURCE_FILES = {
    "dictionary": "supplements/multimedia_appendix_1/data_dictionary.csv",
    "aggregate": "supplements/multimedia_appendix_1/aggregate_summary.json",
    "eligibility": "supplements/multimedia_appendix_2/empirical_expected/descriptive_extension/daily_qc_summary.csv",
    "selection": "figures/selection_flow.svg",
    "variation": "figures/descriptive_extension.svg",
}
FIGURES = {"selection": "selection-flow.svg", "variation": "descriptive-variation.svg"}
EXPECTED_WAVES = {
    "G1": (20, 105361, 533, 18, 335),
    "G2": (30, 157363, 402, 33, 223),
    "G3": (24, 138223, 374, 27, 208),
}
WINDOWS_PATH = re.compile(r"(?<![A-Za-z0-9])[A-Za-z]:[\\/]")
PARTICIPANT_ID = re.compile(r"\bG[123]\d{3}\b", re.IGNORECASE)
RAW_HASH = re.compile(r"\b[a-fA-F0-9]{64}\b")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_csv(data):
    reader = csv.DictReader(io.StringIO(data.decode("utf-8-sig")))
    rows = list(reader)
    if any(None in row or any(value is None for value in row.values()) for row in rows):
        raise ValueError("Malformed source dictionary/aggregate CSV")
    return rows


def assert_safe_public(text, name, allow_svg_namespaces=False):
    if PARTICIPANT_ID.search(text):
        raise ValueError("Participant-shaped identifier in public output: " + name)
    if WINDOWS_PATH.search(text) or re.search(r"(?:file://|/Users/|/home/|/mnt/|\\\\Users\\)", text):
        raise ValueError("Absolute workstation path in public output: " + name)
    if RAW_HASH.search(text):
        raise ValueError("Source fingerprint in public data/figure: " + name)
    if re.search(r"data[\\/]raw|data[\\/]processed|SAIL_David|author_confirmations\.json", text, re.IGNORECASE):
        raise ValueError("Private source path in public output: " + name)
    if not allow_svg_namespaces and re.search(r"<\s*(?:script|iframe|object)\b", text, re.IGNORECASE):
        raise ValueError("Active markup in public description: " + name)


def public_dictionary(source):
    original = read_csv(source)
    if len(original) != 203:
        raise ValueError("Expected 203 source fields; review a changed snapshot before publishing")
    fields, overrides, description_updates = [], 0, 0
    for row in original:
        basename = PurePosixPath(row["source_table"].replace("\\", "/")).name
        item = {name: row[name].strip() for name in PUBLIC_COLUMNS if name not in ("id", "source_table")}
        item["source_table"] = basename
        item["id"] = "::".join((item["wave"], basename, item["field"]))
        if item["storage_type"] == "text cells; observed types below are lexical classifications":
            item["storage_type"] = "Exported text cells; semantic meaning is described separately."
        if item["wave"] in {"G1", "G2"} and item["field"] == "sensorglucose":
            if basename != f"{item['wave']}_Raw_cgm_removed.csv":
                raise ValueError("Unexpected G1/G2 sensor table for the reviewed description update")
            item["interpretation"] = "Sensor glucose in mg/dL. This export omits the unit in the column name; mg/dL is supported by verified lineage to the raw export."
            description_updates += 1
        if item["wave"] == "G3" and item["field"] == "sensorglucose":
            if basename not in {"G3_Raw_cgm.csv", "G3_Raw_cgm_removed.csv"}:
                raise ValueError("Unexpected G3 sensor table for the reviewed unit override")
            item["interpretation"] = "Sensor glucose in mg/dL. The original Clarity Glucose.Value..mg.dL. field was renamed sensorglucose without numerical conversion, according to coauthor confirmation."
            item["provenance_status"] = "unit_coauthor_confirmed_mg_dl; device_provenance_unverified"
            item["provenance_evidence"] = "Coauthor confirmation on October 13, 2026 establishes mg/dL and a field-name-only change. This is author-provided lineage, not independently recovered source metadata. The exported header omits units; device provenance remains unverified."
            overrides += 1
        item = {name: item[name] for name in PUBLIC_COLUMNS}
        assert_safe_public(json.dumps(item, ensure_ascii=False), "dictionary field")
        fields.append(item)
    if overrides != 2:
        raise ValueError("Expected exactly two G3 sensorglucose unit updates")
    if description_updates != 2:
        raise ValueError("Expected exactly two G1/G2 sensorglucose description updates")
    if len({row["id"] for row in fields}) != len(fields):
        raise ValueError("Duplicate public schema-field ID")
    if {row["wave"] for row in fields} != {"G1", "G2", "G3"}:
        raise ValueError("Unexpected study waves")
    expected_layers = {"participant characteristics", "sensor observations", "source transcript", "supplied sensor summaries"}
    if {row["layer"] for row in fields} != expected_layers:
        raise ValueError("Unexpected dictionary layers")
    return {"version": VERSION, "snapshot_date": SNAPSHOT_DATE, "updated_date": UPDATED_DATE, "fields": fields}


def public_resource(aggregate_source, eligibility_source, field_count):
    audit = json.loads(aggregate_source.decode("utf-8-sig"))
    media = audit["media_and_transcripts"]
    totals = media["media_totals"]
    clinical = audit["clinical"]
    collections = media["media_collections"]
    headline = {
        "wave_specific_identifiers": int(totals["canonical_participant_ids_n"]),
        "media_files": int(totals["raw_media_files_n"]),
        "media_hours": round(float(totals["total_duration_seconds"]) / 3600, 2),
        "raw_cgm_observations": sum(int(clinical[wave]["raw_sensor_rows"]) for wave in EXPECTED_WAVES),
        "dictionary_fields": field_count,
    }
    if headline != {"wave_specific_identifiers": 86, "media_files": 1387, "media_hours": 33.62, "raw_cgm_observations": 400947, "dictionary_fields": 203}:
        raise ValueError("Headline counts changed; review publication snapshot")
    waves = []
    keys = ("clinical_identifiers", "raw_cgm_observations", "daily_media_files", "interview_media_files", "observed_daily_keys")
    for wave, expected in EXPECTED_WAVES.items():
        values = (
            int(clinical[wave]["clinical_ids"]), int(clinical[wave]["raw_sensor_rows"]),
            int(collections[wave + "_daily"]["raw_media_files_n"]),
            int(collections[wave + "_interview"]["raw_media_files_n"]),
            int(collections[wave + "_daily"]["participant_day_filename_pairs_n"]),
        )
        if values != expected:
            raise ValueError("Wave aggregate changed: " + wave)
        waves.append({"wave": wave, **dict(zip(keys, values))})
    primary = [row for row in read_csv(eligibility_source) if row["threshold"] == "80"]
    if len(primary) != 2 or {row["study_id"] for row in primary} != {"G2", "G3"}:
        raise ValueError("Primary eligibility summary is not the expected two-wave set")
    eligibility = {
        "analysis_waves": ["G2", "G3"],
        "complete_paired_diary_days": sum(int(row["paired_days"]) for row in primary),
        "cgm_eligible_days": sum(int(row["eligible_days"]) for row in primary),
        "wave_specific_identifiers": sum(int(row["eligible_identifiers"]) for row in primary),
        "identifiers_with_repeated_eligible_dates": sum(int(row["identifiers_with_two_or_more_days"]) for row in primary),
        "minimum_unique_readings": 231,
        "nominal_daily_readings": 288,
        "maximum_gap_minutes_including_boundaries": 60,
    }
    if tuple(eligibility[key] for key in ("complete_paired_diary_days", "cgm_eligible_days", "wave_specific_identifiers", "identifiers_with_repeated_eligible_dates")) != (369, 327, 50, 48):
        raise ValueError("Paired-analysis eligibility changed")
    result = {
        "version": VERSION, "snapshot_date": SNAPSHOT_DATE, "updated_date": UPDATED_DATE,
        "headline": headline, "waves": waves, "eligibility": eligibility,
        "interpretation": {
            "identifier_unit": "Wave-specific identifiers; 86 identifiers are not established as 86 distinct people across waves.",
            "duration_basis": "Observed media duration from metadata probes; duration does not establish recording usability or intelligibility.",
            "day_key_basis": "Observed daily-media keys; G1 keys use filename dates, whereas G2/G3 keys use explicit study-day tokens. These are not all verified recording dates.",
            "linkage": "Exported calendar-date co-occurrence does not establish event-level clock synchronization or a glucose-response association.",
            "clinical_scope": "Clinical-table identifiers describe available clinical exports, not every media identifier or a deduplicated cross-wave cohort.",
        },
    }
    assert_safe_public(json.dumps(result, ensure_ascii=False), "resource aggregate")
    return result


def validate_svg(data, name):
    text = data.decode("utf-8")
    assert_safe_public(text, name, allow_svg_namespaces=True)
    root = ElementTree.fromstring(text)
    if root.tag.rsplit("}", 1)[-1] != "svg":
        raise ValueError("Figure is not SVG: " + name)
    for node in root.iter():
        if node.tag.rsplit("}", 1)[-1].lower() in {"script", "foreignobject", "iframe", "object", "image"}:
            raise ValueError("Unexpected active or embedded-media element: " + name)
        for key, value in node.attrib.items():
            local = key.rsplit("}", 1)[-1].lower()
            if local.startswith("on") or (local in {"href", "src"} and not value.startswith("#")):
                raise ValueError("External content/event handler in figure: " + name)


def sources_document(sources, exported):
    lines = [
        "# Public website content sources", "",
        "This website describes the manuscript's October 12, 2026 source snapshot, with publication-facing metadata updated October 13, 2026. These dates identify the documented snapshot, not a continuously updated dataset.", "",
        "All source references below are relative to the explicitly supplied V01 manuscript directory. The SHA256 values identify curated manuscript artifacts; original research-record fingerprints and workstation paths are not published.", "",
        "| Curated source artifact | SHA256 | Website use |", "| --- | --- | --- |",
    ]
    uses = {"dictionary": "203 field descriptions; strict public-column allowlist", "aggregate": "Headline and wave-level counts only", "eligibility": "Primary complete-day and CGM-eligibility counts", "selection": "Selection-flow aggregate figure", "variation": "Descriptive-variation aggregate figure"}
    for key, relative in SOURCE_FILES.items():
        lines.append(f"| `{relative}` | `{digest(sources[key])}` | {uses[key]} |")
    lines += [
        "", "## Public transformations", "",
        "- Dictionary fields: `id`, `wave`, `layer`, `source_table`, `field`, `storage_type`, `interpretation`, `missing_policy`, `provenance_status`, `provenance_evidence`.",
        "- `source_table` contains the basename only. `id` is a stable schema key composed of wave, table basename and field name; it is not a participant identifier.",
        "- Record values, categorical vocabulary, record/missingness counts, source-record hashes, full source paths and private manifests are excluded from dictionary exports.",
        "- Text-cell storage descriptions are reworded to remove references to observed-type columns that are excluded from the public dictionary.",
        "- Two G1/G2 `sensorglucose` descriptions are reworded to describe their verified raw-export lineage and supported mg/dL units, removing a stale cross-wave caveat. Their existing provenance status and evidence are unchanged; no original source files are edited.",
        "- Two G3 `sensorglucose` descriptions are updated: a coauthor confirmed mg/dL and that the original Clarity `Glucose.Value..mg.dL.` column was renamed without numerical conversion. This is author-provided lineage, not independently recovered header metadata. Device provenance remains unverified. No values were converted or original source files edited.",
        "- Resource counts are aggregate descriptions. The 86 wave-specific identifiers are not established as 86 distinct people; 74 clinical-table identifiers represent a different available-record population.",
        "- Analysis eligibility is 369 complete paired diary days followed by 327 days meeting the specified CGM rules across 50 wave-specific identifiers. Date co-occurrence does not establish synchronized events or clinical prediction.",
        "- Figures are copied from the reviewed aggregate manuscript figures. No participant images, audio, ID labels, individual study dates or external embedded media are included.",
        "", "## Publication and access semantics", "",
        "This introduction does not assert journal acceptance, peer-review completion, unrestricted dataset access, or a research-data/analysis-code license. Academic-institution eligibility and the David Black request route are confirmed in `sections/declarations.tex`; permitted modalities, approval authority and any access agreement remain separate determinations. The current manuscript also identifies remaining documentary details. Proprietary software and dictionaries are not distributed.",
        "", "## Generated public artifacts", "",
    ]
    for relative, data in exported.items():
        lines.append(f"- `{relative}` — SHA256 `{digest(data)}`")
    lines += ["", "Regenerate locally with an explicit source:", "", "```text", "python scripts/prepare_public_assets.py --manuscript-root /path/to/V01", "```", "", "The exporter writes only this website's `data/`, the two designated SVG files in `assets/`, and this source note. Source artifacts are checked unchanged after export.", ""]
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manuscript-root", type=Path, required=True, help="Explicit external V01 manuscript directory; no private default")
    args = parser.parse_args()
    manuscript = args.manuscript_root.expanduser().resolve(strict=True)
    website = Path(__file__).resolve().parents[1]
    sources = {key: (manuscript / relative).read_bytes() for key, relative in SOURCE_FILES.items()}
    dictionary = public_dictionary(sources["dictionary"])
    resource = public_resource(sources["aggregate"], sources["eligibility"], len(dictionary["fields"]))
    exported = {
        "data/dictionary.json": (json.dumps(dictionary, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8"),
        "data/resource.json": (json.dumps(resource, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8"),
    }
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=PUBLIC_COLUMNS, lineterminator="\n")
    writer.writeheader()
    writer.writerows(dictionary["fields"])
    exported["data/dictionary.csv"] = stream.getvalue().encode("utf-8")
    for key, target in FIGURES.items():
        validate_svg(sources[key], target)
        exported["assets/" + target] = sources[key]
    for relative, data in exported.items():
        target = website / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    note = sources_document(sources, exported)
    (website / "CONTENT_SOURCES.md").write_text(note, encoding="utf-8")
    for key, relative in SOURCE_FILES.items():
        if (manuscript / relative).read_bytes() != sources[key]:
            raise RuntimeError("Manuscript source changed during export: " + relative)
    if json.loads((website / "data/dictionary.json").read_text(encoding="utf-8")) != dictionary:
        raise AssertionError("Dictionary JSON roundtrip mismatch")
    if read_csv((website / "data/dictionary.csv").read_bytes()) != dictionary["fields"]:
        raise AssertionError("Dictionary CSV roundtrip mismatch")
    print(json.dumps({"status": "passed", "dictionary_fields": len(dictionary["fields"]), "public_columns": list(PUBLIC_COLUMNS),
                      "waves": ["G1", "G2", "G3"], "layers": 4, "g3_unit_overrides": 2, "g1_g2_description_updates": 2,
                      "headline": resource["headline"], "eligible_diary_days": resource["eligibility"]["cgm_eligible_days"],
                      "source_artifacts_unchanged": True, "written": list(exported) + ["CONTENT_SOURCES.md"]}, indent=2))


if __name__ == "__main__":
    main()
