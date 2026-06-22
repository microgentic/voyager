# Attachment UX Manual QA

Use this checklist with the automated check suite for attachment UX changes.

## Image Optimization And Originals

- Send a large image with `Send original images` off.
  - Timeline shows a thumbnail without downloading the source-size file.
  - Viewer opens the preview-sized image.
  - Download retrieves the optimized original variant.
- Send the same image with `Send original images` on.
  - Pending card reports the source-inclusive state.
  - Timeline still shows the thumbnail.
  - Viewer still opens the preview-sized image.
  - Download retrieves the selected source image as the `original` variant.

## Multi-Image Viewer

- Send at least three images in one message.
  - Message renders as a compact image grid.
  - Opening any image starts the viewer at that image.
  - Previous/next buttons navigate inside only that message's images.
  - Arrow keys navigate while the viewer is open.
  - Horizontal swipe/pointer drag changes images on touch-capable devices.

## Generic Files And Media

- Send a generic file such as PDF, ZIP, TXT, or CSV.
  - Message renders a file card with filename and size.
  - Clicking downloads the file after authenticated fetch.
- Send a video file.
  - Card identifies it as video and shows duration/dimensions when available.
  - Clicking opens a controls-based video viewer.
  - Download retrieves the original file.
- Send an audio file.
  - Card identifies it as audio and shows duration when available.
  - Clicking opens a controls-based audio viewer.
  - Download retrieves the original file.

## Lifecycle And Cross-Surface Behavior

- Send an image/file in a thread reply.
  - Thread timeline renders and opens/downloads the attachment.
  - Also-send-to-room keeps the same visible attachment behavior in the main room.
- Forward a visible attachment message to another room.
  - Forwarded message can view/download attachments in the target room.
  - Failed forward cleanup does not leave visible cloned attachments.
- Delete a message for everyone.
  - Timeline shows the tombstone and no longer renders attachment content.
- Delete a message for me.
  - Local timeline hides the message without deleting shared attachment blobs for other participants.

## Performance And Cleanup

- Scroll quickly through a room with many image messages.
  - Timeline thumbnails lazy-load as they approach the viewport.
  - Attachment preview/download requests remain bounded rather than flooding the network.
- Open and close image/media viewers repeatedly.
  - Object URLs are revoked when attachment components unmount.
  - Browser memory does not grow steadily after navigating away from the room.
