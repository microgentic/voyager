import { json, readJsonObject, requireMethod, routeParams } from "../../http";
import {
  addSidebarCollectionItem,
  createSidebarCollection,
  deleteSidebarCollection,
  deleteSidebarCollectionItem,
  listSidebarCollections,
  updateSidebarCollection,
} from "../sidebar";
import { readTimingHeaders } from "../utils";
import type { RouteResult } from "../internal-types";
import type { BackendRouteContext } from "./types";

export async function handleSidebarRoutes(context: BackendRouteContext): Promise<RouteResult> {
  const { request, env, url, requestId, auth, authTimingMs } = context;
  if (url.pathname === "/v1/sidebar-collections") {
    if (request.method === "GET") {
      const startedAt = performance.now();
      return json(
        { ok: true, collections: await listSidebarCollections(env, auth) },
        {
          headers: readTimingHeaders(
            "sidebarCollections",
            authTimingMs,
            startedAt,
          ),
        },
      );
    }
    if (request.method === "POST") {
      return json(
        {
          ok: true,
          collection: await createSidebarCollection(
            env,
            auth,
            await readJsonObject(request),
          ),
        },
        { status: 201 },
      );
    }
  }

  const sidebarMatch = routeParams(
    /^\/v1\/sidebar-collections\/([^/]+)$/,
    url.pathname,
  );
  if (sidebarMatch) {
    if (request.method === "PATCH") {
      return json({
        ok: true,
        collection: await updateSidebarCollection(
          env,
          auth,
          sidebarMatch[1],
          await readJsonObject(request),
        ),
      });
    }
    if (request.method === "DELETE") {
      await deleteSidebarCollection(env, auth, sidebarMatch[1]);
      return json({ ok: true });
    }
  }

  const sidebarItemMatch = routeParams(
    /^\/v1\/sidebar-collections\/([^/]+)\/items$/,
    url.pathname,
  );
  if (sidebarItemMatch) {
    requireMethod(request, "POST");
    return json(
      {
        ok: true,
        item: await addSidebarCollectionItem(
          env,
          auth,
          sidebarItemMatch[1],
          await readJsonObject(request),
        ),
      },
      { status: 201 },
    );
  }

  const sidebarItemDeleteMatch = routeParams(
    /^\/v1\/sidebar-collections\/([^/]+)\/items\/([^/]+)$/,
    url.pathname,
  );
  if (sidebarItemDeleteMatch) {
    requireMethod(request, "DELETE");
    await deleteSidebarCollectionItem(
      env,
      auth,
      sidebarItemDeleteMatch[1],
      sidebarItemDeleteMatch[2],
    );
    return json({ ok: true });
  }

  return null;
}
