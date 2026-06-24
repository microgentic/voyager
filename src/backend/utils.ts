import { HttpError, serverTimingHeader } from "../http";
import type { PageParams } from "./shared/types";

export function stringArrayField(
  body: Record<string, unknown>,
  key: string,
  options: { required?: boolean; maxItems?: number } = {},
): string[] {
  const value = body[key];
  if (value === undefined || value === null) {
    if (options.required)
      throw new HttpError(
        400,
        "missing_field",
        `Missing required field: ${key}`,
      );
    return [];
  }
  if (
    !Array.isArray(value) ||
    !value.every(
      (entry) => typeof entry === "string" && entry.trim().length > 0,
    )
  ) {
    throw new HttpError(
      400,
      "invalid_field",
      `Field must be an array of strings: ${key}`,
    );
  }
  if (options.maxItems !== undefined && value.length > options.maxItems) {
    throw new HttpError(
      400,
      "invalid_field",
      `Too many items for field: ${key}`,
    );
  }
  return value.map((entry) => entry.trim());
}

export function requiredJsonText(
  body: Record<string, unknown>,
  key: string,
  maxBytes: number,
): string {
  const value = body[key];
  if (value === undefined || value === null)
    throw new HttpError(400, "missing_field", `Missing required field: ${key}`);
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (byteLength(text) > maxBytes)
    throw new HttpError(413, "json_too_large", `Field is too large: ${key}`);
  return text;
}

export function optionalJsonText(
  body: Record<string, unknown>,
  key: string,
  maxBytes: number,
): string | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (byteLength(text) > maxBytes)
    throw new HttpError(413, "json_too_large", `Field is too large: ${key}`);
  return text;
}

export function numberField(
  body: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  fallback?: number,
): number {
  const value = body[key];
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw new HttpError(400, "missing_field", `Missing required field: ${key}`);
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new HttpError(
      400,
      "invalid_field",
      `Field must be an integer between ${min} and ${max}: ${key}`,
    );
  }
  return value;
}

export function optionalNumberField(
  body: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new HttpError(
      400,
      "invalid_field",
      `Field must be an integer between ${min} and ${max}: ${key}`,
    );
  }
  return value;
}

export function booleanField(
  body: Record<string, unknown>,
  key: string,
): boolean {
  const value = body[key];
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean")
    throw new HttpError(
      400,
      "invalid_field",
      `Field must be a boolean: ${key}`,
    );
  return value;
}

export function numberParam(
  url: URL,
  key: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const value = url.searchParams.get(key);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpError(
      400,
      "invalid_query",
      `Query parameter must be an integer between ${min} and ${max}: ${key}`,
    );
  }
  return parsed;
}

export function pageParams(
  url: URL | undefined,
  options: { defaultLimit: number; maxLimit: number },
): PageParams {
  const limit = url
    ? numberParam(url, "limit", 1, options.maxLimit, options.defaultLimit)
    : options.defaultLimit;
  const cursor = url?.searchParams.get("cursor");
  if (!cursor) return { limit, offset: 0 };
  const offset = Number(cursor);
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > Number.MAX_SAFE_INTEGER
  ) {
    throw new HttpError(400, "invalid_cursor", "Cursor is invalid");
  }
  return { limit, offset };
}

export function nextCursor(
  resultCount: number,
  page: PageParams,
): string | null {
  return resultCount === page.limit ? String(page.offset + page.limit) : null;
}

export function readTimingHeaders(
  routeName: string,
  authMs: number,
  startedAt: number,
  extra: Array<[string, number]> = [],
): Record<string, string> {
  const readMs = durationSince(startedAt);
  return {
    "server-timing": serverTimingHeader([
      [routeName, authMs + readMs],
      ["auth", authMs],
      ["read", readMs],
      ...extra,
    ]),
  };
}

export function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function durationSince(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

export async function runCounted(
  statement: D1PreparedStatement,
): Promise<number> {
  const result = await statement.run();
  const meta = result.meta as { changes?: number } | undefined;
  return meta?.changes ?? 0;
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function parseJson(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function sqliteTimestamp(value: number | Date): string {
  const date = typeof value === "number" ? new Date(value) : value;
  return date
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
}
