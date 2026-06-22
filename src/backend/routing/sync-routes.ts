import { json, requireMethod } from "../../http";
import { syncAccount } from "../sync";
import { readTimingHeaders } from "../utils";
import type { RouteResult } from "../shared/types";
import type { BackendRouteContext } from "./types";

export async function handleSyncRoutes(context: BackendRouteContext): Promise<RouteResult> {
  const { request, env, url, requestId, auth, authTimingMs } = context;
  if (url.pathname === "/v1/sync") {
    requireMethod(request, "GET");
    const startedAt = performance.now();
    return json(
      { ok: true, sync: await syncAccount(env, auth, url) },
      { headers: readTimingHeaders("sync", authTimingMs, startedAt) },
    );
  }

  return null;
}
