import { randomId } from "../../crypto";
import { stringField } from "../../http";
import type { AuthContext, Env } from "../../types";
import {
  DEFAULT_ATTACHMENT_DAYS,
  type JsonObject,
} from "../internal-types";
import { getPolicy, requireRoomMembership } from "../rooms";
import {
  numberField,
  optionalJsonText,
  optionalNumberField,
  sqliteTimestamp,
} from "../utils";
import { publicAttachment } from "../serializers";
import {
  DEFAULT_MAX_IMAGE_DIMENSION,
  MAX_FILENAME_LENGTH,
  MAX_MIME_LENGTH,
  MAX_VARIANT_MANIFEST_BYTES,
} from "./types";
import {
  assertAttachmentDailyQuota,
  assertPendingAttachmentCap,
  DEFAULT_DAILY_ATTACHMENT_BYTES_PER_ACCOUNT,
  DEFAULT_DAILY_ATTACHMENT_BYTES_PER_ROOM,
  positivePolicyLimit,
} from "./quotas";
import { getAttachment } from "./ownership";
import { parseMediaKind } from "./variants";

export async function allocateAttachment(
  env: Env,
  auth: AuthContext,
  roomId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  await requireRoomMembership(env, auth, roomId);
  const policy = await getPolicy(env, auth.account.policy_id);
  await assertPendingAttachmentCap(env, auth.device.device_id);
  const expectedBytes = numberField(
    body,
    "expectedBytes",
    1,
    policy.maximum_attachment_bytes,
  );
  await assertAttachmentDailyQuota(env, {
    accountId: auth.account.account_id,
    roomId,
    expectedBytes,
    accountLimit: positivePolicyLimit(
      policy.daily_attachment_bytes_per_account,
      DEFAULT_DAILY_ATTACHMENT_BYTES_PER_ACCOUNT,
    ),
    roomLimit: positivePolicyLimit(
      policy.daily_attachment_bytes_per_room,
      DEFAULT_DAILY_ATTACHMENT_BYTES_PER_ROOM,
    ),
  });
  const attachmentId = randomId("att");
  const objectKey = `attachments/${roomId}/${attachmentId}/original`;
  const expiresAt = sqliteTimestamp(
    Date.now() + DEFAULT_ATTACHMENT_DAYS * 24 * 60 * 60 * 1000,
  );
  const mediaKind = parseMediaKind(
    stringField(body, "mediaKind", { max: 20 }) ?? "unknown",
  );
  const maxImageDimension = positivePolicyLimit(
    policy.maximum_image_dimension,
    DEFAULT_MAX_IMAGE_DIMENSION,
  );
  const width = optionalNumberField(body, "width", 1, maxImageDimension);
  const height = optionalNumberField(body, "height", 1, maxImageDimension);
  await env.CONTROL_DB.prepare(
    `INSERT INTO attachments (
      attachment_id, room_id, uploader_account_id, uploader_principal_id, uploader_device_id,
      object_key, state, expected_bytes, content_category, retention_class,
      original_filename, declared_mime_type, media_kind, width, height, duration_ms,
      original_object_key, variant_manifest_json, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'allocated', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      attachmentId,
      roomId,
      auth.account.account_id,
      auth.principal.principal_id,
      auth.device.device_id,
      objectKey,
      expectedBytes,
      stringField(body, "contentCategory", { max: 80 }) ?? "opaque",
      stringField(body, "retentionClass", { max: 40 }) ?? "default",
      stringField(body, "originalFilename", {
        max: MAX_FILENAME_LENGTH,
      }) ?? null,
      stringField(body, "declaredMimeType", { max: MAX_MIME_LENGTH }) ?? null,
      mediaKind,
      width,
      height,
      optionalNumberField(body, "durationMs", 1, 24 * 60 * 60 * 1000),
      objectKey,
      optionalJsonText(body, "variantManifest", MAX_VARIANT_MANIFEST_BYTES),
      expiresAt,
    )
    .run();
  return publicAttachment(await getAttachment(env, attachmentId));
}
