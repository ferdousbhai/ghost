import type {
  BackendJavascriptResult,
  ConsoleEntry,
  NetworkEntry,
} from "./browser-backend.js";

export const MAX_BROWSER_OBSERVATION_BYTES = 64 * 1024;
export const MAX_BROWSER_OBSERVATION_ITEMS = 50;
export const MAX_BROWSER_OBSERVATION_STRING_BYTES = 2 * 1024;
export const MAX_BROWSER_OBSERVATION_DEPTH = 6;

export interface BoundedJavascriptResult extends BackendJavascriptResult {
  readonly omitted: number;
  readonly shortened: number;
  readonly replaced: number;
  readonly truncated: boolean;
  readonly bytes: number;
}

export interface BoundedEntryResult<T> {
  readonly entries: readonly T[];
  readonly total: number;
  readonly omitted: number;
  readonly fieldsOmitted: number;
  readonly fieldsShortened: number;
  readonly fieldsReplaced: number;
  readonly truncated: boolean;
  readonly bytes: number;
}

interface StringProjection {
  readonly value: string;
  readonly truncated: boolean;
}

interface JsonProjection {
  readonly value: unknown;
  readonly bytes: number;
  readonly omitted: number;
  readonly shortened: number;
  readonly replaced: number;
  readonly truncated: boolean;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function boundBrowserObservationString(
  value: unknown,
  maxBytes = MAX_BROWSER_OBSERVATION_STRING_BYTES,
): StringProjection {
  if (typeof value !== "string") return { value: "", truncated: value !== undefined };
  if (utf8Bytes(value) <= maxBytes) return { value, truncated: false };

  const suffix = "…";
  const contentBudget = Math.max(maxBytes - utf8Bytes(suffix), 0);
  let low = 0;
  let high = Math.min(value.length, contentBudget);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Bytes(value.slice(0, middle)) <= contentBudget) low = middle;
    else high = middle - 1;
  }
  // Never leave half of a surrogate pair at the boundary.
  if (low > 0 && /[\uD800-\uDBFF]/u.test(value[low - 1] ?? "")) low -= 1;
  return { value: `${value.slice(0, low)}${suffix}`, truncated: true };
}

function serializedBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value) ?? "null");
}

