# Message Actions And Delete-For-Me

This PR adds the first Telegram-style message action layer without changing the
message-send, realtime, or sync source-of-truth model.

## Implemented

- Incoming and outgoing message alignment remains the messenger convention:
  incoming messages are left aligned; current-user outgoing messages are right
  aligned.
- Message actions open from desktop/web right-click and touch long-press.
- The initial action menu includes:
  - Copy;
  - Select;
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
  - message envelopes remain durable D1 history;
  - other room members still see the message;
  - the deleting account no longer receives the hidden envelopes from room
    history, `/v1/sync`, or `/v1/app/bootstrap`.

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

## Deferred

- Reactions.
- Forwarding.
- Message editing.
- Pinning.
- Search within chat.
- Reply composer UI.
- Delete for everyone.

Those features need additional product rules, durable state, or composer
changes and should land in focused follow-up PRs.
