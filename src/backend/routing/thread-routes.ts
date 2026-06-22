import { audit } from "../../db";
import { json, readJsonObject, requireMethod, routeParams } from "../../http";
import {
  sendMessageThroughConversationCoordinator,
} from "../conversation-coordinator";
import { getThread } from "../messages";
import { listThreads, markThreadRead, updateThreadSubscription } from "../threads";
import { readTimingHeaders, sendMessageTimingHeaders } from "../utils";
import type { RouteResult } from "../shared/types";
import type { BackendRouteContext } from "./types";

export async function handleThreadRoutes(context: BackendRouteContext): Promise<RouteResult> {
  const { request, env, url, requestId, auth, authTimingMs } = context;
  if (url.pathname === "/v1/threads") {
    requireMethod(request, "GET");
    const startedAt = performance.now();
    return json(
      { ok: true, ...(await listThreads(env, auth, url)) },
      { headers: readTimingHeaders("threads", authTimingMs, startedAt) },
    );
  }

  const threadMatch = routeParams(
    /^\/v1\/rooms\/([^/]+)\/messages\/([^/]+)\/thread$/,
    url.pathname,
  );
  if (threadMatch) {
    if (request.method === "GET") {
      return json({
        ok: true,
        thread: await getThread(env, auth, threadMatch[1], threadMatch[2], url),
      });
    }
    requireMethod(request, "POST");
    const body = await readJsonObject(request);
    const alsoSendToRoom = body.alsoSendToRoom === true;
    const { message, metrics } =
      await sendMessageThroughConversationCoordinator(
        env,
        auth,
        threadMatch[1],
        body,
        requestId,
        {
          threadReply: {
            rootEnvelopeId: threadMatch[2],
            alsoSendToRoom,
          },
        },
      );
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "message.thread_reply",
      targetType: "message",
      targetId: threadMatch[2],
      requestId,
      result: "success",
      metadata: {
        roomId: threadMatch[1],
        replyEnvelopeId: message.envelopeId,
        sequence: message.serverSequence,
        alsoSentToRoom: alsoSendToRoom,
      },
    });
    return json(
      { ok: true, message },
      { status: 201, headers: sendMessageTimingHeaders(metrics) },
    );
  }

  const threadReadMatch = routeParams(
    /^\/v1\/rooms\/([^/]+)\/messages\/([^/]+)\/thread\/read$/,
    url.pathname,
  );
  if (threadReadMatch) {
    requireMethod(request, "POST");
    const state = await markThreadRead(
      env,
      auth,
      threadReadMatch[1],
      threadReadMatch[2],
    );
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "message.thread_read",
      targetType: "message",
      targetId: threadReadMatch[2],
      requestId,
      result: "success",
      metadata: { roomId: threadReadMatch[1] },
    });
    return json({ ok: true, threadState: state });
  }

  const threadSubscriptionMatch = routeParams(
    /^\/v1\/rooms\/([^/]+)\/messages\/([^/]+)\/thread\/subscription$/,
    url.pathname,
  );
  if (threadSubscriptionMatch) {
    requireMethod(request, "PATCH");
    const state = await updateThreadSubscription(
      env,
      auth,
      threadSubscriptionMatch[1],
      threadSubscriptionMatch[2],
      await readJsonObject(request),
    );
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "message.thread_subscription.update",
      targetType: "message",
      targetId: threadSubscriptionMatch[2],
      requestId,
      result: "success",
      metadata: { roomId: threadSubscriptionMatch[1] },
    });
    return json({ ok: true, threadState: state });
  }

  return null;
}
