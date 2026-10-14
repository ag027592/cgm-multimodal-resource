# Public website content sources

This website describes the manuscript's October 12, 2026 source snapshot, with publication-facing metadata updated October 13, 2026. These dates identify the documented snapshot, not a continuously updated dataset.

All source references below are relative to the explicitly supplied V01 manuscript directory. The SHA256 values identify curated manuscript artifacts; original research-record fingerprints and workstation paths are not published.

| Curated source artifact | SHA256 | Website use |
| --- | --- | --- |
| `supplements/multimedia_appendix_1/data_dictionary.csv` | `e3bcbff8e2743f5db627335db3ffa05106fd450fadea340140301bdf8bf1149c` | 203 field descriptions; strict public-column allowlist |
| `supplements/multimedia_appendix_1/aggregate_summary.json` | `b6b14756863f1fbe4cd3d963383861d3c26f70e2f7cf8f1c25b2f6fea1a756eb` | Headline and wave-level counts only |
| `supplements/multimedia_appendix_2/empirical_expected/descriptive_extension/daily_qc_summary.csv` | `76fa0f72cbb499c11535520661ef1dc89f88675a22fd0d92ce0379daf5ddf2ae` | Primary complete-day and CGM-eligibility counts |
| `figures/selection_flow.svg` | `17b93a1d0518e897472e720ab9b8ff7024e8810d05bed213cfa3cefc6416b039` | Selection-flow aggregate figure |
| `figures/descriptive_extension.svg` | `d50cd1fabe57b745a0f7a9a63a18d6f2de3280e5991fbc1058c3f43d74a06126` | Descriptive-variation aggregate figure |

## Public transformations

- Dictionary fields: `id`, `wave`, `layer`, `source_table`, `field`, `storage_type`, `interpretation`, `missing_policy`, `provenance_status`, `provenance_evidence`.
- `source_table` contains the basename only. `id` is a stable schema key composed of wave, table basename and field name; it is not a participant identifier.
- Record values, categorical vocabulary, record/missingness counts, source-record hashes, full source paths and private manifests are excluded from dictionary exports.
- Text-cell storage descriptions are reworded to remove references to observed-type columns that are excluded from the public dictionary.
- Two G3 `sensorglucose` descriptions are updated: a coauthor confirmed mg/dL and that the original Clarity `Glucose.Value..mg.dL.` column was renamed without numerical conversion. This is author-provided lineage, not independently recovered header metadata. Device provenance remains unverified. No values were converted or original source files edited.
- Resource counts are aggregate descriptions. The 86 wave-specific identifiers are not established as 86 distinct people; 74 clinical-table identifiers represent a different available-record population.
- Analysis eligibility is 369 complete paired diary days followed by 327 days meeting the specified CGM rules across 50 wave-specific identifiers. Date co-occurrence does not establish synchronized events or clinical prediction.
- Figures are copied from the reviewed aggregate manuscript figures. No participant images, audio, ID labels, individual study dates or external embedded media are included.

## Publication and access semantics

This introduction does not assert journal acceptance, peer-review completion, unrestricted dataset access, or a research-data/analysis-code license. Academic-institution eligibility and the David Black request route are confirmed in `sections/declarations.tex`; permitted modalities, approval authority and any access agreement remain separate determinations. The current manuscript also identifies remaining documentary details. Proprietary software and dictionaries are not distributed.

## Generated public artifacts

- `data/dictionary.json` — SHA256 `f93682747e977a67a4496549d8891ad357da84f805b113dd4bd2bd38042d9fac`
- `data/resource.json` — SHA256 `172fa38de5487a20f7c41532f4e7a07e7980089329003e3fad83f5a0717017e7`
- `data/dictionary.csv` — SHA256 `995e9479c2e5c167eb316e6e5de63ad3b176d79932c37d6498b1c6467499b79f`
- `assets/selection-flow.svg` — SHA256 `17b93a1d0518e897472e720ab9b8ff7024e8810d05bed213cfa3cefc6416b039`
- `assets/descriptive-variation.svg` — SHA256 `d50cd1fabe57b745a0f7a9a63a18d6f2de3280e5991fbc1058c3f43d74a06126`

Regenerate locally with an explicit source:

```text
python scripts/prepare_public_assets.py --manuscript-root /path/to/V01
```

The exporter writes only this website's `data/`, the two designated SVG files in `assets/`, and this source note. Source artifacts are checked unchanged after export.
