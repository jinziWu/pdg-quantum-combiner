import test from "node:test";
import assert from "node:assert/strict";
import { createPdgClient, summaryProperties, formatPdgValue } from "../pdg-api.js";

test("all callers share a rate-limited queue and duplicate requests coalesce", async () => {
  let time = 0;
  const starts = [];
  const client = createPdgClient({
    now: () => time,
    wait: async (ms) => { time += ms; },
    fetchImpl: async (url) => {
      starts.push([url, time]);
      return { ok: true, json: async () => ({ url }) };
    }
  });
  await Promise.all([client.get("/info"), client.get("/summaries/B013"),
    client.get("/listings/B013M"), client.get("/summaries/B013")]);
  assert.equal(starts.length, 3);
  assert.deepEqual(starts.map(([, start]) => start), [0, 650, 1300]);
});

test("failed requests can be retried and do not poison later requests", async () => {
  let calls = 0;
  const client = createPdgClient({
    wait: async () => {},
    fetchImpl: async () => {
      calls++;
      return { ok: calls !== 1, status: 503, json: async () => ({ pdgid: "B013" }) };
    }
  });
  await assert.rejects(client.get("/summaries/B013"), /503/);
  assert.equal((await client.get("/summaries/B013")).pdgid, "B013");
});

test("summary shapes and zero values are retained", () => {
  const property = { description: "mass", pdg_values: [{ value: 0, unit: "MeV" }] };
  assert.deepEqual(summaryProperties({ summaries: { properties: [property] } }), [property]);
  assert.deepEqual(summaryProperties({ summaries: [{ properties: [property] }] }), [property]);
  assert.deepEqual(summaryProperties(property), [property]);
  assert.equal(formatPdgValue(property.pdg_values[0]), "0 MeV");
});
