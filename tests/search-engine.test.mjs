import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCombinationSummary, doesParticleMatchPoolFilters, searchCombinations
} from "../search-engine.js";

function particle(name, massMeV, overrides = {}) {
  return {
    name, symbol: name, family: "meson", pdgApiId: name,
    massMeV, charge: 0, baryon: 0, lepton: 0, strangeness: 0,
    charm: 0, bottom: 0, top: 0, spin2: 0, isospin2: 0,
    parity: 1, cParity: 1, cParityApplicable: true, ...overrides
  };
}

const search = (particles, filters = {}, options = {}) => searchCombinations(particles, {
  maxCount: 1, resultLimit: 100, orbitalL: 0, ...filters
}, { maxDurationMs: 30000, ...options });

test("heavy listing state with unknown spin survives the spin target as undetermined", async () => {
  const heavy = particle("X(6900)", 6900, { spin2: null });
  const result = await search([heavy], { targetMass: 6900, massTolerance: 10, totals: { spin2: 4 } });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].quantumUndetermined, true);
  assert.ok(result.results[0].unknownQuantumNumbers.includes("spin2"));
});

test("a known mismatch still rejects a particle whose other numbers are unknown", async () => {
  const state = particle("X", 4000, { spin2: null, charge: 1 });
  const result = await search([state], { totals: { spin2: 4, charge: 0 } });
  assert.equal(result.results.length, 0);
});

test("missing additive quantities propagate instead of becoming zero", async () => {
  const state = particle("X", 1000, { strangeness: null });
  const summary = buildCombinationSummary([state, particle("Y", 1000)], 0);
  assert.equal(summary.strangeness, null);
  const result = await search([state], { totals: { strangeness: 2 } });
  assert.ok(result.results[0].unknownQuantumNumbers.includes("strangeness"));
});

test("the total mass window admits lighter constituents and excludes outside results", async () => {
  const result = await search([particle("A", 400), particle("B", 600), particle("outside", 1020)], {
    maxCount: 2, targetMass: 1000, massTolerance: 5
  });
  assert.equal(result.results.length, 1);
  assert.deepEqual(result.results[0].combination.map((p) => p.name), ["A", "B"]);
  assert.equal(result.results[0].summary.massMeV, 1000);
});

test("relative orbital L does not change a single particle's J or parity", async () => {
  const result = await search([particle("A", 1000, { spin2: 2, parity: -1 })], {
    orbitalL: 3, parity: -1, totals: { spin2: 2 }
  });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].summary.orbitalL, null);
  assert.deepEqual(result.results[0].summary.allowedTotalJ2, [2]);
  assert.equal(result.results[0].summary.parity, -1);
});

test("null mass is not zero and a real zero-mass particle remains searchable", async () => {
  const result = await search([particle("missing", null), particle("photon", 0)], {
    targetMass: 0, massTolerance: 0, maxCount: 2
  });
  assert.equal(result.missingMassCount, 1);
  assert.equal(result.results.length, 2);
  assert.ok(result.results.every((r) => r.combination.every((p) => p.name === "photon")));
});

test("C inapplicable is separate from unknown, and cannot satisfy a C target", async () => {
  const charged = particle("charged", 100, {
    charge: 1, cParity: null, cParityApplicable: false
  });
  const unconstrained = await search([charged]);
  assert.equal(unconstrained.results[0].quantumUndetermined, false);
  const constrained = await search([charged], { cParity: 1 });
  assert.equal(constrained.results.length, 0);
  const unknown = await search([particle("neutral", 100, { cParity: null })], { cParity: 1 });
  assert.ok(unknown.results[0].unknownQuantumNumbers.includes("cParity"));
});

test("C product of self-conjugate constituents has no spurious orbital sign", () => {
  const summary = buildCombinationSummary([
    particle("A", 100, { cParity: -1 }), particle("B", 100, { cParity: -1 })
  ], 1);
  assert.equal(summary.cParity, 1);
  assert.equal(summary.parity, -1);
});

test("display caps keep closest results and reserve space for undetermined states", async () => {
  const states = [
    particle("light", 1), particle("heavy", 999),
    particle("unknown-light", 2, { spin2: null }),
    particle("unknown-heavy", 998, { spin2: null })
  ];
  const result = await search(states, {
    targetMass: 1000, massTolerance: 1000, resultLimit: 1,
    // An unknown spin is undetermined only when spin is part of the request.
    totals: { spin2: 0 }
  });
  assert.deepEqual(result.results.map((r) => r.combination[0].name), ["heavy", "unknown-heavy"]);
  assert.equal(result.searchComplete, true);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.omittedResults, { determined: 1, undetermined: 1 });
  assert.deepEqual(result.truncationReasons, ["result-limit"]);
});

test("distinct resonances are not collapsed into a generic family", async () => {
  const result = await search([particle("N(1440)", 1440), particle("N(1520)", 1520)]);
  assert.equal(result.results.length, 2);
});

test("visit budgets are explicit and all single particles are checked first", async () => {
  const states = Array.from({ length: 30 }, (_, i) => particle(`state${i}`, i + 1));
  const result = await search(states, { maxCount: 4, targetMass: 30, massTolerance: 0 }, { maxVisited: 5 });
  assert.ok(result.results.some((r) => r.combination[0].name === "state29"));
  assert.equal(result.searchComplete, false);
  assert.ok(result.truncationReasons.includes("visit-limit"));
  assert.ok(result.visitedCombinations >= 30);
});

test("text/family filtering supports listing identifiers", () => {
  const state = particle("a state", 1000, { pdgApiId: "M999", family: "baryon" });
  assert.equal(doesParticleMatchPoolFilters(state, { text: "m999", families: ["baryon"] }), true);
  assert.equal(doesParticleMatchPoolFilters(state, { text: "m999", families: ["meson"] }), false);
});

test("cancellation is reported without claiming complete enumeration", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await search([particle("A", 100)], {}, { signal: controller.signal });
  assert.equal(result.cancelled, true);
  assert.equal(result.searchComplete, false);
  assert.equal(result.results.length, 0);
});
