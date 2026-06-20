import type { AuthContext } from "./types";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message = code,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export interface RequestContext {
  request: Request;
  requestId: string;
  url: URL;
  auth?: AuthContext;
}

export type ServerTimingMetric = [name: string, durationMs: number | null | undefined];

export function serverTimingHeader(metrics: ServerTimingMetric[]): string {
  return metrics
    .filter((metric): metric is [string, number] => typeof metric[1] === "number" && Number.isFinite(metric[1]))
    .map(([name, durationMs]) => `${name.replace(/[^a-zA-Z0-9_-]/g, "")};dur=${roundDuration(durationMs)}`)
    .join(", ");
}

export function roundDuration(durationMs: number): number {
  return Math.round(durationMs * 100) / 100;
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("cache-control", "no-store");
  return Response.json(data, { ...init, headers });
}

export function errorResponse(error: unknown, requestId: string): Response {
  if (error instanceof HttpError) {
    return json(
      {
        ok: false,
        error: error.code,
        message: error.message,
        requestId,
        details: error.details
      },
      { status: error.status }
    );
  }

  console.error("Unhandled request error", { requestId, error });
  return json(
    {
      ok: false,
      error: "internal_error",
      message: "Internal error",
      requestId
    },
    { status: 500 }
  );
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Expected application/json");
  }

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "invalid_body", "Request body must be a JSON object");
  }

  return parsed as Record<string, unknown>;
}

export function stringField(
  body: Record<string, unknown>,
  key: string,
  options: { required?: boolean; min?: number; max?: number; pattern?: RegExp } = {}
): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) {
    if (options.required) {
      throw new HttpError(400, "missing_field", `Missing required field: ${key}`);
    }
    return undefined;
  }
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_field", `Field must be a string: ${key}`);
  }
  const trimmed = value.trim();
  if (options.min !== undefined && trimmed.length < options.min) {
    throw new HttpError(400, "invalid_field", `Field is too short: ${key}`);
  }
  if (options.max !== undefined && trimmed.length > options.max) {
    throw new HttpError(400, "invalid_field", `Field is too long: ${key}`);
  }
  if (options.pattern && !options.pattern.test(trimmed)) {
    throw new HttpError(400, "invalid_field", `Field is invalid: ${key}`);
  }
  return trimmed;
}

export function optionalObject(body: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_field", `Field must be an object: ${key}`);
  }
  return value as Record<string, unknown>;
}

export function requireMethod(request: Request, method: string): void {
  if (request.method !== method) {
    throw new HttpError(405, "method_not_allowed", `Expected ${method}`);
  }
}

export function routeParams(pattern: RegExp, pathname: string): RegExpMatchArray | null {
  return pathname.match(pattern);
}

export function publicAccount(account: {
  account_id: string;
  status: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  policy_id: string;
  default_principal_id: string | null;
  created_at: string;
  activated_at: string | null;
}) {
  return {
    accountId: account.account_id,
    status: account.status,
    displayName: account.display_name,
    email: account.email,
    phone: account.phone,
    policyId: account.policy_id,
    defaultPrincipalId: account.default_principal_id,
    createdAt: account.created_at,
    activatedAt: account.activated_at
  };
}
