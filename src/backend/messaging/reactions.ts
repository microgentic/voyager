import { randomId } from "../../crypto";
import { HttpError, stringField } from "../../http";
import type { AuthContext, Env } from "../../types";
import type { JsonObject } from "../internal-types";
import { touchRoomVersionStatement } from "./helpers";
import { requireActiveMessageInteraction } from "./reads";
import { notifyMessageSync } from "./realtime";
import { getPublicMessage } from "./select";

export async function setMessageReaction(
  env: Env,
  auth: AuthContext,
  roomId: string,
  envelopeId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  await requireActiveMessageInteraction(env, auth, roomId, envelopeId);
  const reaction = normalizeReaction(
    stringField(body, "reaction", { required: true, min: 1, max: 32 })!,
  );
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `INSERT INTO message_reactions (
         reaction_id, envelope_id, room_id, account_id, principal_id, reaction
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(envelope_id, principal_id) DO UPDATE SET
         room_id = excluded.room_id,
         account_id = excluded.account_id,
         reaction = excluded.reaction,
         created_at = CURRENT_TIMESTAMP`,
    ).bind(
      randomId("react"),
      envelopeId,
      roomId,
      auth.account.account_id,
      auth.principal.principal_id,
      reaction,
    ),
    touchRoomVersionStatement(env, roomId),
  ]);
  await notifyMessageSync(env, auth, roomId, envelopeId);
  return getPublicMessage(
    env,
    envelopeId,
    auth.principal.principal_id,
    auth.account.account_id,
  );
}

export async function deleteMessageReaction(
  env: Env,
  auth: AuthContext,
  roomId: string,
  envelopeId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  await requireActiveMessageInteraction(env, auth, roomId, envelopeId);
  const reaction = normalizeReaction(
    stringField(body, "reaction", { required: true, min: 1, max: 32 })!,
  );
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      "DELETE FROM message_reactions WHERE envelope_id = ? AND principal_id = ? AND reaction = ?",
    ).bind(envelopeId, auth.principal.principal_id, reaction),
    touchRoomVersionStatement(env, roomId),
  ]);
  await notifyMessageSync(env, auth, roomId, envelopeId);
  return getPublicMessage(
    env,
    envelopeId,
    auth.principal.principal_id,
    auth.account.account_id,
  );
}

function normalizeReaction(reaction: string): string {
  if (/[\u0000-\u001f\u007f]/u.test(reaction)) {
    throw new HttpError(400, "invalid_reaction", "Reaction is invalid");
  }
  return reaction;
}
