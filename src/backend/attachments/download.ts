import { HttpError } from "../../http";
import type { AuthContext, Env } from "../../types";
import { requireRoomMembership } from "../rooms";
import { getAttachment } from "./ownership";
import type { AttachmentVariant } from "./types";
import {
  mimeForDownload,
  objectKeyForVariant,
  variantByteLength,
} from "./variants";

export async function downloadAttachmentBlob(
  env: Env,
  auth: AuthContext,
  attachmentId: string,
  variant: AttachmentVariant = "original",
): Promise<Response> {
  const attachment = await getAttachment(env, attachmentId);
  await requireRoomMembership(env, auth, attachment.room_id);
  if (!["uploaded", "referenced"].includes(attachment.state)) {
    throw new HttpError(
      404,
      "attachment_not_available",
      "Attachment is not available",
    );
  }
  const objectKey = objectKeyForVariant(attachment, variant);
  const object = await env.ATTACHMENTS_BUCKET.get(objectKey);
  if (!object) {
    throw new HttpError(
      404,
      "attachment_blob_missing",
      "Attachment blob is missing",
    );
  }
  return new Response(object.body, {
    headers: {
      "content-type": mimeForDownload(attachment, variant, object),
      "cache-control": "no-store",
      "x-attachment-id": attachment.attachment_id,
      "x-attachment-variant": variant,
      ...(variantByteLength(attachment, variant) !== null
        ? { "content-length": String(variantByteLength(attachment, variant)) }
        : {}),
    },
  });
}
