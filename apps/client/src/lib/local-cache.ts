import type { Room } from '$lib/api/types';
import type { ChatMessage } from '$lib/stores/messages.svelte';

const DB_NAME = 'voyager-client-cache';
const DB_VERSION = 2;
const ROOM_STORE = 'rooms';
const MESSAGE_STORE = 'messages';
const SYNC_STORE = 'syncState';
const ROOM_CURSOR_PREFIX = 'roomCursor:';
const ACCOUNT_SYNC_CURSOR_KEY = 'accountSyncCursor';

type CacheScope = string | null | undefined;

interface CachedRoom {
	cacheKey: string;
	scopeKey: string;
	roomId: string;
	updatedAt: string;
	cachedAt: string;
	room: Room;
}

interface CachedMessage {
	cacheKey: string;
	scopeKey: string;
	roomId: string;
	serverSequence: number;
	cachedAt: string;
	message: ChatMessage;
}

interface SyncStateRow {
	key: string;
	value: unknown;
	updatedAt: string;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function canUseIndexedDb(): boolean {
	return typeof indexedDB !== 'undefined';
}

function openDatabase(): Promise<IDBDatabase | null> {
	if (!canUseIndexedDb()) return Promise.resolve(null);
	if (dbPromise) return dbPromise;
	dbPromise = new Promise((resolve) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (db.objectStoreNames.contains(ROOM_STORE)) db.deleteObjectStore(ROOM_STORE);
			if (db.objectStoreNames.contains(MESSAGE_STORE)) db.deleteObjectStore(MESSAGE_STORE);
			if (db.objectStoreNames.contains(SYNC_STORE)) db.deleteObjectStore(SYNC_STORE);
			const roomStore = db.createObjectStore(ROOM_STORE, { keyPath: 'cacheKey' });
			roomStore.createIndex('scopeUpdated', ['scopeKey', 'updatedAt']);
			const messageStore = db.createObjectStore(MESSAGE_STORE, { keyPath: 'cacheKey' });
			messageStore.createIndex('roomSequence', ['scopeKey', 'roomId', 'serverSequence']);
			db.createObjectStore(SYNC_STORE, { keyPath: 'key' });
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => resolve(null);
		request.onblocked = () => resolve(null);
	});
	return dbPromise;
}

function transactionDone(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
		tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
	});
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
	});
}

async function readStore<T>(
	storeName: string,
	read: (store: IDBObjectStore) => Promise<T>
): Promise<T | null> {
	const db = await openDatabase();
	if (!db) return null;
	const tx = db.transaction(storeName, 'readonly');
	try {
		return await read(tx.objectStore(storeName));
	} catch {
		return null;
	}
}

async function writeStores(
	storeNames: string | string[],
	write: (stores: Map<string, IDBObjectStore>) => void
): Promise<void> {
	const db = await openDatabase();
	if (!db) return;
	const names = Array.isArray(storeNames) ? storeNames : [storeNames];
	const tx = db.transaction(names, 'readwrite');
	const stores = new Map(names.map((name) => [name, tx.objectStore(name)]));
	try {
		write(stores);
		await transactionDone(tx);
	} catch {
		try {
			tx.abort();
		} catch {
			/* already finished */
		}
	}
}

export function clientCacheScope(accountId: string | null | undefined, principalId: string | null | undefined): string | null {
	if (!accountId || !principalId) return null;
	return `${accountId}:${principalId}`;
}

function scopedKey(scopeKey: string, id: string): string {
	return `${scopeKey}:${id}`;
}

function roomCursorKey(scopeKey: string, roomId: string): string {
	return scopedKey(scopeKey, `${ROOM_CURSOR_PREFIX}${roomId}`);
}

function accountSyncCursorKey(scopeKey: string): string {
	return scopedKey(scopeKey, ACCOUNT_SYNC_CURSOR_KEY);
}

function stableMessageCacheKey(scopeKey: string, message: ChatMessage): string | null {
	if (!message.envelopeId || message.serverSequence <= 0) return null;
	return scopedKey(scopeKey, `${message.roomId}:${message.envelopeId}`);
}

export async function loadCachedRooms(scopeKey: CacheScope): Promise<Room[]> {
	if (!scopeKey) return [];
	const rows = await readStore<CachedRoom[]>(ROOM_STORE, (store) => {
		const index = store.index('scopeUpdated');
		const range = IDBKeyRange.bound([scopeKey, ''], [scopeKey, '\uffff']);
		return requestResult(index.getAll(range) as IDBRequest<CachedRoom[]>);
	});
	return (rows ?? []).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((row) => row.room);
}

export async function saveCachedRooms(scopeKey: CacheScope, rooms: Room[]): Promise<void> {
	if (!scopeKey || !rooms.length) return;
	const cachedAt = new Date().toISOString();
	await writeStores(ROOM_STORE, (stores) => {
		const store = stores.get(ROOM_STORE)!;
		for (const room of rooms) {
			store.put({
				cacheKey: scopedKey(scopeKey, room.roomId),
				scopeKey,
				roomId: room.roomId,
				updatedAt: room.updatedAt,
				cachedAt,
				room
			} satisfies CachedRoom);
		}
	});
}

export async function removeCachedRoom(scopeKey: CacheScope, roomId: string): Promise<void> {
	if (!scopeKey) return;
	await writeStores(ROOM_STORE, (stores) => stores.get(ROOM_STORE)!.delete(scopedKey(scopeKey, roomId)));
}

