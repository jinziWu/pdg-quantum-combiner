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
function resonanceFamily(particle) {
  // Collapse charge states and excitation labels to the shared PDG family stem
  // (for example N(940) and N(1440) both become N).
  const symbol = String(particle.symbol || particle.name || "").replace(/^[A-Za-z]+/, (stem) => stem);
  const stem = symbol.match(/^[A-Za-z]+/)?.[0] || symbol;
  return `${particle.family || "other"}:${stem}`;
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
    // Equal family composition and equal quantum-number/mass outcome is a
    // degenerate duplicate; keep one representative. Multi-particle resonance
    // variants share a family card while preserving the distinct outcomes.
    const key = result.combination.length === 1
      ? `single:${familySignature}:${summarySignature(result)}`
      : `multi:${familySignature}:u${result.quantumUndetermined}`;
    if (!buckets.has(key)) buckets.set(key, { ...result, variants: [], orbitalOutcomes: new Map() });
    const bucket = buckets.get(key);
    const label = result.combination.map((p) => p.symbol || p.name).join(" + ");
    if (!bucket.variants.includes(label)) bucket.variants.push(label);
    const s = result.summary;
    const outcome = `${s.orbitalL == null ? "n/a" : s.orbitalL}: I=${allowed(s.allowedTotalI2)}, J=${allowed(s.allowedTotalJ2)}, P=${sign(s.parity)}, C=${s.cParityApplicable === false ? "n/a" : sign(s.cParity)}`;
    bucket.orbitalOutcomes.set(outcome, outcome);
  }
  return [...buckets.values()].map((result) => ({ ...result, familyVariantCount: result.variants.length, orbitalOutcomes: [...result.orbitalOutcomes.values()] }));
}
function renderResultCard(result, index) {
  const s = result.summary;
  const fields = result.unknownQuantumNumbers || [];
  const names = result.combination.map((p) => p.symbol || p.name).join(" + ");
  return `<article class="result-card ${result.quantumUndetermined ? "quantum-undetermined" : ""}">
    <div class="result-title"><h3>${escapeHtml(names)}</h3><strong>${massText(s.massMeV)}</strong></div>
    ${result.familyVariantCount > 1 ? `<div class="help-text">${result.familyVariantCount} degenerate or same-family variants: ${result.variants.map(escapeHtml).join("; ")}</div>` : ""}
    ${result.quantumUndetermined ? unknownBadge(fields.length ? fields : ["Unresolved total"]) : ""}
    <div class="result-meta">
      <div>${["charge", "baryon", "lepton", "strangeness", "charm", "bottom", "top"].map((key) => `${labels[key]}=${qValue(s[key])}`).join(", ")}</div>
      ${result.orbitalOutcomes.length > 1 ? result.orbitalOutcomes.map((outcome) => `<div>${escapeHtml(outcome)}</div>`).join("") : `<div>I=${allowed(s.allowedTotalI2)}, J=${allowed(s.allowedTotalJ2)}, P=${sign(s.parity)}, C=${s.cParityApplicable === false ? "n/a" : sign(s.cParity)}${s.orbitalL == null ? "" : `, L=${s.orbitalL}`}</div>`}
      ${result.massDelta == null ? "" : `<div>Mass delta: ${result.massDelta >= 0 ? "+" : ""}${result.massDelta.toFixed(6)} MeV</div>`}
    </div>
    <details><summary>Constituent values and sources</summary>${result.combination.map((p) => `<p class="help-text"><strong>${escapeHtml(p.name)}</strong> · ${massText(p.massMeV)}<br>${escapeHtml(quantumLine(p))}</p>${particleNotes(p)}${sourceLinks(p)}`).join("")}</details>
    <div class="result-actions"><button class="inline-button result-summary" data-index="${index}" type="button">Load PDG summaries</button>${result.combination.some((p) => massIds(p).length) ? `<button class="inline-button result-measurements" data-index="${index}" type="button">Mass measurements</button>` : ""}</div>
    <div class="pdg-details" id="result-detail-${index}" hidden></div>
  </article>`;
}
function renderResults(report) {
  const condensed = condenseResults(report.results);
  // Keep individually matching states visible even when their family has fewer
  // than three members in the current query. The family threshold is relevant
  // only to condensation; applying it as a visibility filter hid valid states
  // such as N(1440) in a direct mass and quantum-number search.
  const ordered = [...condensed.filter((r) => !r.quantumUndetermined), ...condensed.filter((r) => r.quantumUndetermined)];
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
}
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
  $("#result-count").textContent = "Searching…";
  $("#results").innerHTML = '<div class="empty-state">Searching the bundled PDG catalog…</div>';
  $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
  $("#cancel-btn").hidden = false;
  try {
    worker = new Worker(new URL("./search-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      if (data.id !== id) return;
      if (data.type === "progress") $("#result-count").textContent = `Searching… ${data.progress.visitedCombinations.toLocaleString()} checked`;
      if (data.type === "result") { cancelSearch(); renderResults(data.result); }
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
