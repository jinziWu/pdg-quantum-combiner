#!/usr/bin/env python3
"""Build the extension catalog from the official PDG bulk SQLite release.

Python 3.10+, standard library only. Run from any directory:
    python scripts/build_catalog.py
Use --download to populate .cache/pdg from the official PDG website.
No per-particle API crawling is performed.
"""
from __future__ import annotations

import argparse
import hashlib
import html
from html.parser import HTMLParser
import json
import math
from pathlib import Path
import re
import sqlite3
from urllib.parse import parse_qs, urljoin, urlparse
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
EDITION = "2026"
DB_URL = "https://pdg.lbl.gov/2026/api/pdg-2026.0.sqlite"
LIST_URL = "https://pdg.lbl.gov/2026/listings/contents_listings.html"
MC_URL = "https://pdg.lbl.gov/2026/reviews/rpp2026-rev-monte-carlo-numbering.pdf"
UNITS = {"eV": 1e-6, "keV": 1e-3, "MeV": 1.0, "GeV": 1e3, "TeV": 1e6}
FLAVORS = ("strangeness", "charm", "bottom", "top")
QUANTUM_KEYS = ("charge", "baryon", "lepton", *FLAVORS, "isospin2", "spin2", "parity")


class Element:
    def __init__(self, tag="", attrs=(), parent=None, section=""):
        self.tag, self.attrs, self.parent = tag, dict(attrs), parent
        self.children = []
        self.section = section

    def text(self):
        return "".join(x if isinstance(x, str) else x.text() for x in self.children)

    def walk(self):
        yield self
        for child in self.children:
            if isinstance(child, Element):
                yield from child.walk()


