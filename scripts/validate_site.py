"""Validate the static public GCM site using only Python's standard library.

Run from any directory. stdout is one JSON document; exit status is nonzero on
failure. This is a static release check, not browser or accessibility acceptance.
"""
from __future__ import annotations

import argparse
import csv
from datetime import date
import hashlib
from html.parser import HTMLParser
import io
import json
import math
from pathlib import Path
import re
import tempfile
from urllib.parse import unquote, urlsplit
import xml.etree.ElementTree as ET


REQUIRED_FILES = {
    "index.html", "styles.css", "app.js", "dictionary.js", "favicon.svg",
    ".nojekyll", ".gitignore", ".gitattributes", "README.md", "CONTENT_SOURCES.md", "package.json",
    "data/dictionary.json", "data/dictionary.csv", "data/resource.json",
    "assets/selection-flow.svg", "assets/descriptive-variation.svg",
    "scripts/prepare_public_assets.py", "scripts/validate_site.py",
    "tests/dictionary.test.mjs",
}
OPTIONAL_FILES = {"robots.txt", "sitemap.xml", "version.json"}
IGNORED_DIRECTORIES = {".git", "node_modules", ".qa"}
FIELD_KEYS = (
    "id", "wave", "layer", "source_table", "field", "storage_type",
    "interpretation", "missing_policy", "provenance_status", "provenance_evidence",
)
WAVES = {"G1", "G2", "G3"}
LAYERS = {"participant characteristics", "sensor observations", "source transcript", "supplied sensor summaries"}
EXPECTED_HEADLINE = {
    "wave_specific_identifiers": 86, "media_files": 1387, "media_hours": 33.62,
    "raw_cgm_observations": 400947, "dictionary_fields": 203,
}
EXPECTED_ELIGIBILITY = {
    "complete_paired_diary_days": 369, "cgm_eligible_days": 327,
    "wave_specific_identifiers": 50, "identifiers_with_repeated_eligible_dates": 48,
    "minimum_unique_readings": 231, "nominal_daily_readings": 288,
    "maximum_gap_minutes_including_boundaries": 60,
}
PARTICIPANT_ID = re.compile(r"(?<![A-Za-z0-9])G[123]\d{3}(?!\d)")
WINDOWS_PATH = re.compile(r"(?<![A-Za-z0-9])[A-Za-z]:[\\/]")
UNC_PATH = re.compile(r"\\\\[A-Za-z0-9_.-]+\\[A-Za-z0-9_$.-]+")
RAW_PATH = re.compile(r"\bdata[\\/]+(?:raw(?:_text|_videoes|_cgm)?|labeling_platform|restricted|internal)(?:[\\/]|\b)", re.I)
CREDENTIAL_PATTERNS = (
    re.compile(r"\bAKIA[A-Z0-9]{16}\b"),
    re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{40,}\b"),
    re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b"),
    re.compile(r"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----"),
    re.compile(r"(?i)[\"']?(?:api[_-]?key|client[_-]?secret|access[_-]?token|password)[\"']?\s*[:=]\s*[\"'][^\"'\r\n]{12,}[\"']"),
)
PRIVATE_ARTIFACT = re.compile(r"(?:author[_-]?confirm|consent[_-]?ledger|participant[_-]?media|^raw[_-])", re.I)
PRIVATE_SUFFIXES = {".pdf", ".zip", ".7z", ".tar", ".gz", ".mp4", ".mov", ".avi", ".wav", ".mp3", ".m4a", ".flac", ".jpg", ".jpeg", ".png", ".webp", ".sqlite", ".db"}


class SiteHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.ids = set()
        self.duplicate_ids = set()
        self.links = []
        self.images = []
        self.event_attributes = []
        self.script_types = []
        self.inline_scripts = []
        self.lang = None
        self.title = []
        self.stack = []
        self.metrics = []
        self.table_rows = []
        self.active_table_row = None
        self.active_table_cell = None
        self.active_content = []

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if tag in {"base", "iframe", "object", "embed"} or "srcdoc" in attrs:
            self.active_content.append(tag)
        in_wave_table = any(t == "table" and "wave-table" in a.get("class", "").split() for t, a, _ in self.stack)
        if tag == "tr" and in_wave_table:
            self.active_table_row = []
            self.table_rows.append(self.active_table_row)
        if tag in {"th", "td"} and self.active_table_row is not None:
            self.active_table_cell = []
            self.active_table_row.append(self.active_table_cell)
        if tag == "html":
            self.lang = attrs.get("lang")
        identifier = attrs.get("id")
        if identifier:
            if identifier in self.ids:
                self.duplicate_ids.add(identifier)
            self.ids.add(identifier)
        for key, value in attributes:
            if key.lower().startswith("on"):
                self.event_attributes.append(key)
            if key in {"href", "src", "action", "formaction", "poster"} and value is not None:
                self.links.append((tag, key, value))
        if tag == "img":
            self.images.append(attrs)
        if tag == "script":
            self.script_types.append(attrs)
        metric = None
        if "data-resource-key" in attrs:
            metric = {"key": attrs["data-resource-key"], "text": []}
            self.metrics.append(metric)
        if tag not in {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}:
            self.stack.append((tag, attrs, metric))

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if tag in {"th", "td"}:
            self.active_table_cell = None
        if tag == "tr":
            self.active_table_row = None
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                break

    def handle_data(self, data):
        if self.active_table_cell is not None:
            self.active_table_cell.append(data)
        if any(tag == "title" for tag, _, _ in self.stack):
            self.title.append(data)
        for tag, attrs, metric in self.stack:
            if metric is not None:
                metric["text"].append(data)
            if tag == "script" and not attrs.get("src"):
                self.inline_scripts.append((attrs.get("type", ""), data))


