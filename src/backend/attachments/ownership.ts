import { HttpError } from "../../http";
import type { AuthContext, Env } from "../../types";
import type { AttachmentRow } from "./types";

export async function getAttachment(
  env: Env,
  attachmentId: string,
): Promise<AttachmentRow> {
  const attachment = await env.CONTROL_DB.prepare(
    "SELECT * FROM attachments WHERE attachment_id = ?",
  )
    .bind(attachmentId)
    .first<AttachmentRow>();
  if (!attachment)
    throw new HttpError(404, "attachment_not_found", "Attachment not found");
  return attachment;
}

export function ensureAttachmentUploader(
  auth: AuthContext,
  attachment: AttachmentRow,
): void {
  if (
    attachment.uploader_account_id !== auth.account.account_id ||
    attachment.uploader_device_id !== auth.device.device_id
  ) {
    throw new HttpError(
      403,
      "attachment_uploader_required",
      "Only the allocating device can upload or complete this attachment",
    );
  }
}
