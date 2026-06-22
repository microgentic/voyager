import { randomId } from "../crypto";
import { HttpError, stringField } from "../http";
import type { AuthContext, Env } from "../types";
import type { JsonObject } from "./shared/types";
import { getActivePrincipal } from "./rooms";
import { nextCursor, optionalJsonText, pageParams } from "./utils";
import { publicAgentRequest, publicPrincipal } from "./shared/serializers";

export async function createAgentRequest(
  env: Env,
  auth: AuthContext,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  const requestId = randomId("agr");
  await env.CONTROL_DB.prepare(
    `INSERT INTO agent_requests (
      request_id, requester_account_id, requester_principal_id, desired_agent_name,
      summary, status, metadata_json
    ) VALUES (?, ?, ?, ?, ?, 'submitted', ?)`,
  )
    .bind(
      requestId,
      auth.account.account_id,
      auth.principal.principal_id,
      stringField(body, "desiredAgentName", {
        required: true,
        min: 1,
        max: 120,
      })!,
      stringField(body, "summary", { required: true, min: 1, max: 2000 })!,
      optionalJsonText(body, "metadata", 4096),
    )
    .run();
  return getAgentRequest(env, requestId);
}

export async function listOwnAgentRequests(
  env: Env,
  auth: AuthContext,
  url: URL,
): Promise<JsonObject> {
  const page = pageParams(url, { defaultLimit: 50, maxLimit: 200 });
  const result = await env.CONTROL_DB.prepare(
    "SELECT * FROM agent_requests WHERE requester_account_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
  )
    .bind(auth.account.account_id, page.limit, page.offset)
    .all<Record<string, unknown>>();
  const requests = (result.results ?? []).map(publicAgentRequest);
  return { requests, nextCursor: nextCursor(requests.length, page) };
}

export async function listAdminAgentRequests(
  env: Env,
  url: URL,
): Promise<JsonObject> {
  const page = pageParams(url, { defaultLimit: 50, maxLimit: 200 });
  const status = url.searchParams.get("status");
  if (
    status &&
    ![
      "submitted",
      "under_review",
      "approved",
      "rejected",
      "provisioning",
      "active",
      "closed",
    ].includes(status)
  ) {
    throw new HttpError(
      400,
      "invalid_agent_request_status",
      "Unsupported agent request status",
    );
  }
  const where = status ? "WHERE status = ?" : "";
  const stmt = env.CONTROL_DB.prepare(
    `SELECT * FROM agent_requests ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  );
  const result = status
    ? await stmt
        .bind(status, page.limit, page.offset)
        .all<Record<string, unknown>>()
    : await stmt.bind(page.limit, page.offset).all<Record<string, unknown>>();
  const requests = (result.results ?? []).map(publicAgentRequest);
  return { requests, nextCursor: nextCursor(requests.length, page) };
}

export async function reviewAgentRequest(
  env: Env,
  auth: AuthContext,
  requestId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  const status = stringField(body, "status", { required: true, max: 40 })!;
  if (!["under_review", "approved", "rejected", "closed"].includes(status)) {
    throw new HttpError(
      400,
      "invalid_agent_request_status",
      "Unsupported agent request status",
    );
  }
  await env.CONTROL_DB.prepare(
    "UPDATE agent_requests SET status = ?, reviewed_by_account_id = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE request_id = ?",
  )
    .bind(status, auth.account.account_id, requestId)
    .run();
  return getAgentRequest(env, requestId);
}

export async function createAgentPrincipal(
  env: Env,
  auth: AuthContext,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  const ownerPrincipalId =
    stringField(body, "ownerPrincipalId", { max: 80 }) ??
    auth.principal.principal_id;
  const owner = await getActivePrincipal(env, ownerPrincipalId);
  if (owner.principal_type !== "human") {
    throw new HttpError(
      400,
      "invalid_agent_owner",
      "Agent owner must be a human principal",
    );
  }
  const principalId = randomId("prn");
  await env.CONTROL_DB.prepare(
    `INSERT INTO principals (
      principal_id, account_id, principal_type, display_name, status, owner_principal_id
    ) VALUES (?, ?, 'agent', ?, 'active', ?)`,
  )
    .bind(
      principalId,
      owner.account_id,
      stringField(body, "displayName", { required: true, min: 1, max: 120 })!,
      ownerPrincipalId,
    )
    .run();
  const requestId = stringField(body, "requestId", { max: 80 });
  if (requestId) {
    await env.CONTROL_DB.prepare(
      "UPDATE agent_requests SET status = 'active', created_agent_principal_id = ?, updated_at = CURRENT_TIMESTAMP WHERE request_id = ?",
    )
      .bind(principalId, requestId)
      .run();
  }
  return publicPrincipal(await getActivePrincipal(env, principalId));
}

export async function getAgentRequest(
  env: Env,
  requestId: string,
): Promise<JsonObject> {
  const request = await env.CONTROL_DB.prepare(
    "SELECT * FROM agent_requests WHERE request_id = ?",
  )
    .bind(requestId)
    .first<Record<string, unknown>>();
  if (!request)
    throw new HttpError(
      404,
      "agent_request_not_found",
      "Agent request not found",
    );
  return publicAgentRequest(request);
}
