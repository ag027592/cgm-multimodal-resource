import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_PAGE_SIZE,
  filterFields,
  paginateFields,
  readDictionaryFields,
  sourceBasename,
  updateFilters,
} from "../dictionary.js";

function field(overrides = {}) {
  return {
    id: "public-field-1",
    wave: "G2",
    layer: "sensor observations",
    source_table: "G2_sensor.csv",
    field: "Sensor Glucose",
    storage_type: "number",
    interpretation: "Sensor glucose expressed in mg/dL.",
    missing_policy: "Exclude nonfinite values; do not impute.",
    provenance_status: "author confirmed",
    provenance_evidence: "The collection team confirmed units.",
    ...overrides,
  };
}

const fixture = Object.freeze([
  Object.freeze(field()),
  Object.freeze(field({ id: "public-field-2", wave: "G3", source_table: "G3_sensor.csv" })),
  Object.freeze(field({
    id: "public-field-3",
    wave: "G3",
    layer: "source transcript",
    source_table: "G3_Daily_Video.csv",
    field: "English",
    storage_type: "text",
    interpretation: "Stored English representation.",
    missing_policy: "Keep empty text distinct from unavailable recordings.",
    provenance_status: "original language undocumented",
    provenance_evidence: "Translation direction remains unresolved.",
  })),
]);

test("search matches field, interpretation, source, missing, and provenance without case sensitivity", () => {
  for (const query of ["  gLuCoSe  ", "MG/DL", "G2_SENSOR.CSV", "NONFINITE", "AUTHOR CONFIRMED", "COLLECTION TEAM"]) {
    assert.ok(filterFields(fixture, { query }).some((entry) => entry.id === "public-field-1"));
  }
  assert.deepEqual(filterFields(fixture, { query: "translation direction" }), [fixture[2]]);
  assert.deepEqual(filterFields(fixture, { query: "   " }), fixture);
});

test("query, wave, and layer combine with AND and preserve original order", () => {
  assert.deepEqual(filterFields(fixture, { query: "glucose", wave: "G3", layer: "sensor observations" }), [fixture[1]]);
  assert.deepEqual(filterFields(fixture, { wave: "G3" }), [fixture[1], fixture[2]]);
  assert.deepEqual(filterFields(fixture, { query: "glucose", layer: "source transcript" }), []);
  assert.deepEqual(filterFields(fixture, { wave: "G1" }), []);
  assert.equal(fixture[0].field, "Sensor Glucose");
});

test("literal markup and regex-like characters remain inert search text", () => {
  const suspicious = field({ field: '<img src=x onerror="alert(1)">', interpretation: "a.*b" });
  assert.deepEqual(filterFields([suspicious], { query: "<IMG" }), [suspicious]);
  assert.deepEqual(filterFields([suspicious], { query: "a.*b" }), [suspicious]);
  assert.deepEqual(filterFields([suspicious], { query: "a.+b" }), []);
  assert.equal(suspicious.field, '<img src=x onerror="alert(1)">');
});

test("pagination covers all 203 rows exactly once and clamps out-of-range pages", () => {
  const fields = Array.from({ length: 203 }, (_, index) => ({ id: index }));
  const pages = Array.from({ length: 9 }, (_, index) => paginateFields(fields, index + 1));
  assert.equal(DEFAULT_PAGE_SIZE, 25);
  assert.deepEqual(pages.flatMap((page) => page.items), fields);
  assert.equal(pages[0].start, 1);
  assert.equal(pages[0].end, 25);
  assert.equal(pages[0].hasPrevious, false);
  assert.equal(pages[0].hasNext, true);
  assert.equal(pages[8].start, 201);
  assert.equal(pages[8].end, 203);
  assert.equal(pages[8].items.length, 3);
  assert.equal(pages[8].hasNext, false);
  assert.equal(paginateFields(fields, 999).page, 9);
  assert.equal(paginateFields(fields, -4).page, 1);
  assert.equal(paginateFields(fields, Number.NaN).page, 1);
  assert.equal(paginateFields(fields, 2, 0).pageSize, 25);
});

test("empty and exact-boundary pagination never exposes an invalid navigation range", () => {
  assert.deepEqual(paginateFields([], 99), {
    items: [], page: 0, pageSize: 25, pageCount: 0, total: 0,
    start: 0, end: 0, hasPrevious: false, hasNext: false,
  });
  const page = paginateFields(Array(25).fill(null), 2);
  assert.equal(page.page, 1);
  assert.equal(page.pageCount, 1);
  assert.equal(page.hasNext, false);
  assert.equal(page.hasPrevious, false);
});

