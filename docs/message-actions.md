# Message Actions, Status, Reply, Edit, And Delete-For-Me

These PRs add the first Telegram-style message action layer without changing the
message-send, realtime, or sync source-of-truth model.

## Implemented

- Incoming and outgoing message alignment remains the messenger convention:
  incoming messages are left aligned; current-user outgoing messages are right
  aligned.
- Message actions open from desktop/web right-click and touch long-press.
- The initial action menu includes:
  - Reply;
  - Copy;
  - Select;
  - Edit for sent current-user messages;
  - Retry send for failed local outgoing messages;
  - Message info;
  - Delete for me.
- Multi-select mode supports:
  - selected count;
  - Copy;
  - Select all;
  - Delete;
  - Cancel.
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

## Backend Shape

`POST /v1/rooms/{roomId}/messages/delete`

```json
{
  "scope": "for_me",
  "envelopeIds": ["msg_..."]
}
```

The only supported scope is `for_me`. Future `for_everyone` semantics should be
added explicitly rather than overloading this behavior.

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

## Deferred

- Reactions.
- Forwarding.
- Pinning.
- Search within chat.
- Delete for everyone.

Those features need additional product rules, durable state, or composer
changes and should land in focused follow-up PRs.
