import {
  filterFields,
  paginateFields,
  readDictionaryFields,
  sourceBasename,
  updateFilters,
} from "./dictionary.js";

function initializeNavigation() {
  const toggle = document.getElementById("menu-toggle");
  const navigation = document.getElementById("site-nav");
  if (!toggle || !navigation) return;

  function setOpen(open) {
    toggle.setAttribute("aria-expanded", String(open));
    navigation.classList.toggle("is-open", open);
  }

  setOpen(false);
  toggle.addEventListener("click", () => {
    setOpen(toggle.getAttribute("aria-expanded") !== "true");
  });
  navigation.addEventListener("click", (event) => {
    if (event.target.closest?.("a")) setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
      setOpen(false);
      toggle.focus();
    }
  });
}

function initializeDictionary() {
  const elements = Object.fromEntries([
    "dictionary-search",
    "wave-filter",
    "layer-filter",
    "dictionary-results",
    "dictionary-status",
    "dictionary-page",
    "dictionary-prev",
    "dictionary-next",
    "dictionary-clear",
    "dictionary-retry",
    "dictionary-form",
  ].map((id) => [id, document.getElementById(id)]));
  if (Object.values(elements).some((element) => !element)) return;

  const search = elements["dictionary-search"];
  const wave = elements["wave-filter"];
  const layer = elements["layer-filter"];
  const results = elements["dictionary-results"];
  const status = elements["dictionary-status"];
  const pageLabel = elements["dictionary-page"];
  const previous = elements["dictionary-prev"];
  const next = elements["dictionary-next"];
  const clear = elements["dictionary-clear"];
  const retry = elements["dictionary-retry"];
  const form = elements["dictionary-form"];
  const categoryButtons = [...document.querySelectorAll("[data-dictionary-layer]")];
  const queryButtons = [...document.querySelectorAll("[data-dictionary-query]")];
  const controls = [search, wave, layer, previous, next, clear, ...categoryButtons, ...queryButtons];
  const categoryLabels = new Map([
    ["participant characteristics", "Participant information"],
    ["sensor observations", "Glucose readings"],
    ["source transcript", "Diary & interview text"],
    ["supplied sensor summaries", "Glucose summaries"],
  ]);

  let state = {
    fields: [],
    filters: { query: search.value, wave: wave.value || "all", layer: layer.value || "all" },
    page: 1,
    loading: false,
    ready: false,
  };

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function showMessage(message) {
    results.replaceChildren(element("li", message, "field-empty"));
  }

  function createCard(field) {
    const card = element("li", undefined, "field-card");
    const context = element("div", undefined, "field-card-meta");
    context.append(
      element("span", field.wave, "field-wave"),
      element("span", categoryLabels.get(field.layer) || field.layer, "field-category"),
    );

    const name = element("h4", undefined, "field-name");
    name.append(element("code", field.field));

    const interpretation = element("p", field.interpretation, "field-meaning");
    const details = element("details", undefined, "field-details");
    details.append(element("summary", "Source & technical details"));
    const notes = element("dl");
    for (const [label, value] of [
      ["Source file", sourceBasename(field.source_table)],
      ["Stored format", field.storage_type],
      ["Missing values", field.missing_policy],
      ["Source status", field.provenance_status],
      ["Source notes", field.provenance_evidence],
    ]) {
      notes.append(element("dt", label), element("dd", value || "Not specified."));
    }
    details.append(notes);
    card.append(context, name, interpretation, details);
    return card;
  }

  function syncFilters() {
    for (const [control, value] of [
      [search, state.filters.query],
      [wave, state.filters.wave],
      [layer, state.filters.layer],
    ]) {
      if (control.value !== value) control.value = value;
    }
    for (const button of categoryButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.dictionaryLayer === state.filters.layer));
    }
  }

  function render() {
    syncFilters();
    const matched = filterFields(state.fields, state.filters);
    const page = paginateFields(matched, state.page);
    state.page = page.page;
    previous.disabled = !page.hasPrevious;
    next.disabled = !page.hasNext;
    pageLabel.textContent = page.total ? `Page ${page.page} of ${page.pageCount}` : "No pages";
    status.dataset.state = "ready";
    if (!page.total) {
      status.textContent = "No fields match. Adjust your search or clear the filters.";
      showMessage("No matching fields. Try another keyword or clear the filters.");
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const field of page.items) fragment.append(createCard(field));
    results.replaceChildren(fragment);
    const matchText = page.total === 1 ? "1 field matches" : `${page.total} fields match`;
    status.textContent = `${matchText}. Showing ${page.start}\u2013${page.end} of ${page.total}.`;
  }

  function applyFilters(changes) {
    if (!state.ready) return;
    state = updateFilters(state, changes);
    render();
  }

  function focusBrowser() {
    search.focus({ preventScroll: true });
    document.getElementById("field-browser-title")?.scrollIntoView({ block: "start" });
  }

  async function loadDictionary() {
    if (state.loading || state.ready) return;
    state.loading = true;
    syncFilters();
    for (const control of controls) control.disabled = true;
    retry.hidden = true;
    retry.disabled = true;
    status.dataset.state = "loading";
    status.textContent = "Loading the field dictionary\u2026";
    pageLabel.textContent = "Loading";
    results.setAttribute("aria-busy", "true");
    showMessage("Loading fields\u2026");

    try {
      const response = await fetch(new URL("./data/dictionary.json", import.meta.url), {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("Dictionary request failed.");
      state.fields = readDictionaryFields(await response.json());
      state.ready = true;
      for (const control of controls) control.disabled = false;
      render();
    } catch {
      status.dataset.state = "error";
      status.textContent = "The field dictionary could not be loaded. Check your connection and select Retry.";
      pageLabel.textContent = "Unavailable";
      showMessage("Dictionary unavailable. Use Retry to load the fields.");
      retry.hidden = false;
    } finally {
      state.loading = false;
      retry.disabled = false;
      results.setAttribute("aria-busy", "false");
    }
  }

  form.addEventListener("submit", (event) => event.preventDefault());
  search.addEventListener("input", () => applyFilters({ query: search.value }));
  wave.addEventListener("change", () => applyFilters({ wave: wave.value }));
  layer.addEventListener("change", () => applyFilters({ layer: layer.value }));
  for (const button of categoryButtons) {
    button.addEventListener("click", () => {
      if (!state.ready) return;
      applyFilters({ query: "", wave: "all", layer: button.dataset.dictionaryLayer });
      focusBrowser();
    });
  }
  for (const button of queryButtons) {
    button.addEventListener("click", () => {
      if (!state.ready) return;
      applyFilters({ query: button.dataset.dictionaryQuery, wave: "all", layer: "all" });
      focusBrowser();
    });
  }
  clear.addEventListener("click", () => {
    applyFilters({ query: "", wave: "all", layer: "all" });
  });
  previous.addEventListener("click", () => {
    if (!state.ready || previous.disabled) return;
    state.page -= 1;
    render();
  });
  next.addEventListener("click", () => {
    if (!state.ready || next.disabled) return;
    state.page += 1;
    render();
  });
  retry.addEventListener("click", loadDictionary);
  loadDictionary();
}

function initializeSite() {
  document.documentElement.classList.add("js");
  initializeNavigation();
  initializeDictionary();
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeSite, { once: true });
  } else {
    initializeSite();
  }
}
