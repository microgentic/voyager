import type { Room } from '$lib/api/types';
import type { ChatMessage } from '$lib/stores/messages.svelte';

const DB_NAME = 'voyager-client-cache';
const DB_VERSION = 1;
const ROOM_STORE = 'rooms';
const MESSAGE_STORE = 'messages';
const SYNC_STORE = 'syncState';
const ROOM_CURSOR_PREFIX = 'roomCursor:';

interface CachedRoom extends Room {
	cachedAt: string;
}

interface CachedMessage {
	cacheKey: string;
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
			if (!db.objectStoreNames.contains(ROOM_STORE)) {
				db.createObjectStore(ROOM_STORE, { keyPath: 'roomId' });
			}
			if (!db.objectStoreNames.contains(MESSAGE_STORE)) {
				const store = db.createObjectStore(MESSAGE_STORE, { keyPath: 'cacheKey' });
				store.createIndex('roomId', 'roomId');
				store.createIndex('roomSequence', ['roomId', 'serverSequence']);
			}
			if (!db.objectStoreNames.contains(SYNC_STORE)) {
				db.createObjectStore(SYNC_STORE, { keyPath: 'key' });
			}
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

function roomCursorKey(roomId: string): string {
	return `${ROOM_CURSOR_PREFIX}${roomId}`;
}

function stableMessageCacheKey(message: ChatMessage): string | null {
	if (!message.envelopeId || message.serverSequence <= 0) return null;
	return `${message.roomId}:${message.envelopeId}`;
}

export async function loadCachedRooms(): Promise<Room[]> {
	const rows = await readStore<CachedRoom[]>(ROOM_STORE, (store) =>
		requestResult(store.getAll() as IDBRequest<CachedRoom[]>)
	);
	return (rows ?? []).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function saveCachedRooms(rooms: Room[]): Promise<void> {
	if (!rooms.length) return;
	const cachedAt = new Date().toISOString();
	await writeStores(ROOM_STORE, (stores) => {
		const store = stores.get(ROOM_STORE)!;
		for (const room of rooms) store.put({ ...room, cachedAt } satisfies CachedRoom);
	});
}

export async function removeCachedRoom(roomId: string): Promise<void> {
	await writeStores(ROOM_STORE, (stores) => stores.get(ROOM_STORE)!.delete(roomId));
}

export async function loadCachedRoomMessages(roomId: string, limit = 200): Promise<ChatMessage[]> {
	const rows = await readStore<CachedMessage[]>(MESSAGE_STORE, (store) => {
		const index = store.index('roomSequence');
		const range = IDBKeyRange.bound([roomId, 0], [roomId, Number.MAX_SAFE_INTEGER]);
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

export async function saveCachedMessages(messages: ChatMessage[]): Promise<void> {
	const stableMessages = messages
		.map((message) => ({ message, cacheKey: stableMessageCacheKey(message) }))
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
				roomId: message.roomId,
				serverSequence: message.serverSequence,
				cachedAt,
				message
			} satisfies CachedMessage);
			maxByRoom.set(message.roomId, Math.max(maxByRoom.get(message.roomId) ?? 0, message.serverSequence));
		}
		for (const [roomId, cursor] of maxByRoom) {
			syncStore.put({
				key: roomCursorKey(roomId),
				value: cursor,
				updatedAt: cachedAt
			} satisfies SyncStateRow);
		}
	});
}

export async function loadCachedRoomCursor(roomId: string): Promise<number> {
	const row = await readStore<SyncStateRow | undefined>(SYNC_STORE, (store) =>
		requestResult(store.get(roomCursorKey(roomId)) as IDBRequest<SyncStateRow | undefined>)
	);
	const value = row?.value;
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export async function clearClientCache(): Promise<void> {
	await writeStores([ROOM_STORE, MESSAGE_STORE, SYNC_STORE], (stores) => {
		stores.get(ROOM_STORE)!.clear();
		stores.get(MESSAGE_STORE)!.clear();
		stores.get(SYNC_STORE)!.clear();
	});
}
