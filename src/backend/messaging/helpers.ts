import { HttpError } from "../../http";
import type { Env } from "../../types";
import { ALLOWED_PROTOCOL_TYPES } from "./constants";

export function assertAllowedProtocolType(protocolType: string): void {
  if (!ALLOWED_PROTOCOL_TYPES.has(protocolType)) {
    throw new HttpError(
      400,
      "invalid_protocol_type",
      "Protocol type is not allowed",
    );
  }
}

export function touchRoomVersionStatement(
  env: Env,
  roomId: string,
): D1PreparedStatement {
  return env.CONTROL_DB.prepare(
    "UPDATE rooms SET version = version + 1 WHERE room_id = ?",
  ).bind(roomId);
}
