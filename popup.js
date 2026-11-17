import { PARTICLES, CATALOG_INFO } from "./data/particles.js";
import { PDG_API_BASE, PDG_LIVE_BASE, createPdgClient, summaryProperties, formatPdgValue } from "./pdg-api.js";

if (new URLSearchParams(location.search).get("wide") === "1") {
  document.body.classList.add("wide-workspace");
}

const $ = (selector) => document.querySelector(selector);
const api = createPdgClient();
const labels = { charge: "Q", baryon: "B", lepton: "Lepton", strangeness: "S", charm: "Charm", bottom: "Bottomness", top: "Topness", isospin2: "I", spin2: "J", parity: "P", cParity: "C parity" };
const numberFields = { charge: "charge", baryon: "baryon", lepton: "lepton", strangeness: "strangeness", charm: "charm", bottom: "bottom", top: "top", isospin2: "isospin2", spin2: "spin2" };
let worker = null;
let searchId = 0;
let visiblePlotResults = [];
let plotFilters = null;
const selectedPlotIndices = new Set();

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
function optionalNumber(id) {
  const value = $(id).value.trim();
  return value === "" ? null : Number(value);
}
function buildTargets() {
  return {
    text: $("#text-filter").value.trim().toLowerCase(),
    families: [...document.querySelectorAll('input[name="family-filter"]:checked')].map((input) => input.value),
    maxCount: Number($("#max-count").value), resultLimit: Number($("#result-limit").value),
    targetMass: optionalNumber("#target-mass"), massTolerance: optionalNumber("#mass-tolerance") ?? 0,
    orbitalL: optionalNumber("#target-orbital-l"), parity: optionalNumber("#target-parity"), cParity: optionalNumber("#target-c-parity"),
    totals: Object.fromEntries(Object.entries(numberFields).map(([key, id]) => [key, optionalNumber(`#target-${id}`)]))
  };
}
function massText(value) {
  return Number.isFinite(value) ? `${value.toLocaleString(undefined, { maximumFractionDigits: 6 })} MeV` : "Mass undetermined";
}
function qValue(value, doubled = false) {
  if (!Number.isFinite(value)) return "?";
  return doubled && value % 2 !== 0 ? `${value}/2` : String(doubled ? value / 2 : value);
}
function sign(value) { return value === 1 ? "+" : value === -1 ? "−" : "?"; }
function quantumLine(particle) {
  return `Q=${qValue(particle.charge)}, I=${qValue(particle.isospin2, true)}, J=${qValue(particle.spin2, true)}, P=${sign(particle.parity)}, C=${particle.cParityApplicable === false ? "n/a" : sign(particle.cParity)}`;
}
function unknownBadge(fields) {
  return fields.length ? `<div class="quantum-badge">Quantum number undetermined</div><div class="help-text">Undetermined: ${escapeHtml(fields.map((key) => labels[key] || key).join(", "))}</div>` : "";
}
function particleNotes(particle) {
  const notes = [particle.massNote, ...(Array.isArray(particle.quantumNotes) ? particle.quantumNotes : particle.quantumNotes ? [particle.quantumNotes] : [])].filter(Boolean);
  if (particle.stars != null) notes.push(`PDG status: ${particle.stars}`);
  if (Number.isFinite(particle.bwWidth?.valueMeV)) notes.push(`${particle.bwWidth.source || "Width estimate"}: ${particle.bwWidth.display || `${particle.bwWidth.valueMeV} MeV`}${particle.bwWidth.pdgId ? ` (${particle.bwWidth.pdgId})` : ""}`);
  return notes.length ? `<div class="help-text">${notes.map(escapeHtml).join(" · ")}</div>` : "";
}
function massIds(particle) {
  return particle.massPdgIds || particle.pdgMassIds || (particle.pdgMassId ? [particle.pdgMassId] : []);
}
function sourceLinks(particle) {
  if (!particle.pdgApiId) return "";
  return `<a class="inline-link" href="${PDG_LIVE_BASE}/Particle.action?node=${encodeURIComponent(particle.pdgApiId)}" target="_blank" rel="noreferrer">pdgLive: ${escapeHtml(particle.pdgApiId)}</a>`;
}
function renderSummary(payload) {
  const properties = summaryProperties(payload);
  const content = properties.map((property) => `<div class="measurement"><strong>${escapeHtml(property.description || property.pdgid)}</strong><br>${(property.pdg_values || []).map((v) => escapeHtml(formatPdgValue(v))).join("<br>")}<br><a href="${PDG_API_BASE}/listings/${encodeURIComponent(property.pdgid)}" target="_blank" rel="noreferrer">Listing measurements (${escapeHtml(property.pdgid)})</a></div>`).join("");
  return `<strong>${escapeHtml(payload.description || payload.pdgid || "PDG summary")}</strong>${content || '<p class="help-text">No summary value is published here. Open pdgLive or the mass measurements to inspect the Particle Listing.</p>'}`;
}
function renderMeasurements(payload) {
  const measurements = payload.measurements || [];
  const content = measurements.map((measurement) => `<div class="measurement"><strong>${escapeHtml(measurement.document_id || measurement.publication_name || "Measurement")}</strong>${measurement.technique ? ` · ${escapeHtml(measurement.technique)}` : ""}<br>${(measurement.measurement_values || []).map((value) => `${escapeHtml(value.column_name || "VALUE")}: ${escapeHtml(formatPdgValue(value))}`).join("<br>")}${measurement.comment ? `<div>${escapeHtml(measurement.comment)}</div>` : ""}</div>`).join("");
  return `<strong>${escapeHtml(payload.description || payload.pdgid)}</strong>${payload.note ? `<p class="help-text">${escapeHtml(payload.note)}</p>` : ""}${content || '<p class="help-text">No measurements returned for this property. Check its pdgLive page.</p>'}`;
}
async function loadParticleData(particles, kind, container, button) {
  container.hidden = false;
  container.textContent = "Loading PDG data…";
  button.disabled = true;
  const blocks = [];
  const requests = new Map();
  for (const particle of particles) {
    const ids = kind === "listings" ? massIds(particle) : [particle.pdgApiId].filter(Boolean);
    for (const id of ids) requests.set(id, particle);
  }
  try {
    for (const [id, particle] of requests) {
      try {
        const payload = await api.get(`/${kind}/${encodeURIComponent(id)}`);
        blocks.push(`<details open><summary>${escapeHtml(particle.symbol || particle.name)} — ${escapeHtml(id)}</summary>${kind === "listings" ? renderMeasurements(payload) : renderSummary(payload)}</details>`);
      } catch (error) {
        blocks.push(`<div class="help-text">${escapeHtml(id)}: ${escapeHtml(error.message)}. ${sourceLinks(particle)}</div>`);
      }
      container.innerHTML = blocks.join("");
    }
    if (!requests.size) container.textContent = "No property identifier is available. Open the linked Particle Listing.";
  } finally { button.disabled = false; }
}
function allowed(values) { return values?.length ? `{${values.map((v) => qValue(v, true)).join(", ")}}` : "?"; }
function familyStem(particle) {
  const raw = String(particle.symbol || particle.name || "").replace(/bar/g, "");
  if (/^(?:p|n)$/i.test(raw)) return "N";
  return raw.match(/^[A-Za-z]+/)?.[0] || raw;
}
function resonanceFamily(particle) {
  // Collapse charge states, particle/antiparticle labels and excitations;
  // proton/neutron belong to the common N isospin family.
  return `${particle.family || "other"}:${familyStem(particle)}`;
}
function familyCombinationLabel(result) {
  const counts = new Map();
  for (const particle of result.combination) {
    const stem = familyStem(particle);
    counts.set(stem, (counts.get(stem) || 0) + 1);
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b))
    .map(([stem, count]) => `${plotSymbol(stem)}${count > 1 ? ` × ${count}` : ""}`).join(" + ");
}
function massRangeText(minimum, maximum) {
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return "Mass unavailable";
  const fmt = (value) => value.toLocaleString(undefined, { maximumFractionDigits: 6 });
  return minimum === maximum ? `${fmt(minimum)} MeV` : `${fmt(minimum)}–${fmt(maximum)} MeV`;
}
function summarySignature(result) {
  const s = result.summary;
  return JSON.stringify([s.charge, s.baryon, s.lepton, s.strangeness, s.charm, s.bottom, s.top,
    s.allowedTotalI2, s.allowedTotalJ2, s.parity, s.cParityApplicable, s.cParity,
    s.orbitalL, Math.round(s.massMeV * 1e6), result.quantumUndetermined]);
}
function condenseResults(results) {
  const buckets = new Map();
  for (const result of results) {
    const families = result.combination.map(resonanceFamily).sort();
    const familySignature = families.join("+");
    const additiveSignature = JSON.stringify(["charge", "baryon", "lepton", "strangeness", "charm", "bottom", "top"]
      .map((key) => result.summary[key]));
    // Equal family composition and equal quantum-number/mass outcome is a
    // degenerate duplicate; keep one representative. Multi-particle resonance
    // variants share a family card while preserving the distinct outcomes.
    const key = result.combination.length === 1
      ? `single:${familySignature}:${summarySignature(result)}`
      : `multi:${familySignature}:${additiveSignature}:u${result.quantumUndetermined}`;
    if (!buckets.has(key)) buckets.set(key, { ...result, variants: [], variantMasses: [], orbitalOutcomes: new Map() });
    const bucket = buckets.get(key);
    const label = result.combination.map((p) => p.symbol || p.name).join(" + ");
    if (!bucket.variants.includes(label)) {
      bucket.variants.push(label);
      if (Number.isFinite(result.summary.massMeV)) bucket.variantMasses.push(result.summary.massMeV);
    }
    const s = result.summary;
    const outcome = `${s.orbitalL == null ? "n/a" : s.orbitalL}: I=${allowed(s.allowedTotalI2)}, J=${allowed(s.allowedTotalJ2)}, P=${sign(s.parity)}, C=${s.cParityApplicable === false ? "n/a" : sign(s.cParity)}`;
    bucket.orbitalOutcomes.set(outcome, outcome);
  }
  return [...buckets.values()].map((result) => ({
    ...result,
    familyVariantCount: result.variants.length,
    familyLabel: familyCombinationLabel(result),
    massMinMeV: result.variantMasses.length ? Math.min(...result.variantMasses) : result.summary.massMeV,
    massMaxMeV: result.variantMasses.length ? Math.max(...result.variantMasses) : result.summary.massMeV,
    orbitalOutcomes: [...result.orbitalOutcomes.values()]
  }));
}
function renderResultCard(result, index) {
  const s = result.summary;
  const fields = result.unknownQuantumNumbers || [];
  const names = result.combination.map((p) => p.symbol || p.name).join(" + ");
  const title = result.familyVariantCount > 1 ? `${result.familyLabel} family` : names;
  const massDisplay = massRangeText(result.massMinMeV, result.massMaxMeV);
  return `<article class="result-card ${result.quantumUndetermined ? "quantum-undetermined" : ""}">
    <div class="result-title"><h3>${escapeHtml(title)}</h3><strong>${escapeHtml(massDisplay)}</strong><label class="plot-select"><input class="plot-result-checkbox" type="checkbox" data-index="${index}" aria-label="Select ${escapeHtml(title)} for the mass plot"><span>Plot</span></label></div>
    ${result.familyVariantCount > 1 ? `<div class="help-text">${result.familyVariantCount} same-family combinations: ${result.variants.map(escapeHtml).join("; ")}</div>` : ""}
    ${result.quantumUndetermined ? unknownBadge(fields.length ? fields : ["Unresolved total"]) : ""}
    <div class="result-meta">
      <div>${["charge", "baryon", "lepton", "strangeness", "charm", "bottom", "top"].map((key) => `${labels[key]}=${qValue(s[key])}`).join(", ")}</div>
      ${result.orbitalOutcomes.length > 1 ? result.orbitalOutcomes.map((outcome) => `<div>${escapeHtml(outcome)}</div>`).join("") : `<div>I=${allowed(s.allowedTotalI2)}, J=${allowed(s.allowedTotalJ2)}, P=${sign(s.parity)}, C=${s.cParityApplicable === false ? "n/a" : sign(s.cParity)}${s.orbitalL == null ? "" : `, L=${s.orbitalL}`}</div>`}
      ${result.massDelta == null ? "" : (result.massMinMeV !== result.massMaxMeV
        ? `<div>Mass-range delta: ${(result.massMinMeV - plotFilters.targetMass).toFixed(6)} to ${(result.massMaxMeV - plotFilters.targetMass).toFixed(6)} MeV</div>`
        : `<div>Mass delta: ${result.massDelta >= 0 ? "+" : ""}${result.massDelta.toFixed(6)} MeV</div>`)}
    </div>
    <details><summary>Constituent values and sources</summary>${result.combination.map((p) => `<p class="help-text"><strong>${escapeHtml(p.name)}</strong> · ${massText(p.massMeV)}<br>${escapeHtml(quantumLine(p))}</p>${particleNotes(p)}${sourceLinks(p)}`).join("")}</details>
    <div class="result-actions"><button class="inline-button result-summary" data-index="${index}" type="button">Load PDG summaries</button>${result.combination.some((p) => massIds(p).length) ? `<button class="inline-button result-measurements" data-index="${index}" type="button">Mass measurements</button>` : ""}</div>
    <div class="pdg-details" id="result-detail-${index}" hidden></div>
  </article>`;
}
function svgNode(tag, attrs = {}, textContent = null) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (textContent != null) node.textContent = textContent;
  return node;
}
function plotQuantumLines(result) {
  const s = result.summary;
  return [
    `Q=${qValue(s.charge)} B=${qValue(s.baryon)} Lepton=${qValue(s.lepton)} S=${qValue(s.strangeness)} Charm=${qValue(s.charm)}`,
    `Bottom=${qValue(s.bottom)} Top=${qValue(s.top)} I=${allowed(s.allowedTotalI2)} J=${allowed(s.allowedTotalJ2)} P=${sign(s.parity)} C-parity=${s.cParityApplicable === false ? "n/a" : sign(s.cParity)}`
  ];
}
function plotWidth(result) {
  const widths = result.combination.map((particle) => particle.bwWidth?.valueMeV);
  if (widths.some((width) => !Number.isFinite(width) || width < 0)) return null;
  return widths.reduce((sum, width) => sum + width, 0);
}
const greekSymbols = [
  ["Delta", "Δ"], ["Lambda", "Λ"], ["Sigma", "Σ"], ["Omega", "Ω"], ["Xi", "Ξ"],
  ["alpha", "α"], ["beta", "β"], ["gamma", "γ"], ["delta", "δ"], ["epsilon", "ε"],
  ["theta", "θ"], ["kappa", "κ"], ["lambda", "λ"], ["mu", "μ"], ["nu", "ν"],
  ["pi", "π"], ["rho", "ρ"], ["sigma", "σ"], ["tau", "τ"], ["phi", "φ"], ["chi", "χ"],
  ["psi", "ψ"], ["omega", "ω"]
];
function plotSymbol(name) {
  let value = String(name).replace(/([A-Za-z]+)bar/g, "$1̄");
  for (const [source, symbol] of greekSymbols) value = value.replaceAll(source, symbol);
  const subscript = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉", s: "ₛ", c: "꜀", b: "ᵦ", t: "ₜ" };
  const superscript = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "*": "⁎", bar: "̄" };
  value = value.replace(/_([A-Za-z0-9]+)/g, (_, token) => [...token].map((char) => subscript[char] || char).join(""));
  value = value.replace(/\^([A-Za-z0-9*+-]+)/g, (_, token) => [...token].map((char) => superscript[char] || char).join(""));
  const charge = value.match(/(\+\+|--|\+|-|0)$/)?.[0];
  if (charge) {
    value = value.slice(0, -charge.length);
    value += [...charge].map((char) => superscript[char] || char).join("");
  }
  return value;
}
function latexParticle(name) {
  let value = String(name).replace(/([A-Za-z]+)bar/g, "\\bar{$1}");
  for (const [source, symbol] of greekSymbols) value = value.replaceAll(source, `\\${source}`);
  value = value.replace(/_([A-Za-z0-9]+)/g, "_{$1}").replace(/\^([A-Za-z0-9*+-]+)/g, "^{$1}");
  const charge = value.match(/(\+\+|--|\+|-|0)$/)?.[0];
  if (charge) value = `${value.slice(0, -charge.length)}^{${charge}}`;
  return value;
}
function updatePlotSelectionControls() {
  const count = selectedPlotIndices.size;
  const button = $("#plot-selected-results");
  button.textContent = `Plot selected (${count})`;
  button.disabled = count === 0;
  $("#clear-plot-selection").disabled = count === 0;
}
function renderMassPlot(selectedResults) {
  const svg = $("#mass-plot");
  const scroll = $("#mass-plot-scroll");
  const width = Math.max(1320, scroll.clientWidth || 1320);
  const plotLeft = 58;
  const plotRight = width - 58;
  const plotWidthPx = plotRight - plotLeft;
  const top = 28;
  const requestedTarget = Number.isFinite(plotFilters?.targetMass) ? plotFilters.targetMass : null;
  const masses = selectedResults.map(({ result }) => result.summary.massMeV).filter(Number.isFinite);
  const target = requestedTarget ?? (masses.length ? (Math.min(...masses) + Math.max(...masses)) / 2 : 0);
  const tolerance = Math.max(0, Number.isFinite(plotFilters?.massTolerance) ? plotFilters.massTolerance : 0);
  const fallbackSpan = Math.max(2, (masses.length ? Math.max(...masses) - Math.min(...masses) : 2) * 1.08);
  const halfSpan = tolerance > 0 ? tolerance : fallbackSpan / 2;
  const minimum = target - halfSpan;
  const maximum = target + halfSpan;
  const x = (mass) => plotLeft + ((mass - minimum) / (maximum - minimum)) * plotWidthPx;
  const prepared = selectedResults.map(({ result }, index) => {
    const symbols = result.combination.map((particle) => plotSymbol(particle.symbol || particle.name));
    const fullLabel = symbols.join(" + ");
    const compactLabel = symbols.map((symbol) => symbol.replace(/\([^)]*\)/g, "")).join("");
    const latex = result.combination.map((particle) => latexParticle(particle.symbol || particle.name)).join(" + ");
    const physicalWidth = plotWidth(result);
    const scaledWidth = physicalWidth === null ? null : (physicalWidth / (maximum - minimum)) * plotWidthPx;
    const label = scaledWidth !== null && scaledWidth >= fullLabel.length * 7 + 16 ? fullLabel : compactLabel;
    const locator = scaledWidth === null || physicalWidth === 0;
    const blockWidth = locator ? Math.max(42, label.length * 6.5 + 16) : Math.max(3, scaledWidth);
    const labelWidth = Math.min(plotWidthPx * 0.92, Math.max(38, label.length * 8.2 + 16));
    const massMin = Number.isFinite(result.massMinMeV) ? result.massMinMeV : result.summary.massMeV;
    const massMax = Number.isFinite(result.massMaxMeV) ? result.massMaxMeV : result.summary.massMeV;
    const centerMass = (massMin + massMax) / 2;
    const center = x(centerMass);
    const layoutWidth = Math.max(blockWidth, labelWidth) + 12;
    return { result, index, label, latex, physicalWidth, massMin, massMax, centerMass, blockWidth, locator, center,
      left: Math.max(plotLeft, center - layoutWidth / 2), right: Math.min(plotRight, center + layoutWidth / 2) };
  }).sort((a, b) => a.center - b.center || a.index - b.index);
  const laneEnds = [];
  for (const item of prepared) {
    let lane = laneEnds.findIndex((right) => right <= item.left);
    if (lane < 0) lane = laneEnds.length;
    item.lane = lane;
    laneEnds[lane] = item.right;
  }
  const maxHeight = Math.max(44, ...prepared.map((item) => 40 + item.lane * 25));
  const axisY = top + maxHeight + 18;
  const height = axisY + 45;
  svg.replaceChildren();
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);

  const defs = svgNode("defs");
  const clip = svgNode("clipPath", { id: "mass-plot-clip" });
  clip.append(svgNode("rect", { x: plotLeft, y: 0, width: plotWidthPx, height }));
  defs.append(clip);
  const hatch = svgNode("pattern", { id: "unknown-width-hatch", width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" });
  hatch.append(svgNode("rect", { width: 6, height: 6, fill: "#f7f0df" }), svgNode("line", { x1: 0, y1: 0, x2: 0, y2: 6, stroke: "#68727a", "stroke-width": 2 }));
  defs.append(hatch);
  svg.append(defs);

  const tickValues = tolerance > 0
    ? [{ value: minimum, label: minimum.toLocaleString(undefined, { maximumFractionDigits: 3 }), kind: "edge" },
      { value: target, label: target.toLocaleString(undefined, { maximumFractionDigits: 3 }), kind: "target" },
      { value: maximum, label: maximum.toLocaleString(undefined, { maximumFractionDigits: 3 }), kind: "edge" }]
    : [{ value: target, label: target.toLocaleString(undefined, { maximumFractionDigits: 3 }), kind: "target" }];
  for (const tick of tickValues) {
    const tickX = x(tick.value);
    svg.append(svgNode("line", { x1: tickX, y1: top - 10, x2: tickX, y2: axisY, class: tick.kind === "target" ? "plot-target-guide" : "plot-tolerance-guide" }));
    svg.append(svgNode("line", { x1: tickX, y1: axisY - 5, x2: tickX, y2: axisY + 5, class: "plot-axis-tick" }));
    svg.append(svgNode("text", { x: tickX, y: axisY + 22, "text-anchor": "middle", class: "plot-axis-label" }, tick.label));
  }
  svg.append(svgNode("line", { x1: plotLeft, y1: axisY, x2: plotRight, y2: axisY, class: "plot-real-axis" }));
  svg.append(svgNode("text", { x: (plotLeft + plotRight) / 2, y: height - 4, "text-anchor": "middle", class: "plot-axis-caption" }, "Total mass (MeV) · tick marks show target and target ± tolerance"));

  const palette = ["#88cfa4", "#82aee8", "#d4b553", "#a89add", "#7bbdb9", "#e4a164", "#cf82a0"];
  for (const item of [...prepared].sort((a, b) => b.lane - a.lane || b.blockWidth - a.blockWidth)) {
    const { result, index, label, latex, physicalWidth, massMin, massMax, centerMass, blockWidth, locator, center, lane } = item;
    const names = result.combination.map((particle) => particle.symbol || particle.name).join(" + ");
    const quantum = plotQuantumLines(result).join("; ");
    const boxHeight = 40 + lane * 25;
    const boxY = axisY - boxHeight;
    const known = physicalWidth !== null;
    const left = center - blockWidth / 2;
    const fill = !known ? "url(#unknown-width-hatch)" : (result.quantumUndetermined ? "#ef9bc3" : palette[index % palette.length]);
    const stroke = result.quantumUndetermined ? "#a83d70" : `hsl(${(index * 137.508) % 360} 48% 38%)`;
    const block = svgNode("rect", { x: left, y: boxY, width: blockWidth, height: boxHeight, fill, "fill-opacity": known ? 0.45 : 0.62, stroke,
      "stroke-width": 1.6, "stroke-dasharray": !known ? "4 3" : (locator ? "2 2" : "none"), "clip-path": "url(#mass-plot-clip)" });
    let widthDescription;
    if (!known) widthDescription = "Breit-Wigner width unavailable for at least one constituent; locator width shown.";
    else widthDescription = `Approximate summed constituent Breit-Wigner width: ${physicalWidth.toLocaleString(undefined, { maximumFractionDigits: 4 })} MeV. This is not a measured width for the combined system.${locator ? " A labeled locator box is used because the width is zero at this scale." : ""}`;
    if (result.combination.some((particle) => particle.bwWidth?.isRange)) widthDescription += " At least one PDG range is represented by its midpoint.";
    if (result.combination.some((particle) => particle.bwWidth?.source === "stable/long-lived state approximation")) widthDescription += " Stable or weakly decaying constituents are treated as zero-width at the MeV scale.";
    block.append(svgNode("title", {}, `${names} · LaTeX: ${latex} · mass range ${massRangeText(massMin, massMax)} · center ${centerMass.toFixed(6)} MeV · ${widthDescription}`));
    svg.append(block);
  }
  for (const item of prepared) {
    if (!(item.massMax > item.massMin)) continue;
    const left = x(item.massMin), right = x(item.massMax), y = axisY - 5;
    svg.append(svgNode("line", { x1: left, y1: y, x2: right, y2: y, class: "plot-variant-range", "clip-path": "url(#mass-plot-clip)" }));
    svg.append(svgNode("line", { x1: left, y1: y - 4, x2: left, y2: y + 2, class: "plot-variant-range", "clip-path": "url(#mass-plot-clip)" }));
    svg.append(svgNode("line", { x1: right, y1: y - 4, x2: right, y2: y + 2, class: "plot-variant-range", "clip-path": "url(#mass-plot-clip)" }));
  }
  for (const item of prepared) {
    const { result, label, latex, blockWidth, center, lane } = item;
    const boxHeight = 40 + lane * 25;
    const labelY = axisY - boxHeight + 21;
    const fontSize = Math.max(4.5, Math.min(12, (blockWidth - 8) / Math.max(1, label.length * 0.58)));
    const text = svgNode("text", { x: center, y: labelY, "text-anchor": "middle", "font-size": fontSize, class: "plot-box-label",
      "clip-path": "url(#mass-plot-clip)" }, label);
    text.append(svgNode("title", {}, `LaTeX: ${latex}; quantum numbers: ${plotQuantumLines(result).join("; ")}`));
    svg.append(text);
    if (result.quantumUndetermined) {
      svg.append(svgNode("text", { x: center, y: labelY + 12, "text-anchor": "middle", class: "plot-undetermined-mark", "clip-path": "url(#mass-plot-clip)" }, "?"));
    }
  }
  const hasUnknownWidth = selectedResults.some(({ result }) => plotWidth(result) === null);
  const hasRange = selectedResults.some(({ result }) => result.combination.some((particle) => particle.bwWidth?.isRange));
  const hasNegligible = selectedResults.some(({ result }) => result.combination.some((particle) => particle.bwWidth?.source === "stable/long-lived state approximation"));
  const hasZeroWidth = selectedResults.some(({ result }) => plotWidth(result) === 0);
  $("#plot-width-note").textContent = `Overlapping boxes share the mass axis; height only separates labels and is not a physical quantity. Positive box widths approximate summed constituent PDG Breit–Wigner widths, not a measured width of the combined system. Short brackets mark mass ranges across grouped family variants. Pink marks undetermined quantum numbers. ${hasUnknownWidth ? "Hatched boxes are label locators because a constituent width is unavailable; their width is not physical." : ""} ${hasZeroWidth ? "Zero-width combinations use a labeled locator box." : ""} ${hasRange ? "PDG width ranges use their midpoint." : ""} ${hasNegligible ? "Stable or weakly decaying states are treated as zero-width at the MeV scale." : ""} The label uses LaTeX-style particle notation; hover for the exact LaTeX expression.`;
  $("#mass-plot-panel").hidden = false;
}
function renderResults(report, filters) {
  const condensed = condenseResults(report.results);
  // Keep individually matching states visible even when their family has fewer
  // than three members in the current query. The family threshold is relevant
  // only to condensation; applying it as a visibility filter hid valid states
  // such as N(1440) in a direct mass and quantum-number search.
  const ordered = [...condensed.filter((r) => !r.quantumUndetermined), ...condensed.filter((r) => r.quantumUndetermined)];
  visiblePlotResults = ordered;
  plotFilters = filters;
  selectedPlotIndices.clear();
  $("#plot-toolbar").hidden = ordered.length === 0;
  $("#mass-plot-panel").hidden = true;
  updatePlotSelectionControls();
  const unknownCount = ordered.filter((r) => r.quantumUndetermined).length;
  $("#result-count").textContent = `${ordered.length} shown · ${unknownCount} undetermined`;
  const notices = [];
  if (!report.searchComplete) notices.push("Search stopped at its computation budget; results are partial. Narrow the mass window, particle families, or maximum particle count.");
  const omitted = typeof report.omittedResults === "number" ? report.omittedResults
    : (report.omittedResults?.determined || 0) + (report.omittedResults?.undetermined || 0);
  if (omitted) notices.push(`${omitted.toLocaleString()} additional matches were omitted by the display limit. Increase results per category or narrow the search.`);
  if (report.missingMassCount) notices.push(`${report.missingMassCount} matching catalog entries have no usable numeric mass, so they cannot be confirmed within this energy window.`);
  let previousCategory = null;
  $("#results").innerHTML = `${notices.length ? `<div class="result-notice">${notices.map(escapeHtml).join("<br>")}</div>` : ""}<p class="help-text">Checked ${Number(report.visitedCombinations).toLocaleString()} particle combinations. ${report.searchComplete ? "Search complete." : "Partial search."}</p>` + ordered.map((result, index) => {
    const category = result.quantumUndetermined ? "Quantum number undetermined" : "Determined quantum numbers";
    const heading = previousCategory !== category ? `<h3 class="result-section-title">${category}</h3>` : "";
    previousCategory = category;
    return heading + renderResultCard(result, index);
  }).join("") + (ordered.length ? "" : '<div class="empty-state">No eligible combinations found in the searched space. Try a wider energy window or fewer quantum-number constraints.</div>');
  for (const [selector, kind] of [[".result-summary", "summaries"], [".result-measurements", "listings"]]) {
    document.querySelectorAll(selector).forEach((button) => button.addEventListener("click", () => {
      const index = Number(button.dataset.index);
      loadParticleData(ordered[index].combination, kind, $(`#result-detail-${index}`), button);
    }));
  }
  document.querySelectorAll(".plot-result-checkbox").forEach((checkbox) => checkbox.addEventListener("change", () => {
    const index = Number(checkbox.dataset.index);
    if (checkbox.checked) selectedPlotIndices.add(index);
    else selectedPlotIndices.delete(index);
    updatePlotSelectionControls();
  }));
}
$("#select-all-results").addEventListener("click", () => {
  selectedPlotIndices.clear();
  visiblePlotResults.forEach((_, index) => selectedPlotIndices.add(index));
  document.querySelectorAll(".plot-result-checkbox").forEach((checkbox) => { checkbox.checked = true; });
  updatePlotSelectionControls();
});
$("#clear-plot-selection").addEventListener("click", () => {
  selectedPlotIndices.clear();
  document.querySelectorAll(".plot-result-checkbox").forEach((checkbox) => { checkbox.checked = false; });
  $("#mass-plot-panel").hidden = true;
  updatePlotSelectionControls();
});
$("#plot-selected-results").addEventListener("click", () => {
  const selected = [...selectedPlotIndices].sort((a, b) => a - b).map((index) => ({ result: visiblePlotResults[index] }));
  if (selected.length) renderMassPlot(selected);
});
function cancelSearch() {
  if (worker) worker.terminate();
  worker = null;
  $("#cancel-btn").hidden = true;
}
$("#search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  cancelSearch();
  const filters = buildTargets();
  const id = ++searchId;
  visiblePlotResults = [];
  selectedPlotIndices.clear();
  $("#plot-toolbar").hidden = true;
  $("#mass-plot-panel").hidden = true;
  $("#result-count").textContent = "Searching…";
  $("#results").innerHTML = '<div class="empty-state">Searching the bundled PDG catalog…</div>';
  $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
  $("#cancel-btn").hidden = false;
  try {
    worker = new Worker(new URL("./search-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      if (data.id !== id) return;
      if (data.type === "progress") $("#result-count").textContent = `Searching… ${data.progress.visitedCombinations.toLocaleString()} checked`;
      if (data.type === "result") { cancelSearch(); renderResults(data.result, filters); }
      if (data.type === "error") { cancelSearch(); $("#result-count").textContent = "Search failed"; $("#results").textContent = data.message; }
    };
    worker.onerror = () => { cancelSearch(); $("#results").textContent = "Unable to start the search worker. Reload the extension and try again."; $("#result-count").textContent = "Search failed"; };
    worker.postMessage({ type: "search", id, particles: PARTICLES, filters });
  } catch (error) { cancelSearch(); $("#results").textContent = error.message; }
});
$("#cancel-btn").addEventListener("click", () => { cancelSearch(); $("#result-count").textContent = "Search cancelled"; $("#results").textContent = "Search cancelled. Narrow the filters and search again."; });
$("#reset-btn").addEventListener("click", () => { cancelSearch(); $("#search-form").reset(); $("#result-count").textContent = "No search yet."; $("#results").innerHTML = '<div class="empty-state">Set an energy window and any quantum numbers, or leave fields blank.</div>'; });
$("#pdg-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = $("#pdg-id-input").value.trim().toUpperCase();
  const kind = $("#pdg-endpoint").value;
  if (!/^[A-Z][A-Z0-9]*(?:\.[0-9]+)?(?:\/[0-9]{4})?$/.test(id)) { $("#pdg-lookup-result").textContent = "Enter a PDG identifier, such as S016 or S016M."; return; }
  $("#pdg-lookup-result").textContent = "Fetching PDG data…";
  try {
    const payload = await api.get(`/${kind}/${encodeURIComponent(id)}`);
    $("#pdg-lookup-result").innerHTML = `${kind === "listings" ? renderMeasurements(payload) : renderSummary(payload)}<a href="${PDG_API_BASE}/${kind}/${encodeURIComponent(id)}" target="_blank" rel="noreferrer">Open complete API JSON</a>`;
  } catch (error) { $("#pdg-lookup-result").textContent = `Lookup failed: ${error.message}`; }
});

$("#catalog-status").textContent = `PDG ${CATALOG_INFO.edition || ""} · ${PARTICLES.length.toLocaleString()} catalog entries · searches available offline.`;
$("#reset-btn").click();
api.get("/info").then((info) => {
  $("#api-status").className = "status-card ok";
  $("#api-status").textContent = `PDG API connected · live edition ${info.edition}. Bundled search catalog: ${CATALOG_INFO.edition || "see catalog notes"}.`;
}).catch(() => {
  $("#api-status").className = "status-card error";
  $("#api-status").textContent = "PDG API unavailable. The complete bundled catalog remains searchable offline.";
});
