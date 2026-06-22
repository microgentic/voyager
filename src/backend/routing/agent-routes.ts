import { audit, requireAdmin } from "../../db";
import { json, readJsonObject, requireMethod, routeParams } from "../../http";
import {
  createAgentPrincipal,
  createAgentRequest,
  listAdminAgentRequests,
  listOwnAgentRequests,
  reviewAgentRequest,
} from "../agents";
import type { RouteResult } from "../shared/types";
import type { BackendRouteContext } from "./types";

export async function handleAgentRoutes(context: BackendRouteContext): Promise<RouteResult> {
  const { request, env, url, requestId, auth, authTimingMs } = context;
  if (url.pathname === "/v1/agent-requests") {
    if (request.method === "GET") {
      return json({
        ok: true,
        ...(await listOwnAgentRequests(env, auth, url)),
      });
    }
    if (request.method === "POST") {
      const agentRequest = await createAgentRequest(
        env,
        auth,
        await readJsonObject(request),
      );
      await audit(env, {
        actorAccountId: auth.account.account_id,
        action: "agent_request.submit",
        targetType: "agent_request",
        targetId: String(agentRequest.requestId),
        requestId,
        result: "success",
      });
      return json({ ok: true, request: agentRequest }, { status: 201 });
    }
  }

  if (url.pathname === "/v1/admin/agent-requests") {
    requireMethod(request, "GET");
    requireAdmin(auth, ["agent_provisioner", "user_admin", "auditor"]);
    return json({ ok: true, ...(await listAdminAgentRequests(env, url)) });
  }

  const adminAgentRequestMatch = routeParams(
    /^\/v1\/admin\/agent-requests\/([^/]+)$/,
    url.pathname,
  );
  if (adminAgentRequestMatch) {
    requireMethod(request, "PATCH");
    const adminRole = requireAdmin(auth, ["agent_provisioner"]);
    const agentRequest = await reviewAgentRequest(
      env,
      auth,
      adminAgentRequestMatch[1],
      await readJsonObject(request),
    );
    await audit(env, {
      actorAccountId: auth.account.account_id,
      actorAdminRole: adminRole,
      action: "admin.agent_request.review",
      targetType: "agent_request",
      targetId: adminAgentRequestMatch[1],
      requestId,
      result: "success",
      metadata: { status: agentRequest.status },
    });
    return json({ ok: true, request: agentRequest });
  }

  if (url.pathname === "/v1/admin/agents") {
    requireMethod(request, "POST");
    const adminRole = requireAdmin(auth, ["agent_provisioner"]);
    const agent = await createAgentPrincipal(
      env,
      auth,
      await readJsonObject(request),
    );
    await audit(env, {
      actorAccountId: auth.account.account_id,
      actorAdminRole: adminRole,
      action: "admin.agent.create",
      targetType: "principal",
      targetId: String(agent.principalId),
      requestId,
      result: "success",
    });
    return json({ ok: true, agent }, { status: 201 });
  }

  return null;
}
