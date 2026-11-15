// Run with a local Playwright installation; environment overrides are optional.
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

(async () => {
  const root = path.resolve(__dirname, "..");
  const context = await chromium.launchPersistentContext(path.join(root, ".cache/browser-smoke"), {
    headless: true,
    executablePath: process.env.PDG_TEST_BROWSER || undefined,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  const failures = [];
  try {
    const page = await context.newPage();
    page.on("pageerror", (error) => failures.push(error.message));
    await page.goto("chrome://extensions");
    const extensions = await page.evaluate(() => new Promise((resolve) =>
      chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true, includeTerminated: true }, resolve)));
    const extension = extensions.find((e) => e.name === "PDG Quantum Combiner");
    assert.ok(extension, "Extension was loaded");
    assert.equal(extension.state, "ENABLED");
    assert.deepEqual(extension.manifestErrors, []);

    // Deterministic fixtures verify UI rendering; live endpoint probes are separate.
    let offline = false;
    const apiRequests = [];
    await context.route("https://pdgapi.lbl.gov/**", async (route) => {
      apiRequests.push(route.request().url());
      if (offline) return route.abort("internetdisconnected");
      const url = new URL(route.request().url());
      const id = url.pathname.split("/").pop();
      const payload = url.pathname === "/info" ? { edition: "2026" }
        : url.pathname.startsWith("/listings/") ? {
          pdgid: id, description: "Listing mass measurement",
          measurements: [{ document_id: "TEST 2026", measurement_values: [
            { column_name: "VALUE", value_text: "3942 +- 9", unit: "MeV" }
          ] }]
        } : {
          pdgid: id, description: "State summary", summaries: { properties: [
            { pdgid: "M029M", description: "MASS", pdg_values: [{ value_text: "3942 +- 9", unit: "MeV" }] }
          ] }
        };
      await route.fulfill({ json: payload });
    });
    await page.setViewportSize({ width: 620, height: 900 });
    await page.goto(`chrome-extension://${extension.id}/popup.html`);
    await page.locator("#catalog-status").filter({ hasText: "1,196" }).waitFor();
    await page.locator("#api-status.ok").waitFor();
    assert.equal(await page.locator("h2").filter({ hasText: "All Particle Listings" }).count(), 0);
    assert.match(await page.locator("#catalog-status").textContent(), /1,196 catalog entries/);

    async function search({ text = "", count = "1", mass = "", tolerance = "5", spin = "", charge = "" } = {}) {
      await page.locator("#reset-btn").click();
      await page.locator("#text-filter").fill(text);
      await page.locator("#max-count").selectOption(count);
      await page.locator("#target-mass").fill(mass);
      await page.locator("#mass-tolerance").fill(tolerance);
      await page.locator("#target-spin2").fill(spin);
      await page.locator("#target-charge").fill(charge);
      await page.locator("#search-form button[type=submit]").click();
      await page.waitForFunction(() => /shown/.test(document.querySelector("#result-count").textContent), null, { timeout: 20000 });
    }

    await search({ text: "B121", mass: "2612", spin: "13" });
    assert.equal(await page.locator("#results .result-card").count(), 4, "Low-star high-mass state and antiparticles found");
    assert.equal(await page.locator("#results .quantum-undetermined").count(), 0);

    await search({ text: "M029", mass: "3942", spin: "4" });
    assert.equal(await page.locator("#results .quantum-undetermined").count(), 1);
    assert.match(await page.locator("#results .quantum-badge").textContent(), /Quantum number undetermined/);
    assert.equal(await page.locator("#results .quantum-undetermined").evaluate((e) => getComputedStyle(e).backgroundColor), "rgb(255, 240, 246)");
    await page.locator("#results .result-summary").click();
    await page.locator("#result-detail-0").filter({ hasText: "3942" }).waitFor();
    await page.locator("#results .result-measurements").click();
    await page.locator("#result-detail-0").filter({ hasText: "TEST 2026" }).waitFor();
    await fs.mkdir(path.join(root, ".cache/test-artifacts"), { recursive: true });
    await page.locator("#results").screenshot({ path: path.join(root, ".cache/test-artifacts/undetermined-results.png") });

    await search({ text: "M029", mass: "3942", charge: "1" });
    assert.equal(await page.locator("#results .result-card").count(), 0, "Known charge conflict excluded");
    await search({ text: "M029", count: "2", mass: "7884", tolerance: "10", spin: "4" });
    assert.ok(await page.locator("#results .quantum-undetermined").count() > 0, "Undetermined combination included");
    assert.match(await page.locator("#results").textContent(), /X\(3940\) \+ X\(3940\)/);
    await search({ text: "M029", mass: "3900", tolerance: "1" });
    assert.equal(await page.locator("#results .result-card").count(), 0, "Outside energy range excluded");

    await page.locator("#pdg-id-input").fill("S016M");
    await page.locator("#pdg-endpoint").selectOption("listings");
    await page.locator("#pdg-form button").click();
    await page.locator("#pdg-lookup-result").filter({ hasText: "TEST 2026" }).waitFor();
    offline = true;
    await page.reload();
    await page.locator("#api-status.error").waitFor();
    await search({ text: "M029", mass: "3942", spin: "4" });
    assert.equal(await page.locator("#results .quantum-undetermined").count(), 1, "Offline search works");
    // A broad search must remain cancellable.
    await page.locator("#reset-btn").click();
    await page.locator("#max-count").selectOption("4");
    await page.locator("#search-form button[type=submit]").click();
    await page.locator("#cancel-btn").click();
    assert.match(await page.locator("#result-count").textContent(), /cancelled/);
    assert.deepEqual(failures, [], "No uncaught popup or worker integration errors");
    assert.ok(apiRequests.some((url) => url.endsWith("/listings/M029M")));
    console.log("PASS: MV3 load, catalog paging/coverage, low-star state, pink unknown state and combination, known conflicts, energy bounds, summary/measurement buttons, offline search, cancellation; no page errors.");
  } finally {
    await context.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
