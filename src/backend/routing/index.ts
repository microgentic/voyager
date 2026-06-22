import type { AuthContext, Env } from "../../types";
import type { RouteResult } from "../internal-types";
import type { BackendRouteContext, BackendRouteHandler } from "./types";
import { handleAdminRoutes } from "./admin-routes";
import { handleAgentRoutes } from "./agent-routes";
import { handleAttachmentRoutes } from "./attachment-routes";
import { handleCallRoutes } from "./call-routes";
import { handleIdentityRoutes } from "./identity-routes";
import { handleMaintenanceRoutes } from "./maintenance-routes";
import { handleMessageRoutes } from "./message-routes";
import { handleRoomRoutes } from "./room-routes";
import { handleSidebarRoutes } from "./sidebar-routes";
import { handleSyncRoutes } from "./sync-routes";
import { handleThreadRoutes } from "./thread-routes";

const ROUTE_HANDLERS: BackendRouteHandler[] = [
  handleIdentityRoutes,
  handleRoomRoutes,
  handleThreadRoutes,
  handleCallRoutes,
  handleMessageRoutes,
  handleSyncRoutes,
  handleAttachmentRoutes,
  handleSidebarRoutes,
  handleAgentRoutes,
  handleMaintenanceRoutes,
  handleAdminRoutes,
];

export async function handleBackendFirstRoutes(
  request: Request,
  env: Env,
  url: URL,
  requestId: string,
  auth: AuthContext,
  authTimingMs = 0,
): Promise<RouteResult> {
  const context: BackendRouteContext = { request, env, url, requestId, auth, authTimingMs };
  for (const handler of ROUTE_HANDLERS) {
    const response = await handler(context);
    if (response) return response;
  }
  return null;
}
