// All masses are in MeV; angular momentum/isospin are stored doubled.
// This is a kinematic candidate search, not a bound-state or decay prediction.
export const ADDITIVE_FIELDS = [
  "charge", "baryon", "lepton", "strangeness", "charm", "bottom", "top"
];

const ANGULAR_FIELDS = { spin2: "allowedTotalJ2", isospin2: "allowedTotalI2" };
const EPSILON = 1e-7;

export function doesParticleMatchPoolFilters(particle, filters = {}) {
  const text = String(filters.text || "").trim().toLowerCase();
  const haystack = [
    particle.name, particle.symbol, particle.family, particle.pdgApiId,
    particle.description, ...(particle.aliases || [])
  ].join(" ").toLowerCase();
  if (text && !haystack.includes(text)) return false;
  return !filters.families?.length || filters.families.includes(particle.family);
}

function couple(values, seed = [0]) {
  if (values.some((value) => !Number.isInteger(value) || value < 0)) return null;
  return values.reduce((totals, value) => {
    const next = new Set();
    for (const total of totals) {
      for (let result = Math.abs(total - value); result <= total + value; result += 2) {
        next.add(result);
      }
    }
    return [...next].sort((a, b) => a - b);
  }, seed);
}

function sumKnown(values) {
  return values.every(Number.isFinite) ? values.reduce((a, b) => a + b, 0) : null;
}

function particleCApplicability(particle) {
  if (typeof particle.cParityApplicable === "boolean") return particle.cParityApplicable;
  if (Number.isFinite(particle.cParity)) return true;
  if (ADDITIVE_FIELDS.some((key) => Number.isFinite(particle[key]) && particle[key] !== 0)) {
    return false;
  }
  return ADDITIVE_FIELDS.every((key) => particle[key] === 0) ? true : null;
}

export function buildCombinationSummary(combination, orbitalL = 0) {
  if (!combination.length) throw new Error("A combination must contain at least one particle.");
  const single = combination.length === 1;
  const summary = {
    massMeV: sumKnown(combination.map((particle) => particle.massMeV)),
    // A single particle has its listed J and intrinsic P; relative L is inapplicable.
    orbitalL: single ? null : orbitalL,
    allowedIntrinsicSpin2: couple(combination.map((particle) => particle.spin2)),
    allowedTotalI2: couple(combination.map((particle) => particle.isospin2))
  };
  for (const key of ADDITIVE_FIELDS) {
    summary[key] = sumKnown(combination.map((particle) => particle[key]));
  }
  summary.allowedTotalJ2 = single || !summary.allowedIntrinsicSpin2
    ? summary.allowedIntrinsicSpin2
    : couple([orbitalL * 2], summary.allowedIntrinsicSpin2);
  const parities = combination.map((particle) => particle.parity);
  summary.parity = parities.every((value) => value === 1 || value === -1)
    ? parities.reduce((a, b) => a * b, 1) * (single || orbitalL % 2 === 0 ? 1 : -1)
    : null;

  if (single) {
    summary.cParityApplicable = particleCApplicability(combination[0]);
    summary.cParity = summary.cParityApplicable === false
      ? null
      : (Number.isFinite(combination[0].cParity) ? combination[0].cParity : null);
  } else if (combination.every((particle) => particleCApplicability(particle) === true)) {
    // C acts on each self-conjugate constituent; it does not invert relative space.
    // No (-1)^L factor is applied to a product of individual C eigenstates.
    summary.cParityApplicable = true;
    summary.cParity = combination.every((particle) => Number.isFinite(particle.cParity))
      ? combination.reduce((total, particle) => total * particle.cParity, 1)
      : null;
  } else {
    summary.cParityApplicable = ADDITIVE_FIELDS.some((key) => Number.isFinite(summary[key]) && summary[key] !== 0)
      ? false : null;
    // Neutral particle/antiparticle arrangements need an eigenstate construction.
    // Keep that assignment unknown instead of guessing from names or total charge.
    summary.cParity = null;
  }
  return summary;
}

export function unknownQuantumNumbers(summary) {
  const unknown = ADDITIVE_FIELDS.filter((key) => !Number.isFinite(summary[key]));
  for (const [key, summaryKey] of Object.entries(ANGULAR_FIELDS)) {
    if (!summary[summaryKey]) unknown.push(key);
  }
  if (!Number.isFinite(summary.parity)) unknown.push("parity");
  if (summary.cParityApplicable !== false && !Number.isFinite(summary.cParity)) unknown.push("cParity");
  return unknown;
}

