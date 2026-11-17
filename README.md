# PDG Quantum Combiner

A Manifest V3 Chrome extension for searching particles and combinations by mass and quantum numbers, using the official Particle Listings as its bundled data source. The full catalog is kept in the database and powers search; it is not displayed as a separate list in the popup. No install/build step or network connection is needed for searches.

## Choose a browser download

| Browser | Download | Install method |
| --- | --- | --- |
| Chrome or Chromium (Linux, macOS, Windows) | [Chrome ZIP](https://github.com/jinziWu/pdg-quantum-combiner/releases/latest/download/PDG-Quantum-Combiner-Chrome.zip) | Extract, then load the folder containing `manifest.json` from `chrome://extensions` with Developer mode on. |
| Safari on macOS | [Safari ZIP](https://github.com/jinziWu/pdg-quantum-combiner/releases/latest/download/PDG-Quantum-Combiner-Safari-macOS.zip) | Extract and follow the included `INSTALL-SAFARI.md`. Safari temporary installs are removed when Safari quits or after 24 hours. |

The browser ZIPs are attached to each GitHub Release. If the links above do not exist yet, open the [Actions page](https://github.com/jinziWu/pdg-quantum-combiner/actions/workflows/publish-browser-downloads.yml) and run **Publish browser downloads** once. A permanent Safari installation requires packaging the extension in a macOS app with Xcode and signing it for distribution; the Safari ZIP is a free temporary install for testing and use sessions.

## Load or reload

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select the folder where you extracted this project.
3. If the extension is already installed, click its **Reload** button, close the old popup, and open it again.

For Safari, see [Safari installation instructions](docs/INSTALL-SAFARI.md). Apple documents temporary installation of a Safari web extension folder [here](https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension#Temporarily-install-a-web-extension-folder-in-macOS-Safari).

## Search and inspect

- The bundled database covers every entry linked from the [official 2026 Listings index](https://pdg.lbl.gov/2026/listings/contents_listings.html), including low-star resonances, charge states, antiparticles, and listing/search topics. No star-rating cutoff is applied.
- The generated catalog has 1,196 entries: 1,171 particle/charge-state records and 25 listing topics. All 458 identifiers in the official index are covered. There are 1,140 records with usable numeric masses and 56 without one. Coverage is recorded in `data/catalog-coverage.json`.
- An energy window is **target mass ± tolerance**, in MeV. For a combination this means the sum of constituent masses. It is a kinematic candidate search; it does not predict binding energies, production rates, or whether an interaction is allowed.
- Unknown quantum numbers propagate into combinations. If the known numbers satisfy the requested constraints, an unresolved candidate is displayed in **pink** with **Quantum number undetermined**. A known conflicting quantum number still excludes it. A low star rating by itself does not imply unknown quantum numbers.
- Results per certainty category reserves separate space for determined and undetermined matches. Equivalent results are condensed, including charge/excitation variants from the same particle families (such as ππN), with the combined card showing their mass range; orbital assignments that differ only by L are also condensed. The worker searches single particles first and retains the closest matches it finds. Broad searches stop after a time/work budget and explicitly report partial results; narrow the filters for a complete search. Cancel and Reset terminate the running worker.
- Select the shown result cards to make a mass-axis plot. Blocks are centered on each combination's summed mass; their width approximates the sum of the constituents' PDG Breit–Wigner widths. Stable or weakly decaying constituents are treated as zero-width at the MeV scale; a hatched marker means a resonance width is unavailable. This is not a measured width for the combined system. PDG range widths use their midpoint.
- Search the catalog by particle name or PDG identifier. **Summary**, **Mass measurements**, and **pdgLive** provide independent ways to inspect result data. A missing Summary Table entry does not imply the particle is absent from the Listings.

Example: set Text filter to `M029`, Max particles to `1`, target mass to `3942`, tolerance to `5`, and total spin `2J` to `4`. X(3940) remains visible in pink because its spin is undetermined. For two X(3940) constituents, set Max particles to `2`, mass to `7884`, and tolerance to `10`.

## Official PDG API

[PDG API overview](https://pdg.lbl.gov/2026/api/index.html) · [REST documentation](https://pdgapi.lbl.gov/doc/restapi.html) · [Python API](https://pdgapi.lbl.gov/doc/pythonapi.html) · [database schema](https://pdgapi.lbl.gov/doc/schema.html)

PDG recommends the bulk SQLite database or Python API for complete datasets. The REST API is for incidental access, below two requests per second. The extension bundles the generated database extract and uses one shared, cached REST queue with at least 650 ms between request starts.

- `https://pdgapi.lbl.gov/info`: edition and release metadata.
- `https://pdgapi.lbl.gov/summaries/B121`: N(2700) summary, when available.
- `https://pdgapi.lbl.gov/listings/B121M`: the mass property's individual listing measurements.

`/listings` supplies measurements; `/summaries` supplies PDG summary values. Property identifiers must come from the database: appending `M` to a particle ID is not a general solution, because mass data may have multiple charge-dependent properties or be nested under section headings.

With the official Python package, enumerate `api.get_particles()` and use `particle.masses(require_summary_data=False)` when examining mass properties that may lack a Summary Table value. This is especially relevant to less-established states. The [PDG N and Delta resonance review](https://pdg.lbl.gov/2026/reviews/rpp2026-rev-n-delta-resonances.pdf) explains why one- and two-star states are not promoted to the Baryon Summary Table.

## Refresh the bundled catalog

Python 3.10+ and its standard library are sufficient:

```powershell
python scripts/build_catalog.py --download
```

This downloads the official 2026.0 SQLite release and Listings index into `.cache/pdg`, generates `data/particles.js`, and validates complete index coverage. Run without `--download` to reproduce the extract from cached files. The edition and URLs are explicitly pinned in the script. See `data/RESONANCE_CATALOG.md` for selection rules and provenance.

## Validation

```powershell
node --test tests/*.test.mjs
```

The optional `scripts/smoke-test.cjs` uses Playwright and a browser supporting unpacked extension loading. `PLAYWRIGHT_MODULE` and `PDG_TEST_BROWSER` can supply local installation paths. It creates an isolated profile under `.cache`, loads the actual Manifest V3 extension, and tests the popup, worker, pagination, pink results, energy/quantum filters, API rendering with fixtures, cancellation, and offline searches.

## Data attribution

F. Takahashi et al. (Particle Data Group), *Int. J. Mod. Phys. A* **41**, 2630011 (2026). Data are [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The generated extract converts units, adds derived additive quantum numbers, and selects representative mass values as documented; it is not an official PDG product.
