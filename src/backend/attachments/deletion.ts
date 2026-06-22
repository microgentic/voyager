import { HttpError } from "../../http";
import type { AuthContext, Env } from "../../types";
import type { AttachmentRow } from "./types";
import { requireRoomMembership } from "../rooms";
import { runCounted } from "../utils";
import { getAttachment } from "./ownership";
import { uniqueObjectKeys } from "./variants";

export async function deleteAttachment(
  env: Env,
  auth: AuthContext,
  attachmentId: string,
): Promise<void> {
  const attachment = await getAttachment(env, attachmentId);
  const membership = await requireRoomMembership(env, auth, attachment.room_id);
  if (
    attachment.uploader_account_id !== auth.account.account_id &&
    !["owner", "admin"].includes(membership.role)
  ) {
    throw new HttpError(
      403,
      "forbidden",
      "Attachment deletion requires uploader or room admin",
    );
  }
  assertAttachmentDeletable(attachment);
  const deleted = await runCounted(
    env.CONTROL_DB.prepare(
      `UPDATE attachments
       SET state = 'deleted',
           deleted_at = CURRENT_TIMESTAMP
       WHERE attachment_id = ?
         AND state IN ('allocated', 'uploaded')`,
    ).bind(attachmentId),
  );
  if (deleted !== 1) {
    assertAttachmentDeletable(await getAttachment(env, attachmentId));
    throw new HttpError(
      409,
      "attachment_not_deletable",
      "Attachment is not deletable in its current state",
    );
  }
  const deletedAttachment = await getAttachment(env, attachmentId);
  await Promise.all(
    uniqueObjectKeys(deletedAttachment).map((objectKey) =>
      env.ATTACHMENTS_BUCKET.delete(objectKey),
    ),
  );
}

function assertAttachmentDeletable(attachment: AttachmentRow): void {
  if (attachment.state === "referenced") {
    throw new HttpError(
      409,
      "attachment_already_referenced",
      "Referenced attachments cannot be deleted directly",
    );
  }
  if (attachment.state !== "allocated" && attachment.state !== "uploaded") {
    throw new HttpError(
      409,
      "attachment_not_deletable",
      "Attachment is not deletable in its current state",
    );
  }
}
