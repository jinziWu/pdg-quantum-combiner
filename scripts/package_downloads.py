#!/usr/bin/env python3
"""Build browser-specific ZIP downloads from the shared extension source."""

from __future__ import annotations

import argparse
import re
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parents[1]
EXTENSION_FILES = (
    "README.md",
    "manifest.json",
    "popup.html",
    "popup.css",
    "popup.js",
    "pdg-api.js",
    "search-engine.js",
    "search-worker.js",
    "data/particles.js",
    "data/catalog-metadata.json",
    "data/catalog-coverage.json",
    "data/RESONANCE_CATALOG.md",
)


def write_zip(destination: Path, folder_name: str, *, safari: bool = False) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(destination, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for relative in EXTENSION_FILES:
            source = ROOT / relative
            if not source.is_file():
                raise FileNotFoundError(f"Required extension file is missing: {relative}")
            archive.write(source, f"{folder_name}/{relative}")
        if safari:
            instructions = ROOT / "docs" / "INSTALL-SAFARI.md"
            archive.write(instructions, f"{folder_name}/INSTALL-SAFARI.md")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", help="Package version; defaults to manifest.json")
    parser.add_argument("--output", type=Path, default=ROOT / "dist")
    args = parser.parse_args()

    import json

    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    version = args.version or manifest["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", version):
        parser.error("version must look like 0.3.0")
    if version != manifest["version"]:
        parser.error(f"version {version} does not match manifest version {manifest['version']}")

    chrome_zip = args.output / "PDG-Quantum-Combiner-Chrome.zip"
    safari_zip = args.output / "PDG-Quantum-Combiner-Safari-macOS.zip"
    write_zip(chrome_zip, f"PDG-Quantum-Combiner-Chrome-{version}")
    write_zip(safari_zip, f"PDG-Quantum-Combiner-Safari-{version}", safari=True)
    print(f"Created {chrome_zip}")
    print(f"Created {safari_zip}")


if __name__ == "__main__":
    main()