test("filter changes reset page and preserve unrelated state without mutation", () => {
  const state = Object.freeze({
    fields: fixture,
    page: 9,
    ready: true,
    filters: Object.freeze({ query: "", wave: "all", layer: "all" }),
  });
  const next = updateFilters(state, { wave: "G3", query: "English" });
  assert.equal(next.page, 1);
  assert.equal(next.ready, true);
  assert.equal(next.fields, fixture);
  assert.deepEqual(next.filters, { query: "English", wave: "G3", layer: "all" });
  assert.equal(state.page, 9);
  assert.equal(state.filters.wave, "all");
});

test("display source strips directories without inserting or interpreting markup", () => {
  assert.equal(sourceBasename("C:\\private\\study\\G3_sensor.csv"), "G3_sensor.csv");
  assert.equal(sourceBasename("/private/study/G3_sensor.csv"), "G3_sensor.csv");
  assert.equal(sourceBasename("<script>.csv"), "<script>.csv");
  assert.equal(sourceBasename(""), "Source not specified");
});

test("malformed and duplicate dictionary records fail before partial data can be rendered", () => {
  assert.equal(readDictionaryFields({ fields: fixture }), fixture);
  assert.throws(() => readDictionaryFields({ fields: "unexpected" }), TypeError);
  assert.throws(() => readDictionaryFields({ fields: [field({ interpretation: null })] }), TypeError);
  assert.throws(() => readDictionaryFields({ fields: [field(), field()] }), TypeError);
});

test("the reference dictionary retains 203 searchable, pageable public-schema fields", async (t) => {
  let payload;
  try {
    payload = JSON.parse(await readFile(new URL("../data/dictionary.json", import.meta.url), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return t.skip("Public data generation is not finished yet.");
    throw error;
  }
  const fields = readDictionaryFields(payload);
  assert.equal(fields.length, 203);
  assert.deepEqual(new Set(fields.map((entry) => entry.wave)), new Set(["G1", "G2", "G3"]));
  assert.deepEqual(new Set(fields.map((entry) => entry.layer)), new Set([
    "participant characteristics", "sensor observations", "source transcript", "supplied sensor summaries",
  ]));
  for (const wave of ["G1", "G2", "G3"]) {
    const filtered = filterFields(fields, { wave });
    assert.ok(filtered.length > 0);
    assert.ok(filtered.every((entry) => entry.wave === wave));
  }
  assert.equal(paginateFields(fields, 9).end, 203);
  assert.ok(filterFields(fields, { query: "glucose" }).length > 0);
  for (const entry of fields) {
    assert.equal(entry.source_table, sourceBasename(entry.source_table));
    assert.ok(!/[<>]/.test(Object.values(entry).join(" ")), "Public fields must not contain HTML markup.");
  }
});

// Minimal DOM contract checks exercise the actual browser module without dependencies.
class FakeElement {
  constructor() {
    this.attributes = new Map();
    this.listeners = new Map();
    const classes = new Set();
    this.classList = {
      add: (name) => classes.add(name),
      contains: (name) => classes.has(name),
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
    };
  }
  setAttribute(key, value) { this.attributes.set(key, value); }
  getAttribute(key) { return this.attributes.get(key); }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
  }
  dispatch(type, event = {}) {
    return Promise.all((this.listeners.get(type) || []).map((callback) => callback({ target: this, ...event })));
  }
  focus() { this.focused = true; }
}

async function bootApp(t) {
  const elements = Object.fromEntries(["menu-toggle", "site-nav"].map((id) => [id, new FakeElement()]));
  const document = new FakeElement();
  document.readyState = "complete";
  document.documentElement = new FakeElement();
  document.getElementById = (id) => elements[id] || null;
  const saved = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  let fetchCalls = 0;
  globalThis.window = {};
  globalThis.document = document;
  globalThis.fetch = async () => { fetchCalls += 1; };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  await import(`../app.js?test=${Math.random()}`);
  await new Promise((resolve) => setImmediate(resolve));
  return { elements, document, fetchCalls: () => fetchCalls };
}

test("navigation boots without dictionary elements or requests and closes on an anchor or Escape", async (t) => {
  const app = await bootApp(t);
  const toggle = app.elements["menu-toggle"];
  const navigation = app.elements["site-nav"];
  assert.equal(app.document.documentElement.classList.contains("js"), true);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(navigation.classList.contains("is-open"), false);
  assert.equal(app.fetchCalls(), 0);
  await toggle.dispatch("click");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(navigation.classList.contains("is-open"), true);
  await navigation.dispatch("click", { target: { closest: () => null } });
  assert.equal(navigation.classList.contains("is-open"), true);
  await navigation.dispatch("click", { target: { closest: () => ({ tagName: "a" }) } });
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(navigation.classList.contains("is-open"), false);
  await toggle.dispatch("click");
  await app.document.dispatch("keydown", { key: "Escape" });
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(navigation.classList.contains("is-open"), false);
  assert.equal(toggle.focused, true);
  assert.equal(app.fetchCalls(), 0);
});
