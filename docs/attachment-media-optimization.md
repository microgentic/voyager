# Attachment Media Optimization

PR 1 of the media/calling roadmap adds the backend foundation for optimized attachments. The goal is to let clients upload multiple private variants of the same attachment while keeping D1 as metadata/state and R2 as private object storage.

## Current Scope

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

## Security Boundary

The backend still treats attachment bytes as opaque. It records client-supplied metadata and byte counts, but it does not inspect, transform, or verify image/video plaintext. This keeps the implementation compatible with future client-side encryption work.

R2 buckets must remain private. Voyager uses authenticated Worker downloads for all variants; public buckets and long-lived public media URLs are intentionally out of scope.

## Variant Model

Each attachment has one durable row and up to three object variants:

| Variant | Purpose |
| --- | --- |
| `original` | Backward-compatible full attachment blob. |
| `preview` | Optimized viewer/timeline media for images or videos. |
| `thumbnail` | Small timeline or grid preview. |

Clients should prefer `thumbnail` in dense timelines, `preview` in viewers, and `original` only for explicit download or "send original" flows.

## Deferred To PR 2

- Client-side image resizing/compression.
- Thumbnail rendering in chat bubbles.
- Media viewer/lightbox.
- Upload progress, cancel, and retry UI.
- Drag-and-drop and mobile picker polish.
- More nuanced cleanup for uploaded-but-never-referenced variants before their normal expiration window.

## Future Notes

- Direct-to-R2 multipart uploads remain deferred until large file/video uploads need resumable transfer.
- Cloudflare Images or signed media URLs remain deferred until the access-control and leakage model is designed.
- This PR does not claim end-to-end encrypted attachments; it preserves the backend abstraction needed for that later work.