// A result is visibly undetermined only when a requested quantum number is
// missing. Unknown values for unconstrained fields don't affect eligibility.
export function undeterminedQuantumNumbers(summary, filters = {}) {
  const unknown = [];
  for (const key of ADDITIVE_FIELDS) {
    if (Number.isFinite(filters.totals?.[key]) && !Number.isFinite(summary[key])) unknown.push(key);
  }
  if (Number.isFinite(filters.totals?.isospin2) && !summary.allowedTotalI2) unknown.push("isospin2");
  if (Number.isFinite(filters.totals?.spin2) && !summary.allowedTotalJ2) unknown.push("spin2");
  if (Number.isFinite(filters.parity) && !Number.isFinite(summary.parity)) unknown.push("parity");
  if (Number.isFinite(filters.cParity) && summary.cParityApplicable !== false && !Number.isFinite(summary.cParity)) {
    unknown.push("cParity");
  }
  return unknown;
}

export function matchesTargets(summary, filters = {}) {
  for (const key of ADDITIVE_FIELDS) {
    const target = filters.totals?.[key];
    if (Number.isFinite(target) && Number.isFinite(summary[key]) && Math.abs(summary[key] - target) > EPSILON) {
      return false;
    }
  }
  for (const [key, summaryKey] of Object.entries(ANGULAR_FIELDS)) {
    const target = filters.totals?.[key];
    if (Number.isFinite(target) && summary[summaryKey] && !summary[summaryKey].includes(target)) return false;
  }
  if (Number.isFinite(filters.parity) && Number.isFinite(summary.parity) && filters.parity !== summary.parity) {
    return false;
  }
  if (Number.isFinite(filters.cParity)) {
    if (summary.cParityApplicable === false) return false;
    if (Number.isFinite(summary.cParity) && filters.cParity !== summary.cParity) return false;
  }
  // L only applies to combinations; it never changes an individual listed state.
  if (Number.isFinite(filters.targetMass)) {
    if (!Number.isFinite(summary.massMeV)) return false;
    if (Math.abs(summary.massMeV - filters.targetMass) > (filters.massTolerance ?? 0) + EPSILON) return false;
  }
  return true;
}

function positiveInteger(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function resultOrder(left, right) {
  const leftDistance = left.massDelta === null ? left.summary.massMeV : Math.abs(left.massDelta);
  const rightDistance = right.massDelta === null ? right.summary.massMeV : Math.abs(right.massDelta);
  return leftDistance - rightDistance ||
    left.combination.length - right.combination.length ||
    (left.summary.orbitalL ?? -1) - (right.summary.orbitalL ?? -1) ||
    left.key.localeCompare(right.key);
}

// A bounded sorted collection keeps the nearest results encountered in the whole
// traversal. Reaching the display limit never ends the traversal.
function retainBest(bucket, result, limit) {
  if (bucket.length >= limit && resultOrder(result, bucket[bucket.length - 1]) >= 0) return;
  let low = 0;
  let high = bucket.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (resultOrder(bucket[middle], result) <= 0) low = middle + 1;
    else high = middle;
  }
  bucket.splice(low, 0, result);
  if (bucket.length > limit) bucket.pop();
}

/**
 * filters: text, families, maxCount (1..4), resultLimit (per certainty category),
 * targetMass ± massTolerance, orbitalL (blank searches 0..3 for composites),
 * parity, cParity, totals {charge,baryon,lepton,strangeness,charm,bottom,top,
 * isospin2,spin2}. Null always means unknown/unconstrained, never zero.
 *
 * options: maxVisited (partial + complete traversal nodes), maxDurationMs,
 * yieldEvery, signal, onProgress, determinedLimit, undeterminedLimit.
 * Result caps and incomplete enumeration are reported independently.
 */
