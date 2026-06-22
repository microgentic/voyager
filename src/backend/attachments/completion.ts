import { HttpError, stringField } from "../../http";
import type { AuthContext, Env } from "../../types";
import type { JsonObject } from "../internal-types";
import { getPolicy } from "../rooms";
import { publicAttachment } from "../serializers";
import { optionalJsonText, optionalNumberField, runCounted } from "../utils";
import {
  DEFAULT_MAX_IMAGE_DIMENSION,
  MAX_FILENAME_LENGTH,
  MAX_MIME_LENGTH,
  MAX_VARIANT_MANIFEST_BYTES,
} from "./types";
import { getAttachment, ensureAttachmentUploader } from "./ownership";
import { positivePolicyLimit } from "./quotas";
import { parseMediaKind } from "./variants";

export async function completeAttachment(
  env: Env,
  auth: AuthContext,
  attachmentId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  const attachment = await getAttachment(env, attachmentId);
  ensureAttachmentUploader(auth, attachment);
  if (attachment.state === "referenced") {
    throw new HttpError(
      409,
      "attachment_already_referenced",
      "Referenced attachments cannot be completed again",
    );
  }
  if (attachment.state !== "uploaded") {
    throw new HttpError(
      409,
      "attachment_not_uploaded",
      "Attachment has not been uploaded",
    );
  }
  if (!attachment.original_object_key || attachment.original_bytes === null) {
    throw new HttpError(
      409,
      "attachment_original_required",
      "Attachment original variant must be uploaded before completion",
    );
  }
  const mediaKind = stringField(body, "mediaKind", { max: 20 });
  const policy = await getPolicy(env, auth.account.policy_id);
  const maxImageDimension = positivePolicyLimit(
    policy.maximum_image_dimension,
    DEFAULT_MAX_IMAGE_DIMENSION,
  );
  const width = optionalNumberField(body, "width", 1, maxImageDimension);
  const height = optionalNumberField(body, "height", 1, maxImageDimension);
  const completed = await runCounted(
    env.CONTROL_DB.prepare(
      `UPDATE attachments
       SET ciphertext_sha256 = COALESCE(?, ciphertext_sha256),
           ciphertext_bytes = COALESCE(?, ciphertext_bytes),
           original_filename = COALESCE(?, original_filename),
           declared_mime_type = COALESCE(?, declared_mime_type),
           media_kind = COALESCE(?, media_kind),
           width = COALESCE(?, width),
           height = COALESCE(?, height),
           duration_ms = COALESCE(?, duration_ms),
           variant_manifest_json = COALESCE(?, variant_manifest_json)
       WHERE attachment_id = ?
         AND state = 'uploaded'`,
    )
      .bind(
        stringField(body, "ciphertextSha256", { max: 128 }) ?? null,
        optionalNumberField(
          body,
          "ciphertextBytes",
          1,
          attachment.expected_bytes,
        ) ?? null,
        stringField(body, "originalFilename", {
          max: MAX_FILENAME_LENGTH,
        }) ?? null,
        stringField(body, "declaredMimeType", { max: MAX_MIME_LENGTH }) ?? null,
        mediaKind ? parseMediaKind(mediaKind) : null,
        width,
        height,
        optionalNumberField(body, "durationMs", 1, 24 * 60 * 60 * 1000),
        optionalJsonText(body, "variantManifest", MAX_VARIANT_MANIFEST_BYTES),
        attachmentId,
      ),
  );
  if (completed !== 1) {
    const current = await getAttachment(env, attachmentId);
    if (current.state === "referenced") {
      throw new HttpError(
        409,
        "attachment_already_referenced",
        "Referenced attachments cannot be completed again",
      );
    }
    throw new HttpError(
      409,
      "attachment_not_uploaded",
      "Attachment has not been uploaded",
    );
  }
  return publicAttachment(await getAttachment(env, attachmentId));
}
