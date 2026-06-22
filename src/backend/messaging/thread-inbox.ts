import { randomId } from "../../crypto";
import { HttpError } from "../../http";
import type { AuthContext, Env } from "../../types";
import type { RoomRow } from "../rooms/types";
import type { JsonObject } from "../shared/types";
import {
  messageSelectBindValues,
  messageSelectColumns,
} from "./select";
import {
  publicRoomsWithMembers,
  requireRoomMembership,
  roomSelectColumns,
} from "../rooms";
import { publicMessage } from "./serializers";
import { nextCursor, pageParams } from "../utils";

interface ThreadStateRow {
  thread_state_id: string;
  root_envelope_id: string;
  room_id: string;
  account_id: string;
  principal_id: string;
  following: number | null;
  muted: number;
  last_read_sequence: number;
  created_at: string;
  updated_at: string;
}

export async function listThreads(
  env: Env,
  auth: AuthContext,
  url?: URL,
): Promise<JsonObject> {
  const page = pageParams(url, { defaultLimit: 50, maxLimit: 100 });
  const rows = await env.CONTROL_DB.prepare(
    `SELECT ${messageSelectColumns("root")},
       CASE
         WHEN ts.following = 1 THEN 1
         WHEN ts.following = 0 THEN 0
         WHEN root.sender_account_id = ?
           OR EXISTS (
             SELECT 1
             FROM message_envelopes tr
             WHERE tr.thread_root_envelope_id = root.envelope_id
               AND tr.room_id = root.room_id
               AND tr.sender_account_id = ?
               AND tr.state != 'purged'
               AND tr.expires_at > CURRENT_TIMESTAMP
           )
           THEN 1
         ELSE 0
       END AS thread_following,
       COALESCE(ts.muted, 0) AS thread_muted,
       COALESCE(ts.last_read_sequence, 0) AS thread_last_read_sequence,
       (SELECT COUNT(*)
        FROM message_envelopes tr
        WHERE tr.thread_root_envelope_id = root.envelope_id
          AND tr.room_id = root.room_id
          AND tr.state != 'purged'
          AND tr.expires_at > CURRENT_TIMESTAMP
          AND tr.sender_account_id != ?
          AND tr.server_sequence > COALESCE(ts.last_read_sequence, 0)
          AND NOT EXISTS (
            SELECT 1
            FROM message_visibility mv
            WHERE mv.envelope_id = tr.envelope_id
              AND mv.account_id = ?
          )) AS thread_unread_count
     FROM message_envelopes root
     JOIN rooms r ON r.room_id = root.room_id
     JOIN room_memberships rm ON rm.room_id = root.room_id
     LEFT JOIN thread_states ts
       ON ts.root_envelope_id = root.envelope_id
      AND ts.account_id = ?
     WHERE rm.principal_id = ?
       AND rm.status = 'active'
       AND r.status != 'deleted'
       AND root.thread_root_envelope_id IS NULL
       AND root.state != 'purged'
       AND root.expires_at > CURRENT_TIMESTAMP
       AND NOT EXISTS (
         SELECT 1
         FROM message_visibility mv
         WHERE mv.envelope_id = root.envelope_id
           AND mv.account_id = ?
       )
       AND EXISTS (
         SELECT 1
         FROM message_envelopes tr
         WHERE tr.thread_root_envelope_id = root.envelope_id
           AND tr.room_id = root.room_id
           AND tr.state != 'purged'
           AND tr.expires_at > CURRENT_TIMESTAMP
           AND NOT EXISTS (
             SELECT 1
             FROM message_visibility mv
             WHERE mv.envelope_id = tr.envelope_id
               AND mv.account_id = ?
           )
       )
       AND (
         ts.following = 1
         OR (
           (ts.thread_state_id IS NULL OR ts.following IS NULL)
           AND (
             root.sender_account_id = ?
             OR EXISTS (
               SELECT 1
               FROM message_envelopes tr
               WHERE tr.thread_root_envelope_id = root.envelope_id
                 AND tr.room_id = root.room_id
                 AND tr.sender_account_id = ?
                 AND tr.state != 'purged'
                 AND tr.expires_at > CURRENT_TIMESTAMP
             )
           )
         )
       )
     ORDER BY thread_last_reply_at DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(
      ...messageSelectBindValues(auth),
      auth.account.account_id,
      auth.account.account_id,
      auth.account.account_id,
      auth.account.account_id,
      auth.account.account_id,
      auth.principal.principal_id,
      auth.account.account_id,
      auth.account.account_id,
      auth.account.account_id,
      auth.account.account_id,
      page.limit,
      page.offset,
    )
    .all<Record<string, unknown>>();

  const roots = rows.results ?? [];
  const rooms = await roomsForThreadRows(env, roots);
  const items = roots.flatMap((row) => {
    const room = rooms.get(String(row.room_id));
    if (!room) return [];
    return [
      {
        room,
        root: publicMessage(row),
        following: Boolean(row.thread_following),
        muted: Boolean(row.thread_muted),
        unreadCount: Number(row.thread_unread_count ?? 0),
        lastReadSequence: Number(row.thread_last_read_sequence ?? 0),
        updatedAt: row.thread_last_reply_at ?? row.server_received_at,
      },
    ];
  });
  return { items, nextCursor: nextCursor(items.length, page) };
}

export async function markThreadRead(
  env: Env,
  auth: AuthContext,
  roomId: string,
  rootEnvelopeId: string,
): Promise<JsonObject> {
  await assertVisibleThreadRoot(env, auth, roomId, rootEnvelopeId);
  const row = await env.CONTROL_DB.prepare(
    `SELECT COALESCE(MAX(server_sequence), 0) AS max_sequence
     FROM message_envelopes tr
     WHERE tr.thread_root_envelope_id = ?
       AND tr.room_id = ?
       AND tr.state != 'purged'
       AND tr.expires_at > CURRENT_TIMESTAMP
       AND NOT EXISTS (
         SELECT 1
         FROM message_visibility mv
         WHERE mv.envelope_id = tr.envelope_id
           AND mv.account_id = ?
       )`,
  )
    .bind(rootEnvelopeId, roomId, auth.account.account_id)
    .first<{ max_sequence: number }>();
  const maxSequence = Number(row?.max_sequence ?? 0);
  const existing = await getThreadState(env, auth, rootEnvelopeId);
  return publicThreadState(
    await upsertThreadState(env, auth, roomId, rootEnvelopeId, {
      following: existing?.following ?? null,
      muted: existing ? Boolean(existing.muted) : false,
      lastReadSequence: maxSequence,
    }),
  );
}

export async function updateThreadSubscription(
  env: Env,
  auth: AuthContext,
  roomId: string,
  rootEnvelopeId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  await assertVisibleThreadRoot(env, auth, roomId, rootEnvelopeId);
  const following = optionalBoolean(body.following, "following");
  const muted = optionalBoolean(body.muted, "muted");
  if (following === null && muted === null) {
    throw new HttpError(
      400,
      "missing_field",
      "At least one thread subscription field is required",
    );
  }
  const existing = await getThreadState(env, auth, rootEnvelopeId);
  return publicThreadState(
    await upsertThreadState(env, auth, roomId, rootEnvelopeId, {
      following: following ?? existing?.following ?? null,
      muted: muted ?? (existing ? Boolean(existing.muted) : false),
      lastReadSequence: existing?.last_read_sequence ?? 0,
    }),
  );
}

async function assertVisibleThreadRoot(
  env: Env,
  auth: AuthContext,
  roomId: string,
  rootEnvelopeId: string,
): Promise<void> {
  await requireRoomMembership(env, auth, roomId);
  const root = await env.CONTROL_DB.prepare(
    `SELECT envelope_id
     FROM message_envelopes root
     WHERE root.envelope_id = ?
       AND root.room_id = ?
       AND root.thread_root_envelope_id IS NULL
       AND root.state != 'purged'
       AND root.expires_at > CURRENT_TIMESTAMP
       AND NOT EXISTS (
         SELECT 1
         FROM message_visibility mv
         WHERE mv.envelope_id = root.envelope_id
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

async function getThreadState(
  env: Env,
  auth: AuthContext,
  rootEnvelopeId: string,
): Promise<ThreadStateRow | null> {
  return (
    (await env.CONTROL_DB.prepare(
      `SELECT *
       FROM thread_states
       WHERE root_envelope_id = ?
         AND account_id = ?`,
    )
      .bind(rootEnvelopeId, auth.account.account_id)
      .first<ThreadStateRow>()) ?? null
  );
}

async function upsertThreadState(
  env: Env,
  auth: AuthContext,
  roomId: string,
  rootEnvelopeId: string,
  input: {
    following?: boolean | number | null;
    muted?: boolean;
    lastReadSequence?: number;
  },
): Promise<ThreadStateRow> {
  const following =
    input.following === null || input.following === undefined
      ? null
      : input.following === false || input.following === 0
        ? 0
        : 1;
  const muted = input.muted === true ? 1 : 0;
  const lastReadSequence = Math.max(0, Math.floor(input.lastReadSequence ?? 0));
  const state = await env.CONTROL_DB.prepare(
    `INSERT INTO thread_states (
       thread_state_id, root_envelope_id, room_id, account_id, principal_id,
       following, muted, last_read_sequence
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(root_envelope_id, account_id) DO UPDATE SET
       room_id = excluded.room_id,
       principal_id = excluded.principal_id,
       following = excluded.following,
       muted = excluded.muted,
       last_read_sequence = MAX(thread_states.last_read_sequence, excluded.last_read_sequence),
       updated_at = CURRENT_TIMESTAMP
     RETURNING *`,
  )
    .bind(
      randomId("tstate"),
      rootEnvelopeId,
      roomId,
      auth.account.account_id,
      auth.principal.principal_id,
      following,
      muted,
      lastReadSequence,
    )
    .first<ThreadStateRow>();
  if (!state) {
    throw new HttpError(
      500,
      "thread_state_failed",
      "Thread state could not be updated",
    );
  }
  return state;
}

async function roomsForThreadRows(
  env: Env,
  rows: Record<string, unknown>[],
): Promise<Map<string, JsonObject>> {
  const roomIds = Array.from(new Set(rows.map((row) => String(row.room_id))));
  if (!roomIds.length) return new Map();
  const placeholders = roomIds.map(() => "?").join(", ");
  const result = await env.CONTROL_DB.prepare(
    `SELECT ${roomSelectColumns("r")}
     FROM rooms r
     WHERE r.room_id IN (${placeholders})`,
  )
    .bind(...roomIds)
    .all<RoomRow>();
  const rooms = await publicRoomsWithMembers(env, result.results ?? []);
  return new Map(rooms.map((room) => [String(room.roomId), room]));
}

function optionalBoolean(value: unknown, key: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") {
    throw new HttpError(
      400,
      "invalid_field",
      `Field must be a boolean: ${key}`,
    );
  }
  return value;
}

function publicThreadState(row: ThreadStateRow): JsonObject {
  return {
    rootEnvelopeId: row.root_envelope_id,
    roomId: row.room_id,
    following: Boolean(row.following),
    muted: Boolean(row.muted),
    lastReadSequence: Number(row.last_read_sequence ?? 0),
    updatedAt: row.updated_at,
  };
}
