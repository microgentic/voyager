# Attachment Media Optimization

PR 1 of the media/calling roadmap added the backend foundation for optimized attachments. PR 2 wires that contract into the client experience. The goal is to let clients upload multiple private variants of the same attachment while keeping D1 as metadata/state and R2 as private object storage.

## Backend Scope

- Attachment allocation accepts media metadata: `mediaKind`, `originalFilename`, `declaredMimeType`, `width`, `height`, `durationMs`, and an opaque `variantManifest`.
- `PUT /v1/attachments/{attachmentId}/blob` still uploads the original variant for compatibility.
- `PUT /v1/attachments/{attachmentId}/blob?variant=preview` and `?variant=thumbnail` upload additional private R2 objects.
- `GET /v1/attachments/{attachmentId}/blob?variant=...` downloads the requested variant after normal room membership authorization.
- Uploads stream request bodies to R2 when `Content-Length` is available; the fallback path still buffers to preserve compatibility with clients that cannot provide a length.
- `expectedBytes` is a total attachment budget across all variants. Replacing a variant subtracts the previous byte count before applying the new one.
- Preview or thumbnail uploads do not make an attachment sendable. The primary `original` variant must be uploaded before completion or message reference.
- Deleting an attachment deletes all known variant objects.
- Allocation enforces a small pending-attachment cap per device to prevent unbounded abandoned allocations.
- Maintenance cleanup deletes known variant objects for expired attachments before marking those rows expired.

## Client Scope

- The composer generates optimized image variants locally with browser-native image APIs before upload.
- Static images default to an optimized primary `original`, optional `preview`, and `thumbnail`; unsupported images and generic files fall back to the opaque original-only path.
- The composer shows staged upload progress, local pending thumbnails, cancel, retry, and cleanup of unsent attachment allocations.
- Web/desktop users can drag files into the composer drop target; mobile continues to use the platform file picker exposed through the same file input.
- Chat bubbles load `thumbnail` first for image timelines and open a private authenticated viewer that prefers `preview` and falls back to `original`.
- Generic files render as downloadable file cards.
- Thread replies use the same composer path, so image/file attachments work in threads.
- Message attachment references include per-variant MIME metadata so the viewer and forwarding path do not assume all variants share the same content type.
- Forwarding a visible attachment message clones the attachment variants into the target room before calling the existing forward endpoint, preserving room-local attachment ownership and cleaning up cloned rows if the final forward request fails.
- Delete-for-me hides the message locally without deleting shared blobs; delete-for-everyone tombstones the message display so attachment content is no longer rendered from that message context.

## Security Boundary

The backend still treats attachment bytes as opaque. It records client-supplied metadata and byte counts, but it does not inspect, transform, or verify image/video plaintext. This keeps the implementation compatible with future client-side encryption work.

Client-side image optimization currently happens before the future MLS/native attachment encryption layer. Once encrypted attachments land, each variant should be encrypted independently before upload while preserving the same metadata and variant-selection shape.

R2 buckets must remain private. Voyager uses authenticated Worker downloads for all variants; public buckets and long-lived public media URLs are intentionally out of scope.

## Variant Model

Each attachment has one durable row and up to three object variants:

| Variant | Purpose |
| --- | --- |
| `original` | Backward-compatible full attachment blob. |
| `preview` | Optimized viewer/timeline media for images or videos. |
| `thumbnail` | Small timeline or grid preview. |

Clients should prefer `thumbnail` in dense timelines, `preview` in viewers, and `original` only for explicit download or "send original" flows.

## Future Notes

- Direct-to-R2 multipart uploads remain deferred until large file/video uploads need resumable transfer.
- Cloudflare Images or signed media URLs remain deferred until the access-control and leakage model is designed.
- This PR does not claim end-to-end encrypted attachments; it preserves the backend abstraction needed for that later work.
- A dedicated "send original camera/source file" option remains deferred. The current default sends an optimized primary image as the required `original` variant.
- Fine-grained upload byte progress remains deferred because the current authenticated Worker upload path uses `fetch`; the composer reports deterministic processing/upload stages instead.
- Full camera capture polish and platform-specific save-to-gallery affordances remain part of later mobile hardening.
