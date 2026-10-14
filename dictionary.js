export const DEFAULT_PAGE_SIZE = 25;

const SEARCH_PROPERTIES = [
  "field",
  "interpretation",
  "source_table",
  "missing_policy",
  "provenance_status",
  "provenance_evidence",
];

const REQUIRED_PROPERTIES = [
  "id",
  "wave",
  "layer",
  "source_table",
  "field",
  "storage_type",
  "interpretation",
  "missing_policy",
  "provenance_status",
  "provenance_evidence",
];

/** Validate the public field schema before showing any dictionary rows. */
export function readDictionaryFields(payload) {
  if (!payload || !Array.isArray(payload.fields)) {
    throw new TypeError("The dictionary does not contain a fields array.");
  }

  const identifiers = new Set();
  for (const field of payload.fields) {
    if (
      !field ||
      REQUIRED_PROPERTIES.some((key) => typeof field[key] !== "string") ||
      !field.id.trim() ||
      !field.field.trim() ||
      identifiers.has(field.id)
    ) {
      throw new TypeError("The dictionary contains an invalid field record.");
    }
    identifiers.add(field.id);
  }
  return payload.fields;
}

/** Case-insensitive literal search, combined with exact wave and layer filters. */
export function filterFields(fields, { query = "", wave = "all", layer = "all" } = {}) {
  const needle = String(query).trim().toLowerCase();
  return fields.filter((field) => {
    if (wave !== "all" && field.wave !== wave) return false;
    if (layer !== "all" && field.layer !== layer) return false;
    if (!needle) return true;
    return SEARCH_PROPERTIES.some((key) =>
      String(field[key] ?? "").toLowerCase().includes(needle),
    );
  });
}

/** Return a bounded, one-based page; the empty result has page/start/end equal to zero. */
export function paginateFields(fields, requestedPage = 1, requestedPageSize = DEFAULT_PAGE_SIZE) {
  const integerSize = Math.trunc(Number(requestedPageSize));
  const pageSize = Number.isFinite(integerSize) && integerSize > 0
    ? integerSize
    : DEFAULT_PAGE_SIZE;
  const total = fields.length;
  const pageCount = Math.ceil(total / pageSize);
  const integerPage = Math.trunc(Number(requestedPage));
  const candidatePage = Number.isFinite(integerPage) ? integerPage : 1;
  const page = total ? Math.min(Math.max(candidatePage, 1), pageCount) : 0;
  const offset = page ? (page - 1) * pageSize : 0;
  const items = fields.slice(offset, offset + pageSize);

  return {
    items,
    page,
    pageSize,
    pageCount,
    total,
    start: total ? offset + 1 : 0,
    end: offset + items.length,
    hasPrevious: page > 1,
    hasNext: page > 0 && page < pageCount,
  };
}

/** Every filter transition starts at the first page without mutating prior state. */
export function updateFilters(state, changes) {
  return {
    ...state,
    filters: { ...state.filters, ...changes },
    page: 1,
  };
}

/** Source paths are never displayed; only the final filename is shown. */
export function sourceBasename(source) {
  return String(source ?? "").split(/[\\/]/).filter(Boolean).pop() || "Source not specified";
}
