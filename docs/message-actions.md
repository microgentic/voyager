# Message Actions, Status, Reply, Edit, Reactions, Pinning, Forwarding, Search, And Deletion

These PRs add the first Telegram-style message action layer without changing the
message-send, realtime, or sync source-of-truth model.

## Implemented

- Incoming and outgoing message alignment remains the messenger convention:
  incoming messages are left aligned; current-user outgoing messages are right
  aligned.
- Message actions open from desktop/web right-click and touch long-press.
- The initial action menu includes:
  - Quick reactions;
  - Reply;
  - Copy;
  - Select;
  - Edit for sent current-user messages;
  - Forward for displayable sent messages;
  - Pin or unpin where the current member has permission;
  - Retry send for failed local outgoing messages;
  - Message info;
  - Delete for everyone where sender/admin rules allow it;
  - Delete for me.
- Multi-select mode supports:
  - selected count;
  - Copy;
  - Forward for a single selected displayable message;
  - Select all;
  - Delete for everyone where all selected messages are eligible;
  - Delete for me;
  - Cancel.
- In-room search is client-side over decoded visible messages and sender names.
  The backend does not index or inspect plaintext message content.
- Delete-for-me is backend-backed:
  - the backend writes per-account visibility rows;
  - matching pending delivery receipts for that account are marked `stored` so
    hidden messages do not remain in the pending delivery queue;
  - message envelopes remain durable D1 history;
  - other room members still see the message;
  - the deleting account no longer receives the hidden envelopes from room
    history, `/v1/sync`, or `/v1/app/bootstrap`.
- Message status uses `receiptSummary.status`:
  - `sent` renders one check;
  - `delivered` renders two checks;
  - `read` renders the highlighted two-check read state once at least one
    recipient device has read the message.
  The per-device receipt counts remain in the API for diagnostics.
- Reply composer UI uses the existing `replyToMessageId` payload field.
- Message edits are backend-backed:
  - only the original sender principal may edit;
  - the active envelope keeps the same `envelopeId` and `serverSequence`;
  - the previous opaque payload is preserved in `message_edits`;
  - room realtime sends a sync hint so other clients refresh the edited
    envelope.
- Reactions are backend-backed message metadata:
  - each principal has one active reaction per message;
  - posting a different reaction replaces the principal's previous reaction;
  - reaction summaries are returned on message envelopes;
  - `reactedByMe` is viewer-specific, while `count` is room-wide;
  - reaction changes emit a room sync hint for the affected envelope.
- Pins are backend-backed room/message metadata:
  - direct room participants can pin and unpin;
  - group and channel pins require owner/admin permissions;
  - message envelopes include a pin summary;
  - room envelopes include `pinnedMessageCount` and `latestPinnedMessageId`.
- Forwarding is backend-backed source metadata with client-mediated content:
  - the backend validates the source message is visible to the forwarding
    account and not deleted-for-everyone;
  - the client re-encodes the displayable content for the target room;
  - forward provenance is server-asserted: it can only be set through the
    `/forward` route, never accepted from a normal send body;
  - the target message envelope's public `forwardedFrom` exposes only
    `forwardedByPrincipalId`; the source room, envelope, and original sender are
    retained server-side (D1 + audit log) but not exposed to target-room members.
- Delete-for-everyone is backend-backed tombstoning:
  - the sender can delete their own message for everyone within 48 hours;
  - group/channel owners and admins can delete any active message for everyone;
  - direct-room participants cannot delete the other participant's message for
    everyone;
  - the message row and `serverSequence` remain, while clients render a
    tombstone.

## Backend Shape

`POST /v1/rooms/{roomId}/messages/delete`

```json
{
  "scope": "for_me",
  "envelopeIds": ["msg_..."]
}
```

```json
{
  "scope": "everyone",
  "envelopeIds": ["msg_..."]
}
```

`for_me` writes account-scoped visibility rows. `everyone` is serialized through
the `ConversationCoordinator` and converts matching envelopes into durable
tombstones. The backend clears reactions and active pins for tombstoned
messages.

The D1 table `message_visibility` is account-scoped, not device-scoped. This is
intentional: deleting a message for yourself should hide it across your active
clients after reload/sync.

`PATCH /v1/rooms/{roomId}/messages/{envelopeId}`

```json
{
  "protocolType": "opaque-test",
  "ciphertext": "opaque-client-payload-edited",
  "clientEditedAt": "2026-06-21T12:00:00.000Z"
}
```

Edits are active-message replacements with immutable edit history, not physical
row replacement.

`POST /v1/rooms/{roomId}/messages/{envelopeId}/reactions`

```json
{
  "reaction": "👍"
}
```

The add route is idempotent for the current principal and replaces that
principal's previous reaction on the same message. Removing a reaction uses
`DELETE /v1/rooms/{roomId}/messages/{envelopeId}/reactions/{reaction}` and only
removes the current principal's row.

`POST /v1/rooms/{roomId}/messages/{envelopeId}/pin`

Pins the message in the room. `DELETE` on the same path unpins it. Pinning is
serialized through the `ConversationCoordinator`; it is room metadata, not a
second message timeline.

`POST /v1/rooms/{roomId}/messages/{envelopeId}/forward`

```json
{
  "targetRoomId": "room_...",
  "idempotencyKey": "client-generated-key",
  "protocolType": "opaque-test",
  "ciphertext": "client-reencoded-target-room-payload",
  "clientCreatedAt": "2026-06-21T12:00:00.000Z"
}
```

Forwarding does not make the backend decrypt or reinterpret content. The client
chooses what can be rendered, re-encodes it for the target room, and the backend
stores source metadata on the new envelope.

## Deferred

- Server-side plaintext search. This remains out of scope because message
  content is client-owned and future MLS/E2EE work should not introduce
  server-readable indexes by accident.
