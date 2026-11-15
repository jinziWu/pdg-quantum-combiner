import { searchCombinations } from "./search-engine.js";

// The popup terminates the old worker on cancel/reset/a replacement search.
self.addEventListener("message", async ({ data }) => {
  if (data?.type !== "search") return;
  const { id, particles, filters, options } = data;
  try {
    const result = await searchCombinations(particles, filters, {
      ...options,
      onProgress: (progress) => self.postMessage({ type: "progress", id, progress })
    });
    self.postMessage({ type: "result", id, result });
  } catch (error) {
    self.postMessage({ type: "error", id, message: error?.message || String(error) });
  }
});
