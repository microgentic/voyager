import { HttpError } from "../../http";
import type { Env } from "../../types";
import { MAX_PENDING_ATTACHMENTS_PER_DEVICE } from "./types";

export const DEFAULT_DAILY_ATTACHMENT_BYTES_PER_ACCOUNT = 100 * 1024 * 1024;
export const DEFAULT_DAILY_ATTACHMENT_BYTES_PER_ROOM = 500 * 1024 * 1024;

export async function assertPendingAttachmentCap(
  env: Env,
  deviceId: string,
): Promise<void> {
  const pending = await env.CONTROL_DB.prepare(
    `SELECT COUNT(*) AS count
     FROM attachments
     WHERE uploader_device_id = ?
       AND state IN ('allocated', 'uploaded')
       AND expires_at > CURRENT_TIMESTAMP`,
  )
    .bind(deviceId)
    .first<{ count: number }>();
  if (Number(pending?.count ?? 0) >= MAX_PENDING_ATTACHMENTS_PER_DEVICE) {
    throw new HttpError(
      429,
      "too_many_pending_attachments",
      "Too many pending attachments for this device",
    );
  }
}

export async function assertAttachmentDailyQuota(
  env: Env,
  input: {
    accountId: string;
    roomId: string;
    expectedBytes: number;
    accountLimit: number;
    roomLimit: number;
  },
): Promise<void> {
  const [accountBytes, roomBytes] = await Promise.all([
    dailyAttachmentExpectedBytes(env, "uploader_account_id", input.accountId),
    dailyAttachmentExpectedBytes(env, "room_id", input.roomId),
  ]);
  if (accountBytes + input.expectedBytes > input.accountLimit) {
    throw new HttpError(
      429,
      "attachment_account_daily_quota_exceeded",
      "Daily attachment byte quota exceeded for this account",
    );
  }
  if (roomBytes + input.expectedBytes > input.roomLimit) {
    throw new HttpError(
      429,
      "attachment_room_daily_quota_exceeded",
      "Daily attachment byte quota exceeded for this room",
    );
  }
}

async function dailyAttachmentExpectedBytes(
  env: Env,
  column: "uploader_account_id" | "room_id",
  value: string,
): Promise<number> {
  const row = await env.CONTROL_DB.prepare(
    `SELECT COALESCE(SUM(expected_bytes), 0) AS bytes
     FROM attachments
     WHERE ${column} = ?
       AND created_at >= datetime('now', '-1 day')
       AND state != 'quarantined_metadata'`,
  )
    .bind(value)
    .first<{ bytes: number }>();
  return Number(row?.bytes ?? 0);
}

export function positivePolicyLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}
