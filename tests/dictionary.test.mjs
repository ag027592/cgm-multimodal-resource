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

test("the published dictionary has 203 searchable, pageable public-schema fields", async (t) => {
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
  constructor(tagName = "div") {
    this.tagName = tagName;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.value = "";
    this.disabled = false;
    this.hidden = false;
    this._text = "";
    const classes = new Set();
    this.classList = {
      add: (name) => classes.add(name),
      contains: (name) => classes.has(name),
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
    };
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  set innerHTML(_) { throw new Error("Unsafe HTML insertion attempted."); }
  append(...children) {
    for (const child of children) {
      if (child.tagName === "fragment") this.children.push(...child.children);
      else this.children.push(child);
    }
  }
  replaceChildren(...children) { this.children = []; this._text = ""; this.append(...children); }
  setAttribute(key, value) { this.attributes.set(key, value); }
  getAttribute(key) { return this.attributes.get(key); }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
  }
  dispatch(type, event = {}) {
    return Promise.all((this.listeners.get(type) || []).map((callback) => callback({ target: this, ...event })));
  }
  focus(options) { this.focused = true; this.focusOptions = options; }
  scrollIntoView(options) { this.scrolledIntoView = true; this.scrollOptions = options; }
}

async function bootApp(t, responses, { shortcuts = true } = {}) {
  const ids = [
    "dictionary-search", "wave-filter", "layer-filter", "dictionary-results",
    "dictionary-status", "dictionary-page", "dictionary-prev", "dictionary-next",
    "dictionary-clear", "dictionary-retry", "dictionary-form", "menu-toggle", "site-nav",
    "field-browser-title",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  elements["dictionary-results"].tagName = "ul";
  elements["dictionary-results"].className = "field-grid";
  elements["dictionary-results"].setAttribute("aria-label", "Field definitions");
  elements["wave-filter"].value = "all";
  elements["layer-filter"].value = "all";
  const categoryButtons = shortcuts ? [
    "all", "participant characteristics", "sensor observations", "source transcript", "supplied sensor summaries",
  ].map((category) => {
    const button = new FakeElement("button");
    button.dataset.dictionaryLayer = category;
    button.disabled = true;
    return button;
  }) : [];
  const queryButtons = shortcuts ? ["sensorglucose", "age", "English"].map((query) => {
    const button = new FakeElement("button");
    button.dataset.dictionaryQuery = query;
    button.disabled = true;
    return button;
  }) : [];
  const document = new FakeElement("document");
  document.readyState = "complete";
  document.documentElement = new FakeElement("html");
  document.getElementById = (id) => elements[id] || null;
  document.querySelectorAll = (selector) => {
    if (selector === "[data-dictionary-layer]") return categoryButtons;
    if (selector === "[data-dictionary-query]") return queryButtons;
    return [];
  };
  const createdTags = [];
  document.createElement = (tag) => { createdTags.push(tag); return new FakeElement(tag); };
  document.createDocumentFragment = () => new FakeElement("fragment");
  const saved = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  let calls = 0;
  globalThis.window = {};
  globalThis.document = document;
  globalThis.fetch = async (url) => {
    assert.ok(url.pathname.endsWith("/data/dictionary.json"));
    const response = await responses[calls++];
    if (response instanceof Error) throw response;
    return { ok: true, json: async () => response };
  };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  await import(`../app.js?test=${Math.random()}`);
  await new Promise((resolve) => setImmediate(resolve));
  return { elements, document, createdTags, categoryButtons, queryButtons, calls: () => calls };
}

function cardDetails(card) {
  const details = card.children.find((child) => child.tagName === "details");
  assert.equal(details.className, "field-details");
  assert.equal(details.children[0].tagName, "summary");
  assert.equal(details.children[0].textContent, "Source & technical details");
  assert.equal(details.children[1].tagName, "dl");
  const entries = details.children[1].children;
  const values = {};
  for (let index = 0; index < entries.length; index += 2) {
    assert.equal(entries[index].tagName, "dt");
    assert.equal(entries[index + 1].tagName, "dd");
    values[entries[index].textContent] = entries[index + 1].textContent;
  }
  return values;
}

function assertPressedCategory(app, expectedLayer) {
  for (const button of app.categoryButtons) {
    assert.equal(button.getAttribute("aria-pressed"), String(button.dataset.dictionaryLayer === expectedLayer));
  }
}

test("field cards preserve source metadata and inert text, hide directories, and reset pagination", async (t) => {
  const injected = '<img src=x onerror="alert(1)">';
  const fields = Array.from({ length: 26 }, (_, index) => field({
    id: `fixture-${index}`,
    field: index ? `Glucose ${index}` : injected,
    source_table: "C:\\private\\study\\G2_sensor.csv",
  }));
  const app = await bootApp(t, [{ fields }]);
  const { elements } = app;
  assert.equal(elements["dictionary-status"].dataset.state, "ready");
  assert.equal(elements["dictionary-results"].children.length, 25);
  assert.ok(elements["dictionary-results"].textContent.includes(injected));
  assert.ok(!elements["dictionary-results"].textContent.includes("private"));
  assert.ok(!app.createdTags.includes("img"));
  assert.ok(!app.createdTags.some((tag) => ["table", "thead", "tbody", "tr", "td", "th"].includes(tag)));
  const card = elements["dictionary-results"].children[0];
  assert.equal(card.tagName, "li");
  assert.equal(card.className, "field-card");
  assert.deepEqual(card.children.map((child) => child.tagName), ["div", "h4", "p", "details"]);
  assert.equal(card.children[0].className, "field-card-meta");
  assert.deepEqual(card.children[0].children.map((child) => [child.className, child.textContent]), [
    ["field-wave", "G2"], ["field-category", "Glucose readings"],
  ]);
  assert.equal(card.children[1].className, "field-name");
  assert.equal(card.children[1].children[0].tagName, "code");
  assert.equal(card.children[1].children[0].textContent, injected);
  assert.equal(card.children[2].className, "field-meaning");
  assert.equal(card.children[2].textContent, fields[0].interpretation);
  assert.deepEqual(cardDetails(card), {
    "Source file": "G2_sensor.csv",
    "Stored format": fields[0].storage_type,
    "Missing values": fields[0].missing_policy,
    "Source status": fields[0].provenance_status,
    "Source notes": fields[0].provenance_evidence,
  });
  await elements["dictionary-next"].dispatch("click");
  assert.equal(elements["dictionary-page"].textContent, "Page 2 of 2");
  assert.equal(elements["dictionary-results"].children.length, 1);
  assert.equal(elements["dictionary-next"].disabled, true);
  await elements["dictionary-prev"].dispatch("click");
  assert.equal(elements["dictionary-page"].textContent, "Page 1 of 2");
  await elements["dictionary-next"].dispatch("click");
  elements["dictionary-search"].value = "<img";
  await elements["dictionary-search"].dispatch("input");
  assert.equal(elements["dictionary-page"].textContent, "Page 1 of 1");
  assert.equal(elements["dictionary-results"].children.length, 1);
  assert.equal(elements["dictionary-prev"].disabled, true);
  assert.equal(elements["dictionary-next"].disabled, true);
  elements["dictionary-search"].value = "no matching field";
  await elements["dictionary-search"].dispatch("input");
  assert.equal(elements["dictionary-results"].children[0].tagName, "li");
  assert.equal(elements["dictionary-results"].children[0].className, "field-empty");
  assert.match(elements["dictionary-results"].children[0].textContent, /No matching fields/);
  assert.equal(elements["dictionary-page"].textContent, "No pages");
  await elements["dictionary-clear"].dispatch("click");
  assert.equal(elements["dictionary-results"].children.length, 25);
  assert.equal(elements["dictionary-search"].value, "");
  assert.equal(app.calls(), 1);
});

test("every displayed field string remains literal text and empty metadata stays explicit", async (t) => {
  const hostile = '<svg onload="alert(1)">';
  const entry = field(Object.fromEntries([
    "wave", "layer", "field", "storage_type", "interpretation", "missing_policy", "provenance_status", "provenance_evidence",
  ].map((key) => [key, `${hostile} ${key}`])));
  entry.source_table = `/private/${hostile}.csv`;
  const app = await bootApp(t, [{ fields: [entry, field({
    id: "empty-metadata", storage_type: "", missing_policy: "", provenance_status: "", provenance_evidence: "",
  })] }]);
  const card = app.elements["dictionary-results"].children[0];
  assert.equal(card.children[0].children[0].textContent, entry.wave);
  assert.equal(card.children[0].children[1].textContent, entry.layer);
  assert.equal(card.children[1].textContent, entry.field);
  assert.equal(card.children[2].textContent, entry.interpretation);
  assert.deepEqual(cardDetails(card), {
    "Source file": `${hostile}.csv`,
    "Stored format": entry.storage_type,
    "Missing values": entry.missing_policy,
    "Source status": entry.provenance_status,
    "Source notes": entry.provenance_evidence,
  });
  assert.ok(!app.createdTags.includes("svg"));
  const emptyDetails = cardDetails(app.elements["dictionary-results"].children[1]);
  for (const label of ["Stored format", "Missing values", "Source status", "Source notes"]) {
    assert.equal(emptyDetails[label], "Not specified.");
  }
});

test("all four dataset layers render plain-English category names", async (t) => {
  const labels = [
    ["participant characteristics", "Participant information"],
    ["sensor observations", "Glucose readings"],
    ["source transcript", "Diary & interview text"],
    ["supplied sensor summaries", "Glucose summaries"],
  ];
  const fields = labels.map(([layer], index) => field({ id: `category-${index}`, layer }));
  const app = await bootApp(t, [{ fields }]);
  assert.deepEqual(app.elements["dictionary-results"].children.map((card) => card.children[0].children[1].textContent),
    labels.map(([, label]) => label));
});

test("category browsing starts fresh, resets pages, and stays synchronized with select filters", async (t) => {
  const fields = [
    ...Array.from({ length: 26 }, (_, index) => field({ id: `sensor-${index}`, field: `sensorglucose ${index}` })),
    ...Array.from({ length: 26 }, (_, index) => field({
      id: `participant-${index}`, wave: "G3", layer: "participant characteristics", field: `age ${index}`,
    })),
  ];
  const app = await bootApp(t, [{ fields }]);
  const { elements } = app;
  assertPressedCategory(app, "all");
  assert.ok(app.categoryButtons.every((button) => !button.disabled));
  elements["dictionary-search"].value = "sensorglucose";
  await elements["dictionary-search"].dispatch("input");
  elements["wave-filter"].value = "G2";
  await elements["wave-filter"].dispatch("change");
  await elements["dictionary-next"].dispatch("click");
  assert.equal(elements["dictionary-page"].textContent, "Page 2 of 2");
  const participants = app.categoryButtons.find((button) => button.dataset.dictionaryLayer === "participant characteristics");
  await participants.dispatch("click");
  assert.equal(elements["dictionary-search"].value, "");
  assert.equal(elements["wave-filter"].value, "all");
  assert.equal(elements["layer-filter"].value, "participant characteristics");
  assert.equal(elements["dictionary-page"].textContent, "Page 1 of 2");
  assert.equal(elements["dictionary-results"].children.length, 25);
  assert.equal(elements["dictionary-results"].children[0].children[1].textContent, "age 0");
  assertPressedCategory(app, "participant characteristics");
  assert.equal(elements["dictionary-search"].focused, true);
  assert.deepEqual(elements["dictionary-search"].focusOptions, { preventScroll: true });
  assert.equal(elements["field-browser-title"].scrolledIntoView, true);
  assert.deepEqual(elements["field-browser-title"].scrollOptions, { block: "start" });
  await elements["dictionary-next"].dispatch("click");
  elements["layer-filter"].value = "sensor observations";
  await elements["layer-filter"].dispatch("change");
  assertPressedCategory(app, "sensor observations");
  assert.equal(elements["dictionary-page"].textContent, "Page 1 of 2");
  await elements["dictionary-next"].dispatch("click");
  elements["wave-filter"].value = "G2";
  await elements["wave-filter"].dispatch("change");
  assert.equal(elements["dictionary-page"].textContent, "Page 1 of 2");
  await elements["dictionary-clear"].dispatch("click");
  assert.equal(elements["layer-filter"].value, "all");
  assert.equal(elements["wave-filter"].value, "all");
  assertPressedCategory(app, "all");
  assert.equal(elements["dictionary-page"].textContent, "Page 1 of 3");
});

test("query examples reset wave, category, and page, then focus and reveal the field browser", async (t) => {
  const fields = [
    ...Array.from({ length: 26 }, (_, index) => field({ id: `sensor-${index}`, field: `sensorglucose ${index}` })),
    field({ id: "age", field: "age", wave: "G1", layer: "participant characteristics" }),
    fixture[2],
  ];
  const app = await bootApp(t, [{ fields }]);
  const { elements } = app;
  assert.ok(app.queryButtons.every((button) => !button.disabled));
  for (const button of app.queryButtons) {
    await elements["dictionary-clear"].dispatch("click");
    elements["wave-filter"].value = "G2";
    await elements["wave-filter"].dispatch("change");
    elements["layer-filter"].value = "sensor observations";
    await elements["layer-filter"].dispatch("change");
    await elements["dictionary-next"].dispatch("click");
    assert.equal(elements["dictionary-page"].textContent, "Page 2 of 2");
    await button.dispatch("click");
    assert.equal(elements["dictionary-search"].value, button.dataset.dictionaryQuery);
    assert.equal(elements["wave-filter"].value, "all");
    assert.equal(elements["layer-filter"].value, "all");
    assertPressedCategory(app, "all");
    assert.match(elements["dictionary-page"].textContent, /^Page 1 of /);
    assert.equal(elements["dictionary-prev"].disabled, true);
    assert.equal(elements["dictionary-search"].focused, true);
    assert.deepEqual(elements["dictionary-search"].focusOptions, { preventScroll: true });
    assert.equal(elements["field-browser-title"].scrolledIntoView, true);
    assert.deepEqual(elements["field-browser-title"].scrollOptions, { block: "start" });
    assert.ok(elements["dictionary-results"].children[0].children[1].textContent.toLowerCase().includes(button.dataset.dictionaryQuery.toLowerCase()));
  }
});

test("optional browse and example buttons can be absent without breaking core search", async (t) => {
  const app = await bootApp(t, [{ fields: fixture }], { shortcuts: false });
  const { elements } = app;
  assert.equal(elements["dictionary-status"].dataset.state, "ready");
  elements["dictionary-search"].value = "English";
  await elements["dictionary-search"].dispatch("input");
  assert.equal(elements["dictionary-results"].children.length, 1);
  assert.equal(elements["dictionary-results"].children[0].children[1].textContent, "English");
});

test("pending loads disable every filter and shortcut and expose a list loading message", async (t) => {
  let completeLoad;
  const pending = new Promise((resolve) => { completeLoad = resolve; });
  const app = await bootApp(t, [pending]);
  const { elements } = app;
  assert.equal(elements["dictionary-status"].dataset.state, "loading");
  assert.equal(elements["dictionary-results"].getAttribute("aria-busy"), "true");
  assert.equal(elements["dictionary-results"].children[0].tagName, "li");
  assert.equal(elements["dictionary-results"].children[0].className, "field-empty");
  assert.match(elements["dictionary-results"].textContent, /Loading fields/);
  for (const control of [elements["dictionary-search"], elements["wave-filter"], elements["layer-filter"],
    elements["dictionary-clear"], elements["dictionary-prev"], elements["dictionary-next"],
    ...app.categoryButtons, ...app.queryButtons]) assert.equal(control.disabled, true);
  assertPressedCategory(app, "all");
  await app.categoryButtons[1].dispatch("click");
  await app.queryButtons[0].dispatch("click");
  assert.equal(elements["dictionary-search"].value, "");
  assert.equal(elements["layer-filter"].value, "all");
  assert.equal(elements["dictionary-search"].focused, undefined);
  assert.equal(elements["field-browser-title"].scrolledIntoView, undefined);
  completeLoad({ fields: fixture });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements["dictionary-status"].dataset.state, "ready");
  assert.equal(elements["dictionary-results"].getAttribute("aria-busy"), "false");
});

test("failed loads disable filters, show retry, and recover with one explicit retry", async (t) => {
  const app = await bootApp(t, [new Error("offline"), { fields: fixture }]);
  const { elements } = app;
  assert.equal(elements["dictionary-status"].dataset.state, "error");
  assert.equal(elements["dictionary-search"].disabled, true);
  assert.equal(elements["dictionary-next"].disabled, true);
  assert.equal(elements["dictionary-retry"].hidden, false);
  assert.equal(elements["dictionary-results"].children[0].tagName, "li");
  assert.equal(elements["dictionary-results"].children[0].className, "field-empty");
  assert.ok([...app.categoryButtons, ...app.queryButtons].every((button) => button.disabled));
  await elements["dictionary-retry"].dispatch("click");
  assert.equal(elements["dictionary-status"].dataset.state, "ready");
  assert.equal(elements["dictionary-search"].disabled, false);
  assert.equal(elements["dictionary-retry"].hidden, true);
  assert.ok([...app.categoryButtons, ...app.queryButtons].every((button) => !button.disabled));
  assert.equal(app.calls(), 2);
  await elements["dictionary-retry"].dispatch("click");
  assert.equal(app.calls(), 2);
});

test("navigation progressively enhances and closes on an anchor or Escape", async (t) => {
  const app = await bootApp(t, [{ fields: fixture }]);
  const toggle = app.elements["menu-toggle"];
  const navigation = app.elements["site-nav"];
  assert.equal(app.document.documentElement.classList.contains("js"), true);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  await toggle.dispatch("click");
  assert.equal(navigation.classList.contains("is-open"), true);
  await navigation.dispatch("click", { target: { closest: () => ({ tagName: "a" }) } });
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  await toggle.dispatch("click");
  await app.document.dispatch("keydown", { key: "Escape" });
  assert.equal(navigation.classList.contains("is-open"), false);
  assert.equal(toggle.focused, true);
});