export async function removeCachedRoomMessages(scopeKey: CacheScope, roomId: string): Promise<void> {
	if (!scopeKey) return;
	const db = await openDatabase();
	if (!db) return;
	const tx = db.transaction([MESSAGE_STORE, SYNC_STORE], 'readwrite');
	try {
		const messageStore = tx.objectStore(MESSAGE_STORE);
		const index = messageStore.index('roomSequence');
		const range = IDBKeyRange.bound([scopeKey, roomId, 0], [scopeKey, roomId, Number.MAX_SAFE_INTEGER]);
		const request = index.openCursor(range);
		request.onsuccess = () => {
			const cursor = request.result;
			if (!cursor) return;
			cursor.delete();
			cursor.continue();
		};
		tx.objectStore(SYNC_STORE).delete(roomCursorKey(scopeKey, roomId));
		await transactionDone(tx);
	} catch {
		try {
			tx.abort();
		} catch {
			/* already finished */
		}
	}
}

export async function loadCachedRoomMessages(scopeKey: CacheScope, roomId: string, limit = 200): Promise<ChatMessage[]> {
	if (!scopeKey) return [];
	const rows = await readStore<CachedMessage[]>(MESSAGE_STORE, (store) => {
		const index = store.index('roomSequence');
		const range = IDBKeyRange.bound([scopeKey, roomId, 0], [scopeKey, roomId, Number.MAX_SAFE_INTEGER]);
		return new Promise((resolve, reject) => {
			const messages: CachedMessage[] = [];
			const request = index.openCursor(range, 'prev');
			request.onsuccess = () => {
				const cursor = request.result;
				if (!cursor || messages.length >= limit) {
					resolve(messages.reverse());
					return;
				}
				messages.push(cursor.value as CachedMessage);
				cursor.continue();
			};
			request.onerror = () => reject(request.error ?? new Error('IndexedDB cursor failed'));
		});
	});
	return (rows ?? []).map((row) => row.message);
}

export async function saveCachedMessages(scopeKey: CacheScope, messages: ChatMessage[]): Promise<void> {
	if (!scopeKey) return;
	const stableMessages = messages
		.map((message) => ({ message, cacheKey: stableMessageCacheKey(scopeKey, message) }))
		.filter((entry): entry is { message: ChatMessage; cacheKey: string } => Boolean(entry.cacheKey));
	if (!stableMessages.length) return;
	const cachedAt = new Date().toISOString();
	await writeStores([MESSAGE_STORE, SYNC_STORE], (stores) => {
		const messageStore = stores.get(MESSAGE_STORE)!;
		const syncStore = stores.get(SYNC_STORE)!;
		const maxByRoom = new Map<string, number>();
		for (const { message, cacheKey } of stableMessages) {
			messageStore.put({
				cacheKey,
				scopeKey,
				roomId: message.roomId,
				serverSequence: message.serverSequence,
				cachedAt,
				message
			} satisfies CachedMessage);
			maxByRoom.set(message.roomId, Math.max(maxByRoom.get(message.roomId) ?? 0, message.serverSequence));
		}
		for (const [roomId, cursor] of maxByRoom) {
			syncStore.put({
				key: roomCursorKey(scopeKey, roomId),
				value: cursor,
				updatedAt: cachedAt
			} satisfies SyncStateRow);
		}
	});
}

export async function removeCachedMessages(scopeKey: CacheScope, roomId: string, envelopeIds: string[]): Promise<void> {
	if (!scopeKey || !envelopeIds.length) return;
	await writeStores(MESSAGE_STORE, (stores) => {
		const store = stores.get(MESSAGE_STORE)!;
		for (const envelopeId of new Set(envelopeIds.filter(Boolean))) {
			store.delete(scopedKey(scopeKey, `${roomId}:${envelopeId}`));
		}
	});
}

export async function loadCachedRoomCursor(scopeKey: CacheScope, roomId: string): Promise<number> {
	if (!scopeKey) return 0;
	const row = await readStore<SyncStateRow | undefined>(SYNC_STORE, (store) =>
		requestResult(store.get(roomCursorKey(scopeKey, roomId)) as IDBRequest<SyncStateRow | undefined>)
	);
	const value = row?.value;
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export async function loadCachedSyncCursor(scopeKey: CacheScope): Promise<string | null> {
	if (!scopeKey) return null;
	const row = await readStore<SyncStateRow | undefined>(SYNC_STORE, (store) =>
		requestResult(store.get(accountSyncCursorKey(scopeKey)) as IDBRequest<SyncStateRow | undefined>)
	);
	const value = row?.value;
	return typeof value === 'string' && value.length > 0 ? value : null;
}

export async function saveCachedSyncCursor(scopeKey: CacheScope, cursor: string | null | undefined): Promise<void> {
	if (!scopeKey || !cursor) return;
	await writeStores(SYNC_STORE, (stores) =>
		stores.get(SYNC_STORE)!.put({
			key: accountSyncCursorKey(scopeKey),
			value: cursor,
			updatedAt: new Date().toISOString()
		} satisfies SyncStateRow)
	);
}

export async function clearClientCache(): Promise<void> {
	await writeStores([ROOM_STORE, MESSAGE_STORE, SYNC_STORE], (stores) => {
		stores.get(ROOM_STORE)!.clear();
		stores.get(MESSAGE_STORE)!.clear();
		stores.get(SYNC_STORE)!.clear();
	});
}
