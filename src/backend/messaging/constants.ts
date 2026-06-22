export const DELETE_FOR_EVERYONE_WINDOW_MS = 48 * 60 * 60 * 1000;
export const DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const MAX_ATTACHMENTS_PER_MESSAGE_HARD_LIMIT = 20;

export const ALLOWED_PROTOCOL_TYPES = new Set([
  "opaque-test",
  "mls_application",
  "mls_commit",
  "mls_proposal",
  "mls_welcome",
]);
