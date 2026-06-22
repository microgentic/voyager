import type { Env } from "../../types";

export interface AttachmentObjectKeysRow {
  object_key: string;
  original_object_key: string | null;
  preview_object_key: string | null;
  thumbnail_object_key: string | null;
}

export async function attachmentObjectRows(
  env: Env,
  whereClause: string,
): Promise<AttachmentObjectKeysRow[]> {
  const rows = await env.CONTROL_DB.prepare(
    `SELECT object_key, original_object_key, preview_object_key, thumbnail_object_key
     FROM attachments
     WHERE ${whereClause}`,
  ).all<AttachmentObjectKeysRow>();
  return rows.results ?? [];
}

export function uniqueAttachmentObjectKeys(rows: AttachmentObjectKeysRow[]): string[] {
  return Array.from(
    new Set(
      rows.flatMap((row) => [
        row.object_key,
        row.original_object_key,
        row.preview_object_key,
        row.thumbnail_object_key,
      ]).filter((key): key is string => typeof key === "string" && key.length > 0),
    ),
  );
}