class ListingParser(HTMLParser):
    """A tiny DOM keeps each pdgLive link associated with its PDF and heading."""
    VOID = {"img", "br", "hr", "input", "link", "meta", "source", "wbr"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = self.current = Element()
        self.section = ""

    def handle_starttag(self, tag, attrs):
        node = Element(tag, attrs, self.current, self.section)
        self.current.children.append(node)
        if tag not in self.VOID:
            self.current = node

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in self.VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        node = self.current
        while node.parent is not None and node.tag != tag:
            node = node.parent
        if node.parent is not None:
            if tag == "h4":
                self.section = clean(node.text())
            self.current = node.parent

    def handle_data(self, text):
        self.current.children.append(text)


def clean(text):
    return " ".join(html.unescape(text or "").split())


def read_listings(path):
    parser = ListingParser()
    parser.feed(path.read_text(encoding="utf-8"))
    listings = {}
    for link in parser.root.walk():
        href = link.attrs.get("href", "")
        if link.tag != "a" or "pdglive.lbl.gov/Particle.action" not in href:
            continue
        node_id = parse_qs(urlparse(href).query).get("node", [None])[0]
        if not node_id:
            continue
        row = link.parent
        while row.parent and not (
            "list-group-item" in row.attrs.get("class", "").split()
            or "accordion-contents-split-all-l" in row.attrs.get("class", "").split()
        ):
            row = row.parent
        labels = [
            el for el in row.walk()
            if el.tag == "a" and "iframe" in el.attrs.get("class", "").split()
        ]
        pdfs = [
            urljoin(LIST_URL, el.attrs["href"])
            for el in row.walk()
            if el.tag == "a" and re.search(r"/listings/[^?]+\.pdf$", el.attrs.get("href", ""))
        ]
        listings[node_id] = {
            "pdgId": node_id,
            "title": clean(labels[0].text()) if labels else node_id,
            "section": link.section,
            "listingUrl": pdfs[0] if pdfs else None,
        }
    assert len(listings) > 400, "Listings parsing failed or source format changed"
    return listings


def strict_twice(value):
    if value is None or not re.fullmatch(r"\d+(?:/2)?", value.strip()):
        return None
    return int(value[:-2]) if value.endswith("/2") else 2 * int(value)


def sign_value(value):
    return {"+": 1, "-": -1}.get(value)


def finite(value):
    return isinstance(value, (int, float)) and math.isfinite(value) and value >= 0


def charge_matches(flags, charge):
    specified = set(flags) & set("012")
    if specified and (charge is None or str(int(abs(charge))) not in specified):
        return False
    # Explicit sign flags describe the particle state, but its antiparticle has
    # the same mass by the shared PDG property. Magnitude flags are decisive.
    return True


def additive_numbers(row, family, section):
    """Use PDG MC flavor encoding, then explicit PDG naming/section conventions.

    Never decode spin or parity from an MC ID (assignments can be tentative).
    Never decode the 99xxxxx custom/node range as quark content.
    """
    result = {key: None for key in ("baryon", "lepton", *FLAVORS)}
    name = row["name"]
    mcid = row.get("mcid")
    particle_sign = -1 if (mcid is not None and mcid < 0) or row.get("cc_type") == "A" else 1
    a = abs(mcid or 0)
    if family == "quark" and 1 <= a <= 6:
        result.update(baryon=particle_sign / 3, lepton=0, **dict.fromkeys(FLAVORS, 0))
        if a >= 3:
            result[FLAVORS[a - 3]] = particle_sign * (-1 if a in (3, 5) else 1)
        return result, "PDG Monte Carlo elementary-quark code"
    if family == "lepton" and 11 <= a <= 16:
        result.update(baryon=0, lepton=particle_sign, **dict.fromkeys(FLAVORS, 0))
        return result, "PDG Monte Carlo elementary-lepton code"
    if family == "boson" and a in (21, 22, 23, 24, 25):
        result.update(baryon=0, lepton=0, **dict.fromkeys(FLAVORS, 0))
        return result, "PDG Standard Model gauge/Higgs identity"
    if family not in ("meson", "baryon"):
        return result, "No definite additive assignment extracted"
    result.update(baryon=0 if family == "meson" else particle_sign, lepton=0)
    if a in (130, 310):
        result.update(strangeness=None, charm=0, bottom=0, top=0)
        return result, "K_S/K_L are flavor mixtures; strangeness is undetermined"
    q1, q2, q3 = (a // 1000) % 10, (a // 100) % 10, (a // 10) % 10
    conventional = 100 <= a < 9_900_000 and a % 10 != 0
    constituents = None
    if conventional and family == "meson" and q1 == 0 and 1 <= q2 <= 6 and 1 <= q3 <= 6:
        heavy_sign = 1 if q2 % 2 == 0 else -1
        constituents = [(q2, heavy_sign * particle_sign), (q3, -heavy_sign * particle_sign)]
    elif conventional and family == "baryon" and all(1 <= q <= 6 for q in (q1, q2, q3)):
        constituents = [(q, particle_sign) for q in (q1, q2, q3)]
    if constituents is not None:
        result.update(dict.fromkeys(FLAVORS, 0))
        for flavor, amount in constituents:
            if flavor >= 3:
                result[FLAVORS[flavor - 3]] += amount * (-1 if flavor in (3, 5) else 1)
        return result, "PDG Monte Carlo flavor encoding; spin/parity taken only from explicit quantum fields"
    # PDG Listings sections explicitly state these net flavors. cc_type gives
    # the antiparticle sign. This covers resonances with no assigned MC number.
    flavors = None
    if family == "meson":
        if section.startswith(("Light Unflavored", "c cbar", "b bbar")):
            flavors = (0, 0, 0, 0)
        elif section.startswith("Strange Mesons"):
            flavors = (particle_sign, 0, 0, 0)
        elif section.startswith("Charmed, Strange"):
            flavors = (particle_sign, particle_sign, 0, 0)
        elif section.startswith("Charmed Mesons"):
            flavors = (0, particle_sign, 0, 0)
        elif section.startswith("Bottom, Strange"):
            flavors = (-particle_sign, 0, particle_sign, 0)
        elif section.startswith("Bottom, Charmed"):
            flavors = (0, particle_sign, particle_sign, 0)
        elif section.startswith("Bottom Mesons") and re.match(r"^B(?:bar)?(?:[_*^(0+-])", name):
            flavors = (0, 0, particle_sign, 0)
    else:
        for prefix, strange in (("N Baryons", 0), ("Delta Baryons", 0), ("Lambda Baryons", -1),
                                ("Sigma Baryons", -1), ("XI Baryons", -2), ("Omega Baryons", -3)):
            if section.startswith(prefix):
                flavors = (strange * particle_sign, 0, 0, 0)
        if flavors is None and section.startswith(("Charmed Baryons", "Doubly-charmed", "Bottom Baryons")):
            # Xi_c/b contain one strange quark, Omega_c/b two. Xi_cc/bc
            # contain no strange quark. These are the PDG flavor-name conventions.
            base = name.replace("bar", "")
            heavy = re.match(r"^(?:Lambda|Sigma|Xi|Omega)_([cb]+)", base)
            if heavy:
                heavy_flavor = heavy.group(1)
                strange = -2 if base.startswith("Omega") else (-1 if base.startswith("Xi") else 0)
                if len(heavy_flavor) >= 2:
                    strange = 0
                flavors = (strange * particle_sign, heavy_flavor.count("c") * particle_sign,
                           -heavy_flavor.count("b") * particle_sign, 0)
    if flavors is not None:
        result.update(zip(FLAVORS, flavors))
        return result, "PDG Listings flavor section and particle/antiparticle naming convention"
    # PDG's explicit exotic flavor labels, e.g. T_c_cbar_sbar and P_c_cbar_s.
    if re.match(r"^[TP]_", name):
        prefix = re.split(r"[\d(^]", name, maxsplit=1)[0]
        tokens = re.findall(r"(?:^|[_ ])([scbt])((?:bar)?)(?=[_ ]|$)", prefix[2:] + "_")
        # Match all tokens using independent boundaries (not consuming separators).
        tokens = re.findall(r"(?<![a-z])([scbt])(bar)?(?=[_ ]|$)", prefix[2:])
        if tokens:
            result.update(dict.fromkeys(FLAVORS, 0))
            for flavor, anti in tokens:
                amount = particle_sign * (-1 if anti else 1)
                result[dict(s="strangeness", c="charm", b="bottom", t="top")[flavor]] += (
                    amount * (-1 if flavor in ("s", "b") else 1)
                )
            return result, "Explicit PDG exotic-hadron flavor label (net flavors only)"
    return result, "Unresolved flavor content preserved as null"


def mass_record(prop, row, kind, extra=None):
    factor = UNITS.get(row.get("unit_text"))
    limit = row.get("limit_type")
    value = row.get("value")
    usable = factor is not None and finite(value) and limit in (None, "R")
    display = row.get("display_value_text") or row.get("value_text") or "value unavailable"
    units = row.get("unit_text") or ""
    record = {
        "pdgId": prop["pdgid"], "description": prop["description"],
        "source": kind, "valueMeV": value * factor if usable else None,
        "display": clean(f"{display} {units}"), "limitType": limit,
        "unit": units, "value": value, "conversionToMeV": factor,
    }
    if extra:
        record.update(extra)
    return record


def choose_mass(properties, summaries, measurements, charge, is_particle):
    compatible = [p for p in properties if charge_matches(p["flags"], charge)]
    compatible.sort(key=lambda p: ("D" not in p["flags"], "A" in p["flags"], p["sort"]))
    records = []
    if not is_particle:
        return None, None, "Listing topic/search category; no single particle mass.", [], []
    for prop in compatible:
        for row in sorted(summaries.get(prop["id"], []), key=lambda d: (not d["in_summary_table"], d["sort"] or 0)):
            records.append(mass_record(prop, row, "PDG summary",
                                       {"valueType": row["value_type"], "summaryRowId": row["id"]}))
    valid = [r for r in records if r["valueMeV"] is not None]
    if valid:
        chosen = valid[0]
    elif not records:
        # A lower-significance resonance may have only individual Listings data.
        # Keep its first eligible measurement in PDG display order as an explicitly
        # labelled representative; this is not a fit or a PDG recommended average.
        for prop in compatible:
            for row in measurements.get(prop["id"], []):
                measurement_charge = row.get("measurement_charge") or ""
                if measurement_charge in ("0", "+", "-", "++", "--"):
                    magnitude = 0 if measurement_charge == "0" else len(measurement_charge)
                    if charge is None or abs(charge) != magnitude:
                        continue
                if row["column_name"] not in (None, "VALUE"):
                    continue
                record = mass_record(prop, row, "PDG listing measurement", {
                    "measurementId": row["measurement_id"],
                    "reference": row["document_id"], "referenceYear": row["publication_year"],
                    "doi": row["doi"], "usedInAverage": bool(row["used_in_average"]),
                    "usedInFit": bool(row["used_in_fit"]),
                })
                if record["valueMeV"] is not None and record["limitType"] is None:
                    records.append(record)
                    valid.append(record)
        chosen = valid[0] if valid else None
    else:
        # A published bound must not be replaced by a positive measurement
        # that PDG has not accepted as an established mass (e.g. photon mass).
        chosen = None
    if chosen:
        note = f'{chosen["source"]}: {chosen["pdgId"]}, {chosen["display"]}.'
        if chosen["source"] == "PDG listing measurement":
            note += f' Representative of individual measurements ({chosen["reference"]}); not a PDG average.'
        if chosen["limitType"] == "R":
            note += " PDG range; the supplied central value is used for energy filtering."
        if chosen["conversionToMeV"] != 1:
            note += f' Converted from {chosen["unit"]} to MeV.'
        return chosen["valueMeV"], chosen["source"], note, records, chosen
    note = "No usable measured mass; excluded from energy-window searches."
    if records:
        note += " " + "; ".join(f'{r["pdgId"]}: {r["display"]}' for r in records[:3])
    return None, None, note, records, None


def generate(db_path, listings_path):
    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row
    query = lambda sql: [dict(row) for row in db.execute(sql)]
    info = {r["name"]: r["value"] for r in query("SELECT * FROM pdginfo")}
    assert info["edition"] == EDITION
    listings = read_listings(listings_path)
    identifiers = query("SELECT * FROM pdgid ORDER BY sort")
    id_by_pk = {r["id"]: r for r in identifiers}
    id_by_code = {r["pdgid"]: r for r in identifiers}
    source_particles = query("SELECT * FROM pdgparticle ORDER BY id")
    properties = {}
    for prop in identifiers:
        if prop["data_type"] == "M":
            # Many masses live below SEC headings (rho, f0, top, ...).
            # Walk the official parent relation rather than assuming the
            # immediate parent is the particle or guessing an identifier suffix.
            ancestor = id_by_pk.get(prop["parent_id"])
            seen = set()
            while ancestor and ancestor["data_type"] not in ("PART", "SRCH"):
                assert ancestor["id"] not in seen, "Cyclic PDG identifier hierarchy"
                seen.add(ancestor["id"])
                ancestor = id_by_pk.get(ancestor["parent_id"])
            if ancestor:
                properties.setdefault(ancestor["id"], []).append(prop)
    summaries = {}
    for row in query(f"SELECT * FROM pdgdata WHERE edition='{EDITION}' ORDER BY sort"):
        summaries.setdefault(row["pdgid_id"], []).append(row)
    measurements = {}
    for row in query("""
        SELECT m.pdgid_id,m.id AS measurement_id,m.charge AS measurement_charge,
               v.*,r.document_id,r.publication_year,r.doi
        FROM pdgmeasurement m
        JOIN pdgid i ON i.id=m.pdgid_id AND i.data_type='M'
        JOIN pdgmeasurement_values v ON v.pdgmeasurement_id=m.id
        LEFT JOIN pdgreference r ON r.id=m.pdgreference_id
        ORDER BY i.sort,m.sort,v.sort
    """):
        measurements.setdefault(row["pdgid_id"], []).append(row)
    item_names = {r["id"]: r["name"] for r in query("SELECT * FROM pdgitem")}
    aliases = {}
    for row in query("SELECT * FROM pdgitem_map"):
        # Follow reverse aliases only; generic groups must not manufacture states.
        keys = list(row)
        # Stable schema uses pdgitem_id (alias) and target_id (target).
        if "target_id" in row:
            aliases.setdefault(row["target_id"], []).append(item_names.get(row["pdgitem_id"], ""))
    present = {r["pdgid"] for r in source_particles}
    added = []
    for prop in identifiers:
        if (prop["data_type"] in ("PART", "SRCH") or prop["pdgid"] in listings) and prop["pdgid"] not in present:
            added.append(prop["pdgid"])
            source_particles.append({
                "id": None, "pdgid_id": prop["id"], "pdgid": prop["pdgid"],
                "pdgitem_id": None, "name": prop["description"], "mcid": None,
                "charge": None, "cc_type": None, **dict.fromkeys(
                    ("quantum_i", "quantum_j", "quantum_p", "quantum_c", "quantum_g"), None),
            })
            present.add(prop["pdgid"])
    # A website entry absent even from pdgid remains available as a linked topic.
    for code, listing in listings.items():
        if code not in present:
            prop = {"id": None, "pdgid": code, "description": listing["title"], "flags": "",
                    "data_type": "TOPIC", "sort": 999999}
            id_by_code[code] = prop
            source_particles.append({
                "id": None, "pdgid_id": None, "pdgid": code, "pdgitem_id": None,
                "name": listing["title"], "mcid": None, "charge": None, "cc_type": None,
                **dict.fromkeys(("quantum_i", "quantum_j", "quantum_p", "quantum_c", "quantum_g"), None),
            })
            present.add(code)
            added.append(code)
    particles = []
    for row in source_particles:
        prop = id_by_code[row["pdgid"]]
        listing = listings.get(row["pdgid"], {})
        family = {"B": "baryon", "M": "meson", "L": "lepton", "Q": "quark", "G": "boson"}.get(prop["flags"], "other")
        is_particle = prop["data_type"] == "PART"
        section = listing.get("section", "")
        q, additive_source = additive_numbers(row, family, section) if is_particle else (
            dict.fromkeys(("baryon", "lepton", *FLAVORS)), "Listing topic or search category")
        mass_props = properties.get(row["pdgid_id"], [])
        mass, mass_source, mass_note, mass_data, selected_mass = choose_mass(
            mass_props, summaries, measurements, row["charge"], is_particle)
        p = {
            "id": f'{row["pdgid"]}:{row["id"] if row["id"] is not None else "listing"}',
            "name": row["name"], "symbol": row["name"], "family": family,
            "entryType": "particle" if is_particle else "topic",
            "massMeV": mass, "charge": row["charge"], **q,
            "isospin2": strict_twice(row["quantum_i"]),
            "spin2": strict_twice(row["quantum_j"]), "parity": sign_value(row["quantum_p"]),
            "cParity": None, "cParityApplicable": None,
            "pdgApiId": row["pdgid"], "mcid": row["mcid"],
            "massPdgIds": [m["pdgid"] for m in mass_props],
            "massSource": mass_source, "massNote": mass_note, "massSelection": selected_mass,
            "section": section, "listingUrl": listing.get("listingUrl"),
            "stars": None,
            "quantumSource": additive_source,
            "rawQuantum": {key: row[f"quantum_{key}"] for key in ("i", "j", "p", "c", "g")},
            "aliases": sorted(set(filter(None, [
                prop["description"], listing.get("title", ""), *aliases.get(row["pdgitem_id"], [])
            ])) - {row["name"]}),
        }
        # C is not defined for a charged state or one with nonzero net flavor,
        # baryon number, or lepton number. The database can include the C value
        # of a neutral multiplet member on its charged rows: don't use that.
        inapplicable = (
            p["charge"] not in (None, 0)
            or any(p[key] not in (None, 0) for key in ("baryon", "lepton", *FLAVORS))
            or row["mcid"] in (130, 310, 21)
        )
        if inapplicable:
            p["cParityApplicable"] = False
        elif row["quantum_c"] is not None or (family == "meson" and row["cc_type"] == "S"):
            p["cParityApplicable"] = True
            p["cParity"] = sign_value(row["quantum_c"])
        unknown = [key for key in QUANTUM_KEYS if p[key] is None]
        if p["cParityApplicable"] is not False and p["cParity"] is None:
            unknown.append("cParity")
        p["quantumNotes"] = (
            "Quantum number undetermined: " + ", ".join(unknown) if unknown else ""
        )
        if row["id"] is None and is_particle:
            p["quantumNotes"] += "; no pdgparticle quantum-number mapping in this release"
        particles.append(p)
    coverage = {
        "sourceParticleRows": len(query("SELECT id FROM pdgparticle")),
        "sourceParticleIdentifiers": len(set(r["pdgid"] for r in query("SELECT pdgid FROM pdgparticle"))),
        "sourcePartIdentifiers": len([p for p in identifiers if p["data_type"] == "PART"]),
        "listingIdentifiers": len(listings),
        "listingIdentifiersCovered": len(set(listings) & {p["pdgApiId"] for p in particles}),
        "missingListingIdentifiers": sorted(set(listings) - {p["pdgApiId"] for p in particles}),
        "addedUnmappedIdentifiers": added,
        "stateCount": sum(p["entryType"] == "particle" for p in particles),
        "topicCount": sum(p["entryType"] == "topic" for p in particles),
        "catalogEntryCount": len(particles),
        "massKnownCount": sum(p["massMeV"] is not None for p in particles),
        "massUnknownCount": sum(p["massMeV"] is None for p in particles),
        "listingMeasurementMassCount": sum(p["massSource"] == "PDG listing measurement" for p in particles),
        "rangeMassCount": sum(bool(p["massSelection"] and p["massSelection"]["limitType"] == "R") for p in particles),
        "quantumUndeterminedCount": sum(bool(p["quantumNotes"]) for p in particles),
    }
    catalog_info = {
        "edition": EDITION, "release": "2026.0", "dataReleaseTimestamp": info["data_release_timestamp"],
        "source": DB_URL, "listingsSource": LIST_URL, "mcNumberingSource": MC_URL,
        "citation": clean(re.sub("<[^>]+>", "", info["citation"])),
        "license": info["license"], "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
        "sourceSha256": hashlib.sha256(db_path.read_bytes()).hexdigest(),
        "listingsSha256": hashlib.sha256(listings_path.read_bytes()).hexdigest(),
        **coverage,
        "starsNote": "Star ratings are not a structured field in this bulk database. No star/rating filter is applied.",
    }
    validate(particles, identifiers, listings)
    output = ROOT / "data"
    output.mkdir(exist_ok=True)
    (output / "particles.js").write_text(
        "// Generated by scripts/build_catalog.py from official PDG 2026.0 data (CC BY 4.0).\n"
        "// See data/RESONANCE_CATALOG.md for selection rules, provenance and limitations.\n"
        "export const CATALOG_INFO = " + json.dumps(catalog_info, ensure_ascii=False, indent=2) + ";\n\n"
        "export const PARTICLES = " + json.dumps(particles, ensure_ascii=False, indent=2) + ";\n",
        encoding="utf-8",
    )
    (output / "catalog-metadata.json").write_text(json.dumps(catalog_info, indent=2) + "\n", encoding="utf-8")
    report = {
        **catalog_info,
        "listings": [{**v, "catalogEntryIds": [p["id"] for p in particles if p["pdgApiId"] == code]}
                     for code, v in listings.items()],
    }
    (output / "catalog-coverage.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(coverage, indent=2))


def validate(particles, identifiers, listings):
    assert len({p["id"] for p in particles}) == len(particles), "Duplicate catalog ids"
    ids = {p["pdgApiId"] for p in particles}
    assert set(listings) <= ids, "An official Particle Listing entry was dropped"
    assert {p["pdgid"] for p in identifiers if p["data_type"] == "PART"} <= ids
    for p in particles:
        assert p["massMeV"] is None or finite(p["massMeV"]), p["id"]
        assert p["cParityApplicable"] is not False or p["cParity"] is None, p["id"]
        if p["massSelection"]:
            assert p["massSelection"]["limitType"] in (None, "R"), p["id"]
            assert p["massSelection"]["pdgId"] in p["massPdgIds"], p["id"]
        for key in ("isospin2", "spin2"):
            assert p[key] is None or isinstance(p[key], int), p["id"]
    # These examples exercise lower-star/high-mass states, ambiguous quantum
    # fields, a missing particle mapping, unit conversion, and flavor signs.
    by_name = {p["name"]: p for p in particles}
    by_id = {p["pdgApiId"]: p for p in particles}
    assert by_name["K+"]["strangeness"] == 1
    assert by_name["B+"]["bottom"] == 1  # B+ contains anti-b; bottomness(b) = -1.
    assert by_name["p"]["baryon"] == 1
    assert by_name["pbar"]["baryon"] == -1
    assert by_name["gamma"]["isospin2"] is None
    assert any(p["pdgApiId"] == "M169" and p["massSource"] == "PDG listing measurement" for p in particles)
    assert any("N(2040)" in p["name"] for p in particles)
    assert any("N(2700)" in p["name"] for p in particles)
    assert any("Delta(2950)" in p["name"] for p in particles)
    assert 80_000 < by_name["W+"]["massMeV"] < 81_000
    assert 170_000 < by_name["t"]["massMeV"] < 175_000
    assert 770 < by_name["rho(770)0"]["massMeV"] < 780
    assert by_name["f_0(1370)0"]["massMeV"] == 1350
    assert by_id["M029"]["spin2"] is None  # X(3940)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--cache-dir", type=Path, default=ROOT / ".cache" / "pdg")
    args = parser.parse_args()
    args.cache_dir.mkdir(parents=True, exist_ok=True)
    db_path = args.cache_dir / "pdg-2026.0.sqlite"
    listings_path = args.cache_dir / "listings-2026.html"
    if args.download:
        for url, target in ((DB_URL, db_path), (LIST_URL, listings_path)):
            print(f"Downloading {url}")
            with urlopen(url, timeout=90) as response:
                target.write_bytes(response.read())
    for path in (db_path, listings_path):
        if not path.exists():
            parser.error(f"Missing {path}; use --download once.")
    generate(db_path, listings_path)
