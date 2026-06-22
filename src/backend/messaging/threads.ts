import { HttpError } from "../../http";
import type { AuthContext, Env } from "../../types";
import type { JsonObject } from "../internal-types";
import { requireRoomMembership } from "../rooms";
import { publicMessage } from "../serializers";
import { numberParam } from "../utils";
import {
  getPublicMessage,
  messageSelectBindValues,
  messageSelectColumns,
} from "./select";
export {
  listThreads,
  markThreadRead,
  updateThreadSubscription,
} from "./thread-inbox";

// A thread is a sub-timeline anchored on a root envelope in the same room. The
// root may be a tombstone (deleted-for-everyone) yet still anchor existing
// replies, matching Slack's behavior of keeping replies readable.
export async function getThread(
  env: Env,
  auth: AuthContext,
  roomId: string,
  rootEnvelopeId: string,
  url: URL,
): Promise<JsonObject> {
  await requireRoomMembership(env, auth, roomId);
  const limit = numberParam(url, "limit", 1, 200, 200);
  const hasAfter = url.searchParams.has("after");
  const hasBefore = url.searchParams.has("before");
  const after = hasAfter
    ? numberParam(url, "after", 0, Number.MAX_SAFE_INTEGER, 0)
    : 0;
  const before = hasBefore
    ? numberParam(url, "before", 1, Number.MAX_SAFE_INTEGER, 1)
    : null;
  const root = await env.CONTROL_DB.prepare(
    `SELECT ${messageSelectColumns("me")}
     FROM message_envelopes me
     WHERE me.envelope_id = ?
       AND me.room_id = ?
       AND me.state != 'purged'
       AND me.thread_root_envelope_id IS NULL
       AND me.expires_at > CURRENT_TIMESTAMP
       AND NOT EXISTS (
         SELECT 1
         FROM message_visibility mv
         WHERE mv.envelope_id = me.envelope_id
           AND mv.account_id = ?
       )`,
  )
    .bind(
      ...messageSelectBindValues(auth),
      rootEnvelopeId,
      roomId,
      auth.account.account_id,
    )
    .first<Record<string, unknown>>();
  if (!root) {
    throw new HttpError(
      404,
      "thread_root_not_found",
      "Thread root message is not available",
    );
  }
  const sequenceOperator = before !== null ? "<" : ">";
  const sequenceCursor = before !== null ? before : after;
  const orderDirection = hasAfter && before === null ? "ASC" : "DESC";
  const repliesResult = await env.CONTROL_DB.prepare(
    `SELECT ${messageSelectColumns("me")}
     FROM message_envelopes me
     WHERE me.thread_root_envelope_id = ?
       AND me.room_id = ?
       AND me.server_sequence ${sequenceOperator} ?
       AND me.state != 'purged'
       AND me.expires_at > CURRENT_TIMESTAMP
       AND NOT EXISTS (
         SELECT 1
         FROM message_visibility mv
         WHERE mv.envelope_id = me.envelope_id
           AND mv.account_id = ?
       )
     ORDER BY me.server_sequence ${orderDirection}
     LIMIT ?`,
  )
    .bind(
      ...messageSelectBindValues(auth),
      rootEnvelopeId,
      roomId,
      sequenceCursor,
      auth.account.account_id,
      limit + 1,
    )
    .all<Record<string, unknown>>();
  const rawReplies = repliesResult.results ?? [];
  const hasMoreBefore =
    (before !== null || !hasAfter) && rawReplies.length > limit;
  const pageReplies = rawReplies.slice(0, limit);
  const replies =
    orderDirection === "DESC" ? [...pageReplies].reverse() : pageReplies;
  const olderCursor = hasMoreBefore
    ? String(
        replies.reduce(
          (min, reply) => Math.min(min, Number(reply.server_sequence)),
          Number.MAX_SAFE_INTEGER,
        ),
      )
    : null;
  return {
    root: publicMessage(root),
    replies: replies.map(publicMessage),
    olderCursor,
  };
}

// A new thread reply is only allowed against an active, visible, non-tombstoned
// root in the same room. Roots must themselves be top-level messages, keeping
// threads one level deep like Slack. Tombstoned roots reject new replies while
// the thread endpoint still returns existing ones.
export async function assertThreadRootEligible(
  env: Env,
  auth: AuthContext,
  roomId: string,
  rootEnvelopeId: string,
): Promise<void> {
  const root = await env.CONTROL_DB.prepare(
    `SELECT me.envelope_id
     FROM message_envelopes me
     WHERE me.envelope_id = ?
       AND me.room_id = ?
       AND me.state NOT IN ('expired', 'purged')
       AND me.deleted_for_everyone_at IS NULL
       AND me.thread_root_envelope_id IS NULL
       AND me.expires_at > CURRENT_TIMESTAMP
       AND NOT EXISTS (
         SELECT 1
         FROM message_visibility mv
         WHERE mv.envelope_id = me.envelope_id
           AND mv.account_id = ?
       )`,
  )
    .bind(rootEnvelopeId, roomId, auth.account.account_id)
    .first<Record<string, unknown>>();
  if (!root) {
    throw new HttpError(
      404,
      "thread_root_not_found",
      "Thread root message is not available",
    );
  }
}
