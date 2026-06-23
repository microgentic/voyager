import { requireAdmin } from "../../db";
import { json, requireMethod } from "../../http";
import { listAdminRooms } from "../maintenance";
import type { RouteResult } from "../shared/types";
import type { BackendRouteContext } from "./types";

export async function handleAdminRoutes(context: BackendRouteContext): Promise<RouteResult> {
  const { request, env, url, auth } = context;
  if (url.pathname === "/v1/admin/rooms") {
    requireMethod(request, "GET");
    requireAdmin(auth, ["user_admin", "security_admin", "auditor"]);
    return json({ ok: true, ...(await listAdminRooms(env, url)) });
  }

  return null;
}
