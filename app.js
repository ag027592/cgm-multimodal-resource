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
  const controls = [search, wave, layer, previous, next, clear];

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
    const row = element("tr");
    const cell = element("td", message, "dictionary-empty");
    cell.colSpan = 4;
    row.append(cell);
    results.replaceChildren(row);
  }

  function createRow(field) {
    const row = element("tr");
    const context = element("td");
    context.append(
      element("strong", field.wave, "dictionary-wave"),
      element("span", field.layer, "dictionary-layer"),
    );

    const name = element("td");
    name.append(
      element("code", field.field, "dictionary-field"),
      element("span", field.storage_type, "dictionary-type"),
    );

    const interpretation = element("td", field.interpretation);
    const source = element("td");
    source.append(element("code", sourceBasename(field.source_table), "dictionary-source"));
    const details = element("details", undefined, "field-notes");
    details.append(element("summary", "Field notes"));
    const notes = element("dl");
    for (const [label, value] of [
      ["Missing values", field.missing_policy],
      ["Provenance", field.provenance_status],
      ["Evidence", field.provenance_evidence],
    ]) {
      notes.append(element("dt", label), element("dd", value || "Not specified."));
    }
    details.append(notes);
    source.append(details);
    row.append(context, name, interpretation, source);
    return row;
  }

  function render() {
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
    for (const field of page.items) fragment.append(createRow(field));
    results.replaceChildren(fragment);
    const matchText = page.total === 1 ? "1 field matches" : `${page.total} fields match`;
    status.textContent = `${matchText}. Showing ${page.start}\u2013${page.end} of ${page.total}.`;
  }

  function applyFilters(changes) {
    if (!state.ready) return;
    state = updateFilters(state, changes);
    render();
  }

  async function loadDictionary() {
    if (state.loading || state.ready) return;
    state.loading = true;
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
  clear.addEventListener("click", () => {
    search.value = "";
    wave.value = "all";
    layer.value = "all";
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
