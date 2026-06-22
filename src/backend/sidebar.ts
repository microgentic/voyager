import { randomId } from "../crypto";
import { HttpError, stringField } from "../http";
import type { AuthContext, Env } from "../types";
import type { JsonObject } from "./shared/types";
import { requireRoomMembership } from "./rooms";
import { booleanField, optionalNumberField } from "./utils";

export async function listSidebarCollections(
  env: Env,
  auth: AuthContext,
): Promise<unknown[]> {
  const collections = await env.CONTROL_DB.prepare(
    "SELECT * FROM sidebar_collections WHERE account_id = ? ORDER BY sort_order ASC, created_at ASC",
  )
    .bind(auth.account.account_id)
    .all<Record<string, unknown>>();
  return publicSidebarCollections(env, collections.results ?? []);
}

export async function createSidebarCollection(
  env: Env,
  auth: AuthContext,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  const collectionId = randomId("col");
  await env.CONTROL_DB.prepare(
    "INSERT INTO sidebar_collections (collection_id, account_id, name, sort_order, collapsed) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(
      collectionId,
      auth.account.account_id,
      stringField(body, "name", { required: true, min: 1, max: 80 })!,
      optionalNumberField(body, "sortOrder", 0, 10_000) ?? 0,
      booleanField(body, "collapsed") ? 1 : 0,
    )
    .run();
  return publicSidebarCollection(
    env,
    await getSidebarCollection(env, auth, collectionId),
  );
}

export async function updateSidebarCollection(
  env: Env,
  auth: AuthContext,
  collectionId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  await getSidebarCollection(env, auth, collectionId);
  await env.CONTROL_DB.prepare(
    "UPDATE sidebar_collections SET name = COALESCE(?, name), sort_order = COALESCE(?, sort_order), collapsed = COALESCE(?, collapsed), updated_at = CURRENT_TIMESTAMP WHERE collection_id = ? AND account_id = ?",
  )
    .bind(
      stringField(body, "name", { max: 80 }) ?? null,
      optionalNumberField(body, "sortOrder", 0, 10_000) ?? null,
      body.collapsed === undefined
        ? null
        : booleanField(body, "collapsed")
          ? 1
          : 0,
      collectionId,
      auth.account.account_id,
    )
    .run();
  return publicSidebarCollection(
    env,
    await getSidebarCollection(env, auth, collectionId),
  );
}

export async function deleteSidebarCollection(
  env: Env,
  auth: AuthContext,
  collectionId: string,
): Promise<void> {
  await getSidebarCollection(env, auth, collectionId);
  await env.CONTROL_DB.prepare(
    "DELETE FROM sidebar_collections WHERE collection_id = ? AND account_id = ?",
  )
    .bind(collectionId, auth.account.account_id)
    .run();
}

export async function addSidebarCollectionItem(
  env: Env,
  auth: AuthContext,
  collectionId: string,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  await getSidebarCollection(env, auth, collectionId);
  const roomId = stringField(body, "roomId", { required: true, max: 80 })!;
  await requireRoomMembership(env, auth, roomId);
  const itemId = randomId("cit");
  await env.CONTROL_DB.prepare(
    `INSERT INTO sidebar_collection_items (item_id, collection_id, room_id, sort_order)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(collection_id, room_id) DO UPDATE SET sort_order = excluded.sort_order`,
  )
    .bind(
      itemId,
      collectionId,
      roomId,
      optionalNumberField(body, "sortOrder", 0, 10_000) ?? 0,
    )
    .run();
  return {
    collectionId,
    roomId,
    sortOrder: optionalNumberField(body, "sortOrder", 0, 10_000) ?? 0,
  };
}

export async function deleteSidebarCollectionItem(
  env: Env,
  auth: AuthContext,
  collectionId: string,
  roomId: string,
): Promise<void> {
  await getSidebarCollection(env, auth, collectionId);
  await env.CONTROL_DB.prepare(
    "DELETE FROM sidebar_collection_items WHERE collection_id = ? AND room_id = ?",
  )
    .bind(collectionId, roomId)
    .run();
}

export async function getSidebarCollection(
  env: Env,
  auth: AuthContext,
  collectionId: string,
): Promise<Record<string, unknown>> {
  const collection = await env.CONTROL_DB.prepare(
    "SELECT * FROM sidebar_collections WHERE collection_id = ? AND account_id = ?",
  )
    .bind(collectionId, auth.account.account_id)
    .first<Record<string, unknown>>();
  if (!collection)
    throw new HttpError(
      404,
      "collection_not_found",
      "Sidebar collection not found",
    );
  return collection;
}

export async function publicSidebarCollection(
  env: Env,
  collection: Record<string, unknown>,
): Promise<JsonObject> {
  const items = await env.CONTROL_DB.prepare(
    "SELECT * FROM sidebar_collection_items WHERE collection_id = ? ORDER BY sort_order ASC, created_at ASC",
  )
    .bind(collection.collection_id)
    .all<Record<string, unknown>>();
  return publicSidebarCollectionFromItems(collection, items.results ?? []);
}

export async function publicSidebarCollections(
  env: Env,
  collections: Record<string, unknown>[],
): Promise<JsonObject[]> {
  if (!collections.length) return [];
  const placeholders = collections.map(() => "?").join(", ");
  const items = await env.CONTROL_DB.prepare(
    `SELECT * FROM sidebar_collection_items
     WHERE collection_id IN (${placeholders})
     ORDER BY collection_id ASC, sort_order ASC, created_at ASC`,
  )
    .bind(...collections.map((collection) => collection.collection_id))
    .all<Record<string, unknown>>();
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const item of items.results ?? []) {
    const collectionId = String(item.collection_id);
    const group = grouped.get(collectionId) ?? [];
    group.push(item);
    grouped.set(collectionId, group);
  }
  return collections.map((collection) =>
    publicSidebarCollectionFromItems(
      collection,
      grouped.get(String(collection.collection_id)) ?? [],
    ),
  );
}

export function publicSidebarCollectionFromItems(
  collection: Record<string, unknown>,
  items: Record<string, unknown>[],
): JsonObject {
  return {
    collectionId: collection.collection_id,
    accountId: collection.account_id,
    name: collection.name,
    sortOrder: collection.sort_order,
    collapsed: Boolean(collection.collapsed),
    createdAt: collection.created_at,
    updatedAt: collection.updated_at,
    items: items.map((item) => ({
      itemId: item.item_id,
      roomId: item.room_id,
      sortOrder: item.sort_order,
      createdAt: item.created_at,
    })),
  };
}