function projectJson(
  value: unknown,
  state: { remainingItems: number; seen: WeakSet<object> },
  depth: number,
  maxBytes: number,
): JsonProjection {
  if (value === null || typeof value === "boolean") {
    const bytes = serializedBytes(value);
    return { value, bytes, omitted: 0, shortened: 0, replaced: 0, truncated: false };
  }
  if (typeof value === "number") {
    const projected = Number.isFinite(value) ? value : null;
    return {
      value: projected,
      bytes: serializedBytes(projected),
      omitted: 0,
      shortened: 0,
      replaced: Number.isFinite(value) ? 0 : 1,
      truncated: !Number.isFinite(value),
    };
  }
  if (typeof value === "string") {
    const bounded = boundBrowserObservationString(value);
    const bytes = serializedBytes(bounded.value);
    if (bytes <= maxBytes) {
      return {
        value: bounded.value,
        bytes,
        omitted: 0,
        shortened: bounded.truncated ? 1 : 0,
        replaced: 0,
        truncated: bounded.truncated,
      };
    }
    return {
      value: "",
      bytes: 2,
      omitted: 0,
      shortened: bounded.truncated ? 1 : 0,
      replaced: 1,
      truncated: true,
    };
  }
  if (typeof value !== "object") {
    const marker = `[${typeof value} omitted]`;
    return {
      value: marker,
      bytes: serializedBytes(marker),
      omitted: 0,
      shortened: 0,
      replaced: 1,
      truncated: true,
    };
  }
  if (state.seen.has(value)) {
    const marker = "[circular omitted]";
    return {
      value: marker,
      bytes: serializedBytes(marker),
      omitted: 0,
      shortened: 0,
      replaced: 1,
      truncated: true,
    };
  }
  if (depth >= MAX_BROWSER_OBSERVATION_DEPTH) {
    const marker = "[depth limit]";
    return {
      value: marker,
      bytes: serializedBytes(marker),
      omitted: 0,
      shortened: 0,
      replaced: 1,
      truncated: true,
    };
  }

  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      let bytes = 2;
      let omitted = 0;
      let shortened = 0;
      let replaced = 0;
      let truncated = false;
      for (let index = 0; index < value.length; index += 1) {
        if (state.remainingItems <= 0) {
          omitted += value.length - index;
          truncated = true;
          break;
        }
        const separatorBytes = result.length === 0 ? 0 : 1;
        const available = maxBytes - bytes - separatorBytes;
        if (available <= 0) {
          omitted += value.length - index;
          truncated = true;
          break;
        }
        state.remainingItems -= 1;
        const item = projectJson(value[index], state, depth + 1, available);
        if (item.bytes > available) {
          omitted += value.length - index;
          truncated = true;
          break;
        }
        result.push(item.value);
        bytes += separatorBytes + item.bytes;
        omitted += item.omitted;
        shortened += item.shortened;
        replaced += item.replaced;
        truncated ||= item.truncated;
      }
      return { value: result, bytes, omitted, shortened, replaced, truncated };
    }

    const result = Object.create(null) as Record<string, unknown>;
    const keys = Object.keys(value);
    let bytes = 2;
    let omitted = 0;
    let shortened = 0;
    let replaced = 0;
    let truncated = false;
    for (let index = 0; index < keys.length; index += 1) {
      if (state.remainingItems <= 0) {
        omitted += keys.length - index;
        truncated = true;
        break;
      }
      const rawKey = keys[index] ?? "";
      const key = boundBrowserObservationString(rawKey);
      if (Object.hasOwn(result, key.value)) {
        omitted += 1;
        shortened += key.truncated ? 1 : 0;
        truncated = true;
        continue;
      }
      const keyBytes = serializedBytes(key.value);
      const separatorBytes = Object.keys(result).length === 0 ? 0 : 1;
      const fixedBytes = separatorBytes + keyBytes + 1;
      const available = maxBytes - bytes - fixedBytes;
      if (available <= 0) {
        omitted += keys.length - index;
        truncated = true;
        break;
      }
      state.remainingItems -= 1;
      let item: JsonProjection;
      try {
        item = projectJson(
          (value as Record<string, unknown>)[rawKey],
          state,
          depth + 1,
          available,
        );
      } catch {
        omitted += 1;
        truncated = true;
        continue;
      }
      if (item.bytes > available) {
        omitted += keys.length - index;
        truncated = true;
        break;
      }
      result[key.value] = item.value;
      bytes += fixedBytes + item.bytes;
      omitted += item.omitted;
      shortened += (key.truncated ? 1 : 0) + item.shortened;
      replaced += item.replaced;
      truncated ||= key.truncated || item.truncated;
    }
    return { value: result, bytes, omitted, shortened, replaced, truncated };
  } finally {
    state.seen.delete(value);
  }
}

export function projectJavascriptResult(result: BackendJavascriptResult): BoundedJavascriptResult {
  const projected = projectJson(
    result.value,
    { remainingItems: MAX_BROWSER_OBSERVATION_ITEMS, seen: new WeakSet() },
    0,
    MAX_BROWSER_OBSERVATION_BYTES,
  );
  const type = projectedString(result.type, "unknown", true, 80);
  return {
    value: projected.value,
    type: type.value,
    omitted: projected.omitted,
    shortened: projected.shortened + (type.truncated ? 1 : 0),
    replaced: projected.replaced + (type.replaced ? 1 : 0),
    truncated: projected.truncated || type.truncated || type.replaced,
    bytes: projected.bytes,
  };
}