class Audit:
    def __init__(self, root):
        self.root = root
        self.errors = []
        self.checks = {}
        self.files = {}
        self.texts = {}

    def fail(self, code, path, message):
        self.errors.append({"code": code, "path": str(path), "message": message})

    def check(self, name, condition, path, message):
        self.checks[name] = bool(condition)
        if not condition:
            self.fail(name, path, message)
        return bool(condition)

    def discover(self):
        if not self.root.is_dir():
            self.fail("site_root_missing", ".", "Site root is not an existing directory.")
            return
        def visit(directory):
            for item in sorted(directory.iterdir(), key=lambda p: p.name):
                relative = item.relative_to(self.root).as_posix()
                if item.name in IGNORED_DIRECTORIES and item.is_dir():
                    continue
                if item.is_symlink() or (hasattr(item, "is_junction") and item.is_junction()):
                    self.fail("unexpected_link", relative, "Public files must be ordinary files/directories, not links outside the release tree.")
                    continue
                if item.is_dir():
                    visit(item)
                elif item.is_file():
                    self.files[relative] = item
        visit(self.root)
        for missing in sorted(REQUIRED_FILES - self.files.keys()):
            self.fail("required_file_missing", missing, "Expected public release file is missing.")
        for name, path in self.files.items():
            if path.suffix.lower() in PRIVATE_SUFFIXES or PRIVATE_ARTIFACT.search(path.name):
                self.fail("private_artifact", name, "Media, raw/private ledgers, databases, PDFs, and archives cannot be published here.")
            elif name not in REQUIRED_FILES | OPTIONAL_FILES:
                self.fail("unexpected_public_file", name, "File is outside the explicit public release allowlist.")
        self.checks["explicit_public_file_allowlist"] = not any(e["code"] in {"required_file_missing", "private_artifact", "unexpected_public_file", "unexpected_link"} for e in self.errors)

    def read_text(self, name):
        if name in self.texts:
            return self.texts[name]
        path = self.files.get(name)
        if path is None:
            return None
        try:
            self.texts[name] = path.read_text(encoding="utf-8-sig")
            return self.texts[name]
        except (OSError, UnicodeError):
            self.fail("invalid_text_encoding", name, "Expected readable UTF-8 text.")
            return None

    def read_json(self, name):
        text = self.read_text(name)
        if text is None:
            return None
        def unique_object(pairs):
            out = {}
            for key, value in pairs:
                if key in out:
                    raise ValueError("Duplicate JSON key")
                out[key] = value
            return out
        try:
            return json.loads(text, object_pairs_hook=unique_object,
                              parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Nonfinite JSON constant")))
        except (ValueError, TypeError):
            self.fail("invalid_json", name, "JSON must parse with unique keys and finite numeric values.")
            return None

    def privacy(self):
        checks = [("participant_identifier_literal", PARTICIPANT_ID), ("absolute_windows_path", WINDOWS_PATH),
                  ("unc_path", UNC_PATH), ("private_source_path", RAW_PATH)]
        for name, path in self.files.items():
            if name.startswith(("tests/", "scripts/")) or path.suffix.lower() not in {".html", ".json", ".csv", ".svg", ".js", ".css"}:
                continue
            text = self.read_text(name)
            if text is None:
                continue
            for code, pattern in checks:
                if pattern.search(text):
                    self.fail(code, name, "Prohibited identifying or machine-private content detected; matched text is intentionally omitted.")
            if any(pattern.search(text) for pattern in CREDENTIAL_PATTERNS):
                self.fail("credential_marker", name, "Credential-like material detected; matched text is intentionally omitted.")
            if "\x00" in text:
                self.fail("nul_in_public_text", name, "Public source contains a NUL character.")
        self.checks["public_content_privacy_scan"] = not any(e["code"] in {c for c, _ in checks} | {"credential_marker", "nul_in_public_text"} for e in self.errors)

    def dictionary(self):
        name = "data/dictionary.json"
        data = self.read_json(name)
        if not isinstance(data, dict):
            self.fail("dictionary_object", name, "Expected a dictionary metadata object.")
            return None
        self.check("dictionary_top_level_schema", set(data) == {"version", "snapshot_date", "updated_date", "fields"}, name, "Unexpected dictionary metadata keys; observed values and private vocabularies are not permitted.")
        rows = data.get("fields")
        if not isinstance(rows, list):
            self.fail("dictionary_fields_array", name, "Expected a fields array.")
            return None
        self.check("dictionary_203_rows", len(rows) == 203, name, "Expected exactly 203 public schema fields.")
        shape_ok = all(isinstance(row, dict) and set(row) == set(FIELD_KEYS) and all(isinstance(row[key], str) for key in FIELD_KEYS) for row in rows)
        if not self.check("dictionary_exact_public_row_keys", shape_ok, name, "Each row must contain only the ten approved string fields; no observed vocabularies or private keys."):
            return data
        self.check("dictionary_three_waves_four_layers", {r["wave"] for r in rows} == WAVES and {r["layer"] for r in rows} == LAYERS, name, "Expected G1/G2/G3 and the four approved dictionary layers.")
        self.check("dictionary_stable_unique_keys", len({r["id"] for r in rows}) == len(rows) and all(r["id"] == "::".join((r["wave"], r["source_table"], r["field"])) for r in rows), name, "IDs must be unique wave::source_table::field schema keys.")
        self.check("dictionary_basename_only_sources", all(r["source_table"] and "/" not in r["source_table"] and "\\" not in r["source_table"] and r["source_table"] not in {".", ".."} for r in rows), name, "Dictionary source_table must be a basename, not a source-data path.")
        sensors = [r for r in rows if r["wave"] == "G3" and r["field"] == "sensorglucose"]
        self.check("g3_two_sensor_glucose_fields", len(sensors) == 2 and {r["source_table"] for r in sensors} == {"G3_Raw_cgm.csv", "G3_Raw_cgm_removed.csv"}, name, "Expected exactly the two G3 sensorglucose schema entries.")
        self.check("g3_unit_confirmed_device_unverified", len(sensors) == 2 and all(r["provenance_status"] == "unit_coauthor_confirmed_mg_dl; device_provenance_unverified" and "mg/dL" in r["interpretation"] and "without numerical conversion" in r["interpretation"] and "author-provided" in r["provenance_evidence"] and "not independently" in r["provenance_evidence"] for r in sensors), name, "G3 units must retain coauthor-confirmed mg/dL with no numerical conversion and unverified device provenance.")
        text = self.read_text("data/dictionary.csv")
        if text is not None:
            reader = csv.DictReader(io.StringIO(text))
            csv_rows = list(reader)
            self.check("dictionary_csv_matches_json", tuple(reader.fieldnames or []) == FIELD_KEYS and csv_rows == rows, "data/dictionary.csv", "CSV header, row order, and all field values must exactly match public dictionary JSON.")
        return data

    def resource(self, dictionary):
        name = "data/resource.json"
        data = self.read_json(name)
        if not isinstance(data, dict):
            self.fail("resource_object", name, "Expected a resource metadata object.")
            return None
        self.check("resource_top_level_schema", set(data) == {"version", "snapshot_date", "updated_date", "headline", "waves", "eligibility", "interpretation"}, name, "Unexpected resource metadata keys.")
        headline = data.get("headline", {})
        self.check("resource_verified_headline_counts", headline == EXPECTED_HEADLINE, name, "Headline counts must match the approved resource snapshot.")
        waves = data.get("waves", [])
        wave_keys = {"wave", "clinical_identifiers", "raw_cgm_observations", "daily_media_files", "interview_media_files", "observed_daily_keys"}
        shape = isinstance(waves, list) and len(waves) == 3 and all(isinstance(w, dict) and set(w) == wave_keys for w in waves)
        if self.check("resource_wave_schema", shape, name, "Expected three wave summaries with only approved aggregate fields."):
            self.check("resource_wave_names", {w["wave"] for w in waves} == WAVES, name, "Wave summaries must uniquely cover G1/G2/G3.")
            numeric = all(type(w[k]) is int and w[k] >= 0 for w in waves for k in wave_keys - {"wave"})
            if self.check("resource_wave_nonnegative_integer_counts", numeric, name, "Wave counts must be nonnegative integers."):
                self.check("resource_cgm_total_reconciled", sum(w["raw_cgm_observations"] for w in waves) == headline.get("raw_cgm_observations"), name, "Wave CGM counts do not sum to the headline CGM count.")
                self.check("resource_media_total_reconciled", sum(w["daily_media_files"] + w["interview_media_files"] for w in waves) == headline.get("media_files"), name, "Daily plus interview media counts do not sum to the headline media count.")
        # Clinical-table IDs intentionally have a different population from the
        # overall media/resource IDs; do not equate their sum with 86.
        eligibility = data.get("eligibility", {})
        self.check("resource_verified_eligibility_counts", eligibility == {"analysis_waves": ["G2", "G3"], **EXPECTED_ELIGIBILITY}, name, "Eligibility counts or analyst-defined completeness settings differ from the approved analysis.")
        interpretations = data.get("interpretation", {})
        interpretation_keys = {"identifier_unit", "duration_basis", "day_key_basis", "linkage", "clinical_scope"}
        self.check("resource_interpretation_limits_present", isinstance(interpretations, dict) and set(interpretations) == interpretation_keys and all(isinstance(v, str) and v.strip() for v in interpretations.values()), name, "Resource denominator, timing, clinical-scope, and identifier caveats must be present.")
        if isinstance(dictionary, dict):
            self.check("dictionary_resource_metadata_consistency", all(data.get(k) == dictionary.get(k) for k in ("version", "snapshot_date", "updated_date")) and len(dictionary.get("fields", [])) == headline.get("dictionary_fields"), name, "Resource and dictionary metadata/counts disagree.")
        for key in ("snapshot_date", "updated_date"):
            try:
                date.fromisoformat(data[key])
            except (KeyError, TypeError, ValueError):
                self.fail("invalid_metadata_date", name, "Dates must use ISO YYYY-MM-DD strings.")
        return data

    def link(self, value, origin, ids=None):
        value = unquote(value.strip())
        if any(ord(c) < 32 for c in value):
            self.fail("unsafe_link_control_character", origin, "Link contains control characters.")
            return
        try:
            parts = urlsplit(value)
        except ValueError:
            self.fail("invalid_link", origin, "Link cannot be parsed.")
            return
        if parts.scheme:
            if parts.scheme.lower() not in {"https", "mailto"}:
                self.fail("unsafe_link_scheme", origin, "Only HTTPS, mailto, or local navigation links are allowed.")
            elif parts.scheme.lower() == "https" and (not parts.netloc or parts.username or parts.password):
                self.fail("invalid_https_link", origin, "HTTPS links require a host and cannot embed credentials.")
            elif parts.scheme.lower() == "mailto" and not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", parts.path):
                self.fail("invalid_mailto_link", origin, "mailto link must contain a valid-looking email address.")
            return
        if parts.netloc or value.startswith("//"):
            self.fail("protocol_relative_link", origin, "Use explicit HTTPS for remote links.")
            return
        relative = parts.path
        base = self.root if relative.startswith("/") else (self.root / origin).parent
        candidate = (base / relative.lstrip("/")).resolve() if relative else (self.root / origin).resolve()
        if not candidate.is_relative_to(self.root):
            self.fail("local_link_escapes_site", origin, "Local link escapes the public root.")
            return
        if candidate.is_dir():
            candidate /= "index.html"
        if not candidate.is_file():
            self.fail("missing_local_link", origin, "A local href/src target does not exist.")
            return
        target_name = candidate.relative_to(self.root).as_posix()
        if target_name not in REQUIRED_FILES | OPTIONAL_FILES:
            self.fail("link_to_nonpublic_file", origin, "Local link points outside the explicit public allowlist.")
        if parts.fragment and candidate.suffix.lower() == ".html":
            target_ids = ids if target_name == origin and ids is not None else None
            if target_ids is None:
                other = SiteHTML()
                other.feed(candidate.read_text(encoding="utf-8-sig"))
                target_ids = other.ids
            if parts.fragment not in target_ids:
                self.fail("missing_local_anchor", origin, "A local HTML fragment has no matching element ID.")

    def html(self, resource):
        text = self.read_text("index.html")
        if text is None:
            return
        html = SiteHTML()
        html.feed(text)
        self.check("html_lang_en", html.lang == "en", "index.html", "Set the document language to en.")
        self.check("html_title_present", bool("".join(html.title).strip()), "index.html", "Document title must be nonempty.")
        self.check("html_unique_ids", not html.duplicate_ids, "index.html", "Duplicate element IDs break reliable anchor navigation.")
        self.check("html_no_event_handler_attributes", not html.event_attributes, "index.html", "Inline event-handler attributes are prohibited; use the first-party module.")
        self.check("html_no_active_embeds_or_base_override", not html.active_content, "index.html", "Embedded browsing contexts, object embeds, srcdoc, and base overrides are outside this public release.")
        self.check("html_image_alt_text", all("alt" in a and (a["alt"].strip() or a.get("aria-hidden") == "true" or a.get("role") == "presentation") for a in html.images), "index.html", "Images require useful alt text or explicit decorative semantics.")
        self.check("html_no_executable_inline_scripts", all(kind == "application/ld+json" or not body.strip() for kind, body in html.inline_scripts), "index.html", "Executable scripts must be first-party files, not inline source.")
        for attributes in html.script_types:
            if attributes.get("src"):
                parsed = urlsplit(attributes["src"])
                if parsed.scheme or parsed.netloc:
                    self.fail("remote_executable_script", "index.html", "Executable scripts must be first-party public files.")
        for _, _, value in html.links:
            self.link(value, "index.html", html.ids)
        if isinstance(resource, dict):
            bound = {m["key"] for m in html.metrics}
            required = {"headline." + key for key in EXPECTED_HEADLINE}
            self.check("html_headline_metric_bindings", required.issubset(bound), "index.html", "Each headline number needs a data-resource-key binding for reproducible HTML-to-JSON validation.")
            for metric in html.metrics:
                current = resource
                for segment in metric["key"].split("."):
                    if isinstance(current, dict):
                        current = current.get(segment)
                    elif isinstance(current, list) and segment.isdigit() and int(segment) < len(current):
                        current = current[int(segment)]
                    else:
                        current = None
                numbers = re.findall(r"[-+]?\d[\d,]*(?:\.\d+)?", "".join(metric["text"]))
                valid = isinstance(current, (int, float)) and not isinstance(current, bool) and len(numbers) == 1 and math.isclose(float(numbers[0].replace(",", "")), current, abs_tol=1e-8, rel_tol=0)
                self.check("html_metric_" + re.sub(r"[^A-Za-z0-9_.-]", "_", metric["key"]), valid, "index.html", "Bound metric text does not exactly match its resource JSON value.")
            rows = [[" ".join("".join(cell).split()) for cell in row] for row in html.table_rows]
            self.check("html_wave_table_column_order", bool(rows) and rows[0][1:] == ["G1", "G2", "G3"], "index.html", "Wave table columns must be G1, G2, G3 in that order.")
            wave_values = {wave.get("wave"): wave for wave in resource.get("waves", []) if isinstance(wave, dict)}
            labels = {
                "Clinical-table records": "clinical_identifiers",
                "Raw CGM observations": "raw_cgm_observations",
                "Daily media files": "daily_media_files",
                "Postvisit media files": "interview_media_files",
                "Observed daily keys": "observed_daily_keys",
            }
            for label, key in labels.items():
                matches = [row[1:] for row in rows[1:] if row and row[0] == label]
                expected = [str(wave_values.get(wave, {}).get(key)) for wave in ("G1", "G2", "G3")]
                valid = len(matches) == 1 and [cell.replace(",", "") for cell in matches[0]] == expected
                self.check("html_wave_table_" + key, valid, "index.html", "Wave table row must uniquely match the three resource JSON values for " + key + ".")

    def assets(self):
        for name in sorted(n for n in self.files if n.endswith(".svg")):
            text = self.read_text(name)
            if text is None:
                continue
            try:
                root = ET.fromstring(text)
            except ET.ParseError:
                self.fail("invalid_svg", name, "SVG is not well-formed XML.")
                continue
            ids = {element.attrib["id"] for element in root.iter() if "id" in element.attrib}
            for element in root.iter():
                if element.tag.split("}")[-1].lower() == "script":
                    self.fail("svg_executable_script", name, "SVG assets cannot contain executable script.")
                for key, value in element.attrib.items():
                    local_key = key.split("}")[-1].lower()
                    if local_key.startswith("on"):
                        self.fail("svg_event_attribute", name, "SVG event-handler attributes are prohibited.")
                    if local_key in {"href", "src"}:
                        if value.startswith("#"):
                            if value[1:] not in ids:
                                self.fail("svg_missing_fragment", name, "SVG fragment reference has no matching ID.")
                        else:
                            self.link(value, name)
        for name in ("app.js", "dictionary.js"):
            text = self.read_text(name)
            if text is None:
                continue
            dangerous = re.search(r"\beval\s*\(|\bnew\s+Function\s*\(|\bdocument\s*\.\s*write(?:ln)?\s*\(|\binsertAdjacentHTML\s*\(", text)
            self.check("safe_static_js_sinks_" + name, dangerous is None, name, "Dynamic evaluation/document-write/HTML insertion sinks require removal before this static release check passes.")
            for match in re.finditer(r"\.(?:innerHTML|outerHTML)\s*=\s*([^;\n]+)", text):
                if match.group(1).strip() not in {"''", '""', "``"}:
                    self.fail("js_nonempty_html_assignment", name, "Use textContent/DOM construction for data-driven content rather than nonempty HTML assignment.")
            for target in re.findall(r"(?:from\s*|import\s*)[\"']([^\"']+)[\"']", text):
                self.link(target, name)
        for name in sorted(n for n in self.files if n.endswith(".json")):
            self.read_json(name)

    def result(self):
        return {
            "status": "passed" if not self.errors else "failed",
            "check_count": len(self.checks), "checks": self.checks,
            "public_files": sorted(self.files), "errors": self.errors,
            "scope": "Static source, allowlist, privacy-pattern, schema, table, and link checks. No browser, publication, or runtime accessibility claim.",
            "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        }


def self_test():
    assert not WINDOWS_PATH.search('http://www.w3.org/2000/svg')
    assert not WINDOWS_PATH.search('https://doi.org/10.1000/example')
    assert WINDOWS_PATH.search(r'C:\private\file.csv')
    assert PARTICIPANT_ID.search('G2001')
    assert not PARTICIPANT_ID.search('G2::G2_Raw_cgm.csv::glucose')
    assert UNC_PATH.search(r'\\server\share\file')
    assert RAW_PATH.search('data/raw_text/private.csv')
    html = SiteHTML()
    html.feed('<html lang="en"><head><title>Resource</title></head><body><b data-resource-key="headline.media_files">1,387</b><a href="#target">x</a><div id="target"></div><img src="a.svg" alt="Diagram"></body></html>')
    assert html.lang == "en" and html.ids == {"target"}
    assert "".join(html.metrics[0]["text"]) == '1,387'
    bad = SiteHTML()
    bad.feed('<button onclick="run()">x</button><script>alert(1)</script>')
    assert bad.event_attributes and bad.inline_scripts
    with tempfile.TemporaryDirectory(prefix="gcm_site_validator_") as temporary:
        root = Path(temporary).resolve()
        for name in REQUIRED_FILES:
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("", encoding="utf-8")
        (root / "index.html").write_text('<html><body><div id="target"></div></body></html>', encoding="utf-8")
        (root / ".qa").mkdir()
        (root / ".qa" / "private-test.zip").write_bytes(b"ignored QA fixture")
        clean = Audit(root)
        clean.discover()
        assert not clean.errors, "Allowed files with private local QA directory must pass discovery."
        (root / "private-test.zip").write_bytes(b"prohibited public fixture")
        extra = Audit(root)
        extra.discover()
        assert any(error["code"] == "private_artifact" for error in extra.errors)
        links = Audit(root)
        links.link("#target", "index.html")
        assert not links.errors
        links.link("#missing", "index.html")
        links.link("javascript:alert(1)", "index.html")
        links.link("../private.csv", "index.html")
        assert {error["code"] for error in links.errors} == {"missing_local_anchor", "unsafe_link_scheme", "local_link_escapes_site"}
        injected = Audit(root)
        injected.files = {"data/dictionary.json": root / "data/dictionary.json"}
        (root / "data/dictionary.json").write_text('{"field":"G2001"}', encoding="utf-8")
        injected.privacy()
        assert any(error["code"] == "participant_identifier_literal" for error in injected.errors)
        wave = SiteHTML()
        wave.feed('<table class="wave-table"><tr><th>Metric</th><th><span>G1</span></th><th>G2</th><th>G3</th></tr><tr><th>Count</th><td>20</td><td>30</td><td>24</td></tr></table>')
        assert [["".join(cell) for cell in row] for row in wave.table_rows] == [["Metric", "G1", "G2", "G3"], ["Count", "20", "30", "24"]]
    return {"status": "passed", "self_test": True, "checks": ["SVG_namespace_not_windows_path", "HTTPS_not_windows_path", "private_path_markers", "participant_schema_key_not_person_id", "HTML_metric_and_anchor_extraction", "inline_execution_detection", "QA_directory_ignored", "unlisted_private_archive_rejected", "missing_anchor_rejected", "javascript_link_rejected", "escaped_local_path_rejected", "participant_content_rejected", "nested_wave_table_cells"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--report", type=Path, help="Optional report path inside the site's .qa directory; relative paths resolve from --root.")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        result = self_test()
    else:
        audit = Audit(args.root.resolve())
        try:
            audit.discover()
            audit.privacy()
            dictionary = audit.dictionary()
            resource = audit.resource(dictionary)
            audit.html(resource)
            audit.assets()
        except (OSError, ValueError, TypeError, KeyError, AttributeError, csv.Error) as error:
            audit.fail("validator_could_not_complete", ".", "Validation stopped on " + type(error).__name__ + "; no pass is claimed.")
        result = audit.result()
    if args.report:
        site_root = args.root.resolve()
        report = args.report if args.report.is_absolute() else site_root / args.report
        report = report.resolve()
        qa_root = (site_root / ".qa").resolve()
        if not qa_root.is_relative_to(site_root) or not report.is_relative_to(qa_root) or report.suffix.lower() != ".json":
            result["status"] = "failed"
            result.setdefault("errors", []).append({"code": "invalid_report_destination", "path": ".qa", "message": "Report must be a JSON file inside the site's .qa directory."})
        else:
            try:
                report.parent.mkdir(parents=True, exist_ok=True)
                report.write_text(json.dumps(result, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
            except OSError:
                result["status"] = "failed"
                result.setdefault("errors", []).append({"code": "report_write_failed", "path": ".qa", "message": "Could not write the requested validation report."})
    print(json.dumps(result, indent=2, ensure_ascii=True))
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
