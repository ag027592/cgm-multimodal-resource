# CGM Multimodal Resource

English resource overview, aggregate descriptive figures, and a searchable 203-field data dictionary.

Website: https://huangchengchou.com/cgm-multimodal-resource/

## What is included

This repository contains the static website and curated documentation for an October 12, 2026 source snapshot. The website displays 86 wave-specific identifiers, 1,387 media files (33.62 hours), and 400,947 raw CGM observations. These are different data-layer denominators; 86 identifiers must not be described as 86 independent participants.

The manuscript is in preparation. No journal acceptance, published article, or dataset DOI is implied. Academic-institution access inquiries should be directed to Professor David Black at davidbla@usc.edu. Requests do not guarantee release of every modality.

Participant recordings, transcripts, record-level CGM/clinical data, linkage manifests, the manuscript draft, and research-analysis code are not included. The website source is not a data-access grant, and no open-source license for the research code is asserted.

## Preview and checks

Serve this directory over HTTP using Python 3:

```sh
python -m http.server 8765 --bind 127.0.0.1
```

Open `http://127.0.0.1:8765/`. The main page remains readable without JavaScript. Dictionary search requires JavaScript and loads only the public dictionary JSON; CSV is available for offline use.

Node.js 20+ and Python 3.11+ are sufficient for the automated checks; no package installation is needed:

```sh
npm test
python scripts/validate_site.py
```

## Update the public documentation

Edit `index.html` and `styles.css` for presentation; `app.js` and `dictionary.js` implement browser-local search, filtering, and pagination.

The asset preparation script uses an explicitly supplied authorized manuscript directory:

```sh
python scripts/prepare_public_assets.py --manuscript-root PATH_TO_MANUSCRIPT
```

It derives public field documentation and aggregate assets, not participant records. Review all resulting changes, reconcile visible HTML numbers with `data/resource.json`, and rerun both checks before publishing. See [CONTENT_SOURCES.md](CONTENT_SOURCES.md) for source provenance, unit-confirmation overrides, figure interpretation, and limitations. Do not copy an entire research directory into this repository.

## Deployment

GitHub Pages serves the root of the `main` branch. `.nojekyll` disables Jekyll processing. All local assets use relative URLs to support the project subpath. A commit pushed to `main` triggers deployment. No custom-domain file is needed: the project inherits the account's existing Pages domain.

After each release, check the deployed site, dictionary interactions, mobile layout, and downloaded CSV. Revert the affected website commit to restore a previous version if needed. The personal-site repository and study data are separate from this project.

## Version

Documentation release v1.0.0, October 13, 2026. Scientific limitations remain explicit: calendar-date linkage, undocumented language provenance for most candidate diary days, descriptive feature use, and technical screening distinct from independent human measurement validation.
