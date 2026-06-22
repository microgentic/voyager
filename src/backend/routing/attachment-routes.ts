import { audit } from "../../db";
import { json, readJsonObject, requireMethod, routeParams } from "../../http";
import {
  allocateAttachment,
  completeAttachment,
  deleteAttachment,
  downloadAttachmentBlob,
  parseAttachmentVariant,
  uploadAttachmentBlob,
} from "../attachments";
import type { RouteResult } from "../internal-types";
import type { BackendRouteContext } from "./types";

export async function handleAttachmentRoutes(context: BackendRouteContext): Promise<RouteResult> {
  const { request, env, url, requestId, auth, authTimingMs } = context;
  const allocateAttachmentMatch = routeParams(
    /^\/v1\/rooms\/([^/]+)\/attachments$/,
    url.pathname,
  );
  if (allocateAttachmentMatch) {
    requireMethod(request, "POST");
    const attachment = await allocateAttachment(
      env,
      auth,
      allocateAttachmentMatch[1],
      await readJsonObject(request),
    );
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "attachment.allocate",
      targetType: "attachment",
      targetId: String(attachment.attachmentId),
      requestId,
      result: "success",
    });
    return json({ ok: true, attachment }, { status: 201 });
  }

  const attachmentBlobMatch = routeParams(
    /^\/v1\/attachments\/([^/]+)\/blob$/,
    url.pathname,
  );
  if (attachmentBlobMatch) {
    if (request.method === "PUT") {
      const attachment = await uploadAttachmentBlob(
        env,
        auth,
        attachmentBlobMatch[1],
        request,
        parseAttachmentVariant(url.searchParams.get("variant")),
      );
      await audit(env, {
        actorAccountId: auth.account.account_id,
        action: "attachment.upload",
        targetType: "attachment",
        targetId: attachmentBlobMatch[1],
        requestId,
        result: "success",
      });
      return json({ ok: true, attachment });
    }
    if (request.method === "GET") {
      return downloadAttachmentBlob(
        env,
        auth,
        attachmentBlobMatch[1],
        parseAttachmentVariant(url.searchParams.get("variant")),
      );
    }
  }

  const completeAttachmentMatch = routeParams(
    /^\/v1\/attachments\/([^/]+)\/complete$/,
    url.pathname,
  );
  if (completeAttachmentMatch) {
    requireMethod(request, "POST");
    const attachment = await completeAttachment(
      env,
      auth,
      completeAttachmentMatch[1],
      await readJsonObject(request),
    );
    return json({ ok: true, attachment });
  }

  const attachmentMatch = routeParams(
    /^\/v1\/attachments\/([^/]+)$/,
    url.pathname,
  );
  if (attachmentMatch) {
    requireMethod(request, "DELETE");
    await deleteAttachment(env, auth, attachmentMatch[1]);
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "attachment.delete",
      targetType: "attachment",
      targetId: attachmentMatch[1],
      requestId,
      result: "success",
    });
    return json({ ok: true });
  }

  return null;
}