export async function searchCombinations(particles, inputFilters = {}, options = {}) {
  const startTime = performance.now();
  const filters = {
    ...inputFilters,
    maxCount: Math.min(4, positiveInteger(inputFilters.maxCount, 3)),
    targetMass: Number.isFinite(inputFilters.targetMass) ? inputFilters.targetMass : null,
    massTolerance: Number.isFinite(inputFilters.massTolerance) ? Math.max(0, inputFilters.massTolerance) : 0,
    orbitalL: Number.isInteger(inputFilters.orbitalL) && inputFilters.orbitalL >= 0
      ? inputFilters.orbitalL : null
  };
  const resultLimit = positiveInteger(inputFilters.resultLimit, 20);
  const limits = {
    determined: positiveInteger(options.determinedLimit, resultLimit),
    undetermined: positiveInteger(options.undeterminedLimit, resultLimit)
  };
  const maxVisited = positiveInteger(options.maxVisited, 500000);
  const maxDurationMs = positiveInteger(options.maxDurationMs, 30000);
  const yieldEvery = positiveInteger(options.yieldEvery, 256);
  const filtered = particles.filter((particle) => doesParticleMatchPoolFilters(particle, filters));
  const pool = filtered
    .filter((particle) => Number.isFinite(particle.massMeV) && particle.massMeV >= 0)
    .sort((a, b) => a.massMeV - b.massMeV);
  const missingMassCount = filtered.length - pool.length;
  const lowerMass = filters.targetMass === null ? 0 : Math.max(0, filters.targetMass - filters.massTolerance);
  const upperMass = filters.targetMass === null ? Infinity : filters.targetMass + filters.massTolerance;
  const orbitals = filters.orbitalL === null ? [0, 1, 2, 3] : [filters.orbitalL];
  const retained = { determined: [], undetermined: [] };
  const matches = { determined: 0, undetermined: 0 };
  const reasons = [];
  let visitedNodes = 0;
  let visitedCombinations = 0;
  let evaluatedStates = 0;
  let stopped = false;
  let lastProgress = startTime;

  const progress = () => ({
    visitedNodes, visitedCombinations, evaluatedStates,
    matchedCount: matches.determined + matches.undetermined,
    elapsedMs: Math.round(performance.now() - startTime)
  });
  async function checkpoint(force = false, enforceBudget = true) {
    if (stopped) return false;
    if (options.signal?.aborted) {
      stopped = true;
      reasons.push("cancelled");
      return false;
    }
    if (enforceBudget && visitedNodes >= maxVisited) {
      stopped = true;
      reasons.push("visit-limit");
      return false;
    }
    if (!force && visitedNodes % yieldEvery !== 0) return true;
    const now = performance.now();
    if (enforceBudget && now - startTime >= maxDurationMs) {
      stopped = true;
      reasons.push("time-limit");
      return false;
    }
    if (force || now - lastProgress >= 250) {
      options.onProgress?.(progress());
      lastProgress = now;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    return true;
  }

  function evaluate(combination, mass) {
    visitedCombinations += 1;
    if (mass < lowerMass - EPSILON || mass > upperMass + EPSILON) return;
    const combinationKey = combination.map((particle) =>
      String(particle.id ?? particle.pdgApiId ?? particle.name) + ":" + String(particle.symbol)
    ).join("|");
    for (const orbitalL of combination.length === 1 ? [0] : orbitals) {
      evaluatedStates += 1;
      const summary = buildCombinationSummary(combination, orbitalL);
      if (!matchesTargets(summary, filters)) continue;
      const unknown = undeterminedQuantumNumbers(summary, filters);
      const category = unknown.length ? "undetermined" : "determined";
      matches[category] += 1;
      retainBest(retained[category], {
        combination: [...combination],
        summary,
        massDelta: filters.targetMass === null ? null : summary.massMeV - filters.targetMass,
        quantumUndetermined: unknown.length > 0,
        unknownQuantumNumbers: unknown,
        key: combinationKey
      }, limits[category]);
    }
  }

  // Always inspect every single finite-mass state first. A busy multiparticle
  // search cannot starve heavy resonances from the single-particle results.
  for (const particle of pool) {
    visitedNodes += 1;
    if (!await checkpoint(false, false)) break;
    evaluate([particle], particle.massMeV);
  }

  const combination = [];
  const largestMass = pool[pool.length - 1]?.massMeV ?? 0;
  async function walk(startIndex, remaining, mass) {
    if (stopped || startIndex >= pool.length) return;
    if (mass + remaining * pool[startIndex].massMeV > upperMass + EPSILON) return;
    if (mass + remaining * largestMass < lowerMass - EPSILON) return;
    // At the last constituent, binary-search directly into the mass window.
    if (remaining === 1 && lowerMass > mass) {
      let low = startIndex;
      let high = pool.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (pool[middle].massMeV < lowerMass - mass - EPSILON) low = middle + 1;
        else high = middle;
      }
      startIndex = low;
    }
    for (let index = startIndex; index < pool.length && !stopped; index += 1) {
      const particle = pool[index];
      // Repeated particles are allowed; indices remain nondecreasing to avoid
      // permutation duplicates, including when constituents have zero mass.
      if (mass + remaining * particle.massMeV > upperMass + EPSILON) break;
      visitedNodes += 1;
      if (!await checkpoint()) break;
      combination.push(particle);
      const nextMass = mass + particle.massMeV;
      if (remaining === 1) evaluate(combination, nextMass);
      else await walk(index, remaining - 1, nextMass);
      combination.pop();
    }
  }
  for (let count = 2; count <= filters.maxCount && !stopped; count += 1) {
    await walk(0, count, 0);
  }

  const omittedResults = {
    determined: matches.determined - retained.determined.length,
    undetermined: matches.undetermined - retained.undetermined.length
  };
  const searchComplete = !stopped;
  if (omittedResults.determined || omittedResults.undetermined) reasons.push("result-limit");
  const results = [...retained.determined, ...retained.undetermined]
    .sort(resultOrder)
    .map(({ key, ...result }) => result);
  return {
    results,
    truncated: reasons.length > 0,
    truncationReasons: reasons,
    searchComplete,
    cancelled: reasons.includes("cancelled"),
    ...progress(),
    matchedDetermined: matches.determined,
    matchedUndetermined: matches.undetermined,
    omittedResults,
    limits,
    poolSize: pool.length,
    filteredParticleCount: filtered.length,
    missingMassCount
  };
}
