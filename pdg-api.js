export const PDG_API_BASE = "https://pdgapi.lbl.gov";
export const PDG_LIVE_BASE = "https://pdglive.lbl.gov";

// One queue covers metadata, direct lookups, and result buttons. PDG requires
// fewer than two REST requests per second, including requests that fail.
export function createPdgClient({
  fetchImpl = globalThis.fetch,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  intervalMs = 650,
  timeoutMs = 15000
} = {}) {
  const cache = new Map();
  let queue = Promise.resolve();
  let nextRequestAt = 0;

  function get(path) {
    if (cache.has(path)) return cache.get(path);
    const request = queue.then(async () => {
      await wait(Math.max(0, nextRequestAt - now()));
      nextRequestAt = now() + intervalMs;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${PDG_API_BASE}${path}`, {
          headers: { Accept: "application/json" },
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`PDG API returned ${response.status}`);
        const payload = await response.json();
        if (payload.status_code >= 400) {
          throw new Error(payload.status_message || `PDG API returned ${payload.status_code}`);
        }
        return payload;
      } finally {
        clearTimeout(timeout);
      }
    });
    cache.set(path, request);
    queue = request.catch(() => {});
    request.catch(() => cache.delete(path));
    return request;
  }
  return { get };
}

export function summaryProperties(payload) {
  if (Array.isArray(payload?.pdg_values)) return [payload];
  const sections = Array.isArray(payload?.summaries) ? payload.summaries : [payload?.summaries];
  return sections.flatMap((section) => section?.properties || []);
}

export function formatPdgValue(value) {
  if (!value) return "No value supplied";
  const text = value.value_text ?? value.display_value ?? value.value ?? "No numeric value";
  return `${text}${value.unit ? ` ${value.unit}` : ""}`;
}