function projectEntries<T>(
  input: unknown,
  knownFields: ReadonlySet<string>,
  project: (raw: Record<string, unknown>) => {
    value: T;
    fieldsOmitted: number;
    fieldsShortened: number;
    fieldsReplaced: number;
    truncated: boolean;
  },
): BoundedEntryResult<T> {
  const rawEntries = Array.isArray(input) ? input : [];
  const entries: T[] = [];
  let fieldsOmitted = 0;
  let fieldsShortened = 0;
  let fieldsReplaced = 0;
  let omitted = Array.isArray(input) ? 0 : 1;
  let truncated = !Array.isArray(input);
  let bytes = 2;
  for (let index = 0; index < rawEntries.length; index += 1) {
    if (entries.length >= MAX_BROWSER_OBSERVATION_ITEMS) {
      omitted += rawEntries.length - index;
      truncated = true;
      break;
    }
    const raw = rawEntries[index];
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      omitted += 1;
      truncated = true;
      continue;
    }
    const record = raw as Record<string, unknown>;
    const extraFields = Object.keys(record).filter((key) => !knownFields.has(key)).length;
    const candidate = project(record);
    const candidateBytes = serializedBytes(candidate.value);
    const separatorBytes = entries.length === 0 ? 0 : 1;
    if (bytes + separatorBytes + candidateBytes > MAX_BROWSER_OBSERVATION_BYTES) {
      omitted += rawEntries.length - index;
      truncated = true;
      break;
    }
    entries.push(candidate.value);
    bytes += separatorBytes + candidateBytes;
    fieldsOmitted += extraFields + candidate.fieldsOmitted;
    fieldsShortened += candidate.fieldsShortened;
    fieldsReplaced += candidate.fieldsReplaced;
    truncated ||= extraFields > 0 || candidate.truncated;
  }
  return {
    entries,
    total: rawEntries.length,
    omitted,
    fieldsOmitted,
    fieldsShortened,
    fieldsReplaced,
    truncated:
      truncated || omitted > 0 || fieldsOmitted > 0
      || fieldsShortened > 0 || fieldsReplaced > 0,
    bytes,
  };
}

function projectedString(
  value: unknown,
  fallback = "",
  required = false,
  maxBytes = MAX_BROWSER_OBSERVATION_STRING_BYTES,
): StringProjection & { omitted: boolean; replaced: boolean } {
  if (typeof value !== "string") {
    return {
      value: fallback,
      truncated: false,
      omitted: !required && value !== undefined,
      replaced: required,
    };
  }
  return {
    ...boundBrowserObservationString(value, maxBytes),
    omitted: false,
    replaced: false,
  };
}

function finiteOptional(value: unknown): { value?: number; omitted: number } {
  if (value === undefined) return { omitted: 0 };
  return typeof value === "number" && Number.isFinite(value)
    ? { value, omitted: 0 }
    : { omitted: 1 };
}

const CONSOLE_FIELDS = new Set(["level", "text", "url", "line"]);
const NETWORK_FIELDS = new Set(["method", "url", "status", "type", "bodyBytes"]);

export function projectConsoleEntries(input: unknown): BoundedEntryResult<ConsoleEntry> {
  return projectEntries(input, CONSOLE_FIELDS, (raw) => {
    const level = projectedString(raw["level"], "log", true);
    const text = projectedString(raw["text"], "", true);
    const url = projectedString(raw["url"]);
    const line = finiteOptional(raw["line"]);
    const fieldsShortened = [level, text, url].filter((field) => field.truncated).length;
    const fieldsReplaced = [level, text, url].filter((field) => field.replaced).length;
    const fieldsOmitted = [level, text, url].filter((field) => field.omitted).length
      + line.omitted;
    return {
      value: {
        level: level.value,
        text: text.value,
        ...(url.value === "" ? {} : { url: url.value }),
        ...(line.value === undefined ? {} : { line: line.value }),
      },
      fieldsOmitted,
      fieldsShortened,
      fieldsReplaced,
      truncated: fieldsOmitted > 0 || fieldsShortened > 0 || fieldsReplaced > 0,
    };
  });
}

export function projectNetworkEntries(input: unknown): BoundedEntryResult<NetworkEntry> {
  return projectEntries(input, NETWORK_FIELDS, (raw) => {
    const method = projectedString(raw["method"], "GET", true);
    const url = projectedString(raw["url"], "", true);
    const type = projectedString(raw["type"]);
    const status = finiteOptional(raw["status"]);
    const bodyBytes = finiteOptional(raw["bodyBytes"]);
    const fieldsShortened = [method, url, type].filter((field) => field.truncated).length;
    const fieldsReplaced = [method, url, type].filter((field) => field.replaced).length;
    const fieldsOmitted = [method, url, type].filter((field) => field.omitted).length
      + status.omitted + bodyBytes.omitted;
    return {
      value: {
        method: method.value,
        url: url.value,
        ...(status.value === undefined ? {} : { status: status.value }),
        ...(type.value === "" ? {} : { type: type.value }),
        ...(bodyBytes.value === undefined ? {} : { bodyBytes: bodyBytes.value }),
      },
      fieldsOmitted,
      fieldsShortened,
      fieldsReplaced,
      truncated: fieldsOmitted > 0 || fieldsShortened > 0 || fieldsReplaced > 0,
    };
  });
}
