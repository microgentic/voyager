import { audit } from "../../db";
import { json, readJsonObject, requireMethod, routeParams } from "../../http";
import {
  claimKeyPackage,
  listAvailableKeyPackages,
  listOwnDeviceKeyPackages,
  listPrincipalDevices,
  listPrincipals,
  publishKeyPackage,
  revokeKeyPackage,
} from "../identity";
import { appBootstrap } from "../sync";
import { readTimingHeaders } from "../utils";
import type { RouteResult } from "../shared/types";
import type { BackendRouteContext } from "./types";

export async function handleIdentityRoutes(context: BackendRouteContext): Promise<RouteResult> {
  const { request, env, url, requestId, auth, authTimingMs } = context;
  if (url.pathname === "/v1/principals") {
    requireMethod(request, "GET");
    const startedAt = performance.now();
    return json(
      { ok: true, principals: await listPrincipals(env) },
      { headers: readTimingHeaders("principals", authTimingMs, startedAt) },
    );
  }

  if (url.pathname === "/v1/app/bootstrap") {
    requireMethod(request, "GET");
    const startedAt = performance.now();
    const result = await appBootstrap(env, auth, url, requestId);
    return json(
      { ok: true, bootstrap: result.bootstrap },
      {
        headers: readTimingHeaders("bootstrap", authTimingMs, startedAt, [
          ["rooms", result.metrics.roomsMs],
          ["messages", result.metrics.messagesMs],
        ]),
      },
    );
  }

  const principalDevicesMatch = routeParams(
    /^\/v1\/principals\/([^/]+)\/devices$/,
    url.pathname,
  );
  if (principalDevicesMatch) {
    requireMethod(request, "GET");
    return json({
      ok: true,
      devices: await listPrincipalDevices(env, principalDevicesMatch[1]),
    });
  }

  const publishKeyPackageMatch = routeParams(
    /^\/v1\/devices\/([^/]+)\/key-packages$/,
    url.pathname,
  );
  if (publishKeyPackageMatch) {
    if (request.method === "GET") {
      return json({
        ok: true,
        ...(await listOwnDeviceKeyPackages(
          env,
          auth,
          publishKeyPackageMatch[1],
          url,
        )),
      });
    }
    requireMethod(request, "POST");
    const body = await readJsonObject(request);
    const keyPackage = await publishKeyPackage(
      env,
      auth,
      publishKeyPackageMatch[1],
      body,
    );
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "device.key_package.publish",
      targetType: "device",
      targetId: publishKeyPackageMatch[1],
      requestId,
      result: "success",
      metadata: { keyPackageId: keyPackage.keyPackageId },
    });
    return json({ ok: true, keyPackage }, { status: 201 });
  }

  const listKeyPackagesMatch = routeParams(
    /^\/v1\/principals\/([^/]+)\/key-packages$/,
    url.pathname,
  );
  if (listKeyPackagesMatch) {
    requireMethod(request, "GET");
    return json({
      ok: true,
      keyPackages: await listAvailableKeyPackages(env, listKeyPackagesMatch[1]),
    });
  }

  const claimKeyPackageMatch = routeParams(
    /^\/v1\/key-packages\/([^/]+)\/claim$/,
    url.pathname,
  );
  if (claimKeyPackageMatch) {
    requireMethod(request, "POST");
    const keyPackage = await claimKeyPackage(
      env,
      auth,
      claimKeyPackageMatch[1],
    );
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "device.key_package.claim",
      targetType: "key_package",
      targetId: claimKeyPackageMatch[1],
      requestId,
      result: "success",
    });
    return json({ ok: true, keyPackage });
  }

  const revokeKeyPackageMatch = routeParams(
    /^\/v1\/key-packages\/([^/]+)\/revoke$/,
    url.pathname,
  );
  if (revokeKeyPackageMatch) {
    requireMethod(request, "POST");
    await revokeKeyPackage(env, auth, revokeKeyPackageMatch[1]);
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "device.key_package.revoke",
      targetType: "key_package",
      targetId: revokeKeyPackageMatch[1],
      requestId,
      result: "success",
    });
    return json({ ok: true });
  }

  return null;
}
