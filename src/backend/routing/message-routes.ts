import { audit } from "../../db";
import { HttpError, json, readJsonObject, requireMethod, routeParams, stringField } from "../../http";
import {
  requireCoordinatorResult,
  runMutationThroughConversationCoordinator,
  sendMessageThroughConversationCoordinator,
} from "../conversation-coordinator";
import {
  acknowledgeMessage,
  deleteMessagesForMe,
  getThread,
  listRoomMessages,
  resolveForwardSource,
} from "../messages";
import { markThreadRead, updateThreadSubscription } from "../threads";
import { mutationTimingHeaders, sendMessageTimingHeaders } from "../utils";
import type { RouteResult } from "../internal-types";
import type { BackendRouteContext } from "./types";

export async function handleMessageRoutes(context: BackendRouteContext): Promise<RouteResult> {
  const { request, env, url, requestId, auth, authTimingMs } = context;
  const messagesMatch = routeParams(
    /^\/v1\/rooms\/([^/]+)\/messages$/,
    url.pathname,
  );
  if (messagesMatch) {
    if (request.method === "GET") {
      return json({
        ok: true,
        messages: await listRoomMessages(env, auth, messagesMatch[1], url),
      });
    }
    if (request.method === "POST") {
      const { message, metrics } =
        await sendMessageThroughConversationCoordinator(
          env,
          auth,
          messagesMatch[1],
          await readJsonObject(request),
          requestId,
        );
      await audit(env, {
        actorAccountId: auth.account.account_id,
        action: "message.send",
        targetType: "room",
        targetId: messagesMatch[1],
        requestId,
        result: "success",
        metadata: {
          envelopeId: message.envelopeId,
          sequence: message.serverSequence,
        },
      });
      return json(
        { ok: true, message },
        { status: 201, headers: sendMessageTimingHeaders(metrics) },
      );
    }
  }

  const deleteMessagesMatch = routeParams(
    /^\/v1\/rooms\/([^/]+)\/messages\/delete$/,
    url.pathname,
  );
  if (deleteMessagesMatch) {
    requireMethod(request, "POST");
    const body = await readJsonObject(request);
    const scope = body.scope;
    let deleted: Record<string, unknown>;
    if (scope === "everyone") {
      const mutation = await runMutationThroughConversationCoordinator(
        env,
        auth,
        deleteMessagesMatch[1],
        requestId,
        {
          operation: "message.delete_everyone",
          body,
        },
      );
      deleted = requireCoordinatorResult(mutation.result);
    } else {
      deleted = await deleteMessagesForMe(
        env,
        auth,
        deleteMessagesMatch[1],
        body,
      );
    }
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: deleted.scope === "everyone" ? "message.delete_everyone" : "message.delete_for_me",
      targetType: "room",
      targetId: deleteMessagesMatch[1],
      requestId,
      result: "success",
      metadata: {
        envelopeIds: deleted.envelopeIds,
        count: Array.isArray(deleted.envelopeIds)
          ? deleted.envelopeIds.length
          : undefined,
      },
    });
    return json({ ok: true, deleted });
  }

  const messageForwardMatch = routeParams(
    /^\/v1\/rooms\/([^/]+)\/messages\/([^/]+)\/forward$/,
    url.pathname,
  );
  if (messageForwardMatch) {
    requireMethod(request, "POST");
    const body = await readJsonObject(request);
    const targetRoomId = stringField(body, "targetRoomId", {
      required: true,
      max: 80,
    })!;
    if (targetRoomId === messageForwardMatch[1]) {
      throw new HttpError(
        400,
        "invalid_forward_target",
        "Forward target must be a different room",
      );
    }
    const forwardSource = await resolveForwardSource(
      env,
      auth,
      messageForwardMatch[1],
      messageForwardMatch[2],
    );
    const { message, metrics } =
      await sendMessageThroughConversationCoordinator(
        env,
        auth,
        targetRoomId,
        body,
        requestId,
        { forwardSource },
      );
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "message.forward",
      targetType: "message",
      targetId: messageForwardMatch[2],
      requestId,
      result: "success",
      metadata: {
        sourceRoomId: messageForwardMatch[1],
        targetRoomId,
        forwardedEnvelopeId: message.envelopeId,
        sequence: message.serverSequence,
      },
    });
    return json(
      { ok: true, message },
      { status: 201, headers: sendMessageTimingHeaders(metrics) },
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

  const messageReactionDeleteMatch = routeParams(
    /^\/v1\/rooms\/([^/]+)\/messages\/([^/]+)\/reactions\/([^/]+)$/,
    url.pathname,
  );
  if (messageReactionDeleteMatch) {
    requireMethod(request, "DELETE");
    const reaction = decodeURIComponent(messageReactionDeleteMatch[3]);
    const mutation = await runMutationThroughConversationCoordinator(
      env,
      auth,
      messageReactionDeleteMatch[1],
      requestId,
      {
        operation: "message.reaction.delete",
        envelopeId: messageReactionDeleteMatch[2],
        body: { reaction },
      },
    );
    const message = requireCoordinatorResult(mutation.result);
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "message.reaction.delete",
      targetType: "message",
      targetId: messageReactionDeleteMatch[2],
      requestId,
      result: "success",
      metadata: { roomId: messageReactionDeleteMatch[1], reaction },
    });
    return json(
      { ok: true, message },
      { headers: mutationTimingHeaders("messageReactionDelete", mutation.metrics) },
    );
  }

  const messageReactionsMatch = routeParams(
    /^\/v1\/rooms\/([^/]+)\/messages\/([^/]+)\/reactions$/,
    url.pathname,
  );
  if (messageReactionsMatch) {
    requireMethod(request, "POST");
    const body = await readJsonObject(request);
    const mutation = await runMutationThroughConversationCoordinator(
      env,
      auth,
      messageReactionsMatch[1],
      requestId,
      {
        operation: "message.reaction.set",
        envelopeId: messageReactionsMatch[2],
        body,
      },
    );
    const message = requireCoordinatorResult(mutation.result);
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "message.reaction.set",
      targetType: "message",
      targetId: messageReactionsMatch[2],
      requestId,
      result: "success",
      metadata: { roomId: messageReactionsMatch[1], reaction: body.reaction },
    });
    return json(
      { ok: true, message },
      { headers: mutationTimingHeaders("messageReactionSet", mutation.metrics) },
    );
  }

  const messagePinMatch = routeParams(
    /^\/v1\/rooms\/([^/]+)\/messages\/([^/]+)\/pin$/,
    url.pathname,
  );
  if (messagePinMatch) {
    if (request.method !== "POST" && request.method !== "DELETE") requireMethod(request, "POST");
    const operation =
      request.method === "POST"
        ? "message.pin"
        : request.method === "DELETE"
          ? "message.unpin"
          : "message.pin";
    const mutation = await runMutationThroughConversationCoordinator(
      env,
      auth,
      messagePinMatch[1],
      requestId,
      {
        operation,
        envelopeId: messagePinMatch[2],
      },
    );
    const message = requireCoordinatorResult(mutation.result);
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: operation,
      targetType: "message",
      targetId: messagePinMatch[2],
      requestId,
      result: "success",
      metadata: { roomId: messagePinMatch[1] },
    });
    return json(
      { ok: true, message },
      {
        headers: mutationTimingHeaders(
          request.method === "POST" ? "messagePin" : "messageUnpin",
          mutation.metrics,
        ),
      },
    );
  }

  const editMessageMatch = routeParams(
    /^\/v1\/rooms\/([^/]+)\/messages\/([^/]+)$/,
    url.pathname,
  );
  if (editMessageMatch) {
    requireMethod(request, "PATCH");
    const mutation = await runMutationThroughConversationCoordinator(
      env,
      auth,
      editMessageMatch[1],
      requestId,
      {
        operation: "message.edit",
        envelopeId: editMessageMatch[2],
        body: await readJsonObject(request),
      },
    );
    const message = requireCoordinatorResult(mutation.result);
    await audit(env, {
      actorAccountId: auth.account.account_id,
      action: "message.edit",
      targetType: "message",
      targetId: editMessageMatch[2],
      requestId,
      result: "success",
      metadata: {
        roomId: editMessageMatch[1],
        sequence: message.serverSequence,
      },
    });
    return json(
      { ok: true, message },
      { headers: mutationTimingHeaders("messageEdit", mutation.metrics) },
    );
  }

  const ackMessageMatch = routeParams(
    /^\/v1\/rooms\/([^/]+)\/messages\/([^/]+)\/ack$/,
    url.pathname,
  );
  if (ackMessageMatch) {
    requireMethod(request, "POST");
    const receipt = await acknowledgeMessage(
      env,
      auth,
      ackMessageMatch[1],
      ackMessageMatch[2],
      await readJsonObject(request),
    );
    return json({ ok: true, receipt });
  }

  return null;
}
