import { audit, requireAdmin } from "../../db";
import { json, requireMethod } from "../../http";
import { listAdminRooms, listMaintenanceRuns, runCleanup } from "../maintenance";
import type { RouteResult } from "../internal-types";
import type { BackendRouteContext } from "./types";

export async function handleAdminRoutes(context: BackendRouteContext): Promise<RouteResult> {
  const { request, env, url, requestId, auth, authTimingMs } = context;
  if (url.pathname === "/v1/admin/rooms") {
    requireMethod(request, "GET");
    requireAdmin(auth, ["user_admin", "security_admin", "auditor"]);
    return json({ ok: true, ...(await listAdminRooms(env, url)) });
  }

  if (url.pathname === "/v1/admin/maintenance/runs") {
    requireMethod(request, "GET");
    requireAdmin(auth, ["security_admin", "auditor"]);
    return json({ ok: true, ...(await listMaintenanceRuns(env, url)) });
  }

  if (url.pathname === "/v1/admin/maintenance/cleanup") {
    requireMethod(request, "POST");
    const adminRole = requireAdmin(auth, ["security_admin"]);
    const result = await runCleanup(env, auth);
    await audit(env, {
      actorAccountId: auth.account.account_id,
      actorAdminRole: adminRole,
      action: "admin.maintenance.cleanup",
      targetType: "maintenance",
      targetId: String(result.maintenanceRunId),
      requestId,
      result: "success",
      metadata: result,
    });
    return json({ ok: true, cleanup: result }, { status: 201 });
  }

  return null;
}
