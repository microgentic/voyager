import type { Account, Device, Principal, Session } from '$lib/api/types';

// Local persistence of the session.
//
// What lives here is intentionally minimal: the bearer session token, a cached
// copy of the signed-in identity (so the shell can paint instantly before /v1/app/session
// confirms), and the enrolled deviceId keyed by email (so password login reuses
// the device instead of burning device quota). Message and room snapshots live
// in the IndexedDB-backed local cache, not in this localStorage session layer.

const TOKEN_KEY = 'voyager.session.token';
const IDENTITY_KEY = 'voyager.session.identity';
const deviceKey = (email: string) => `voyager.device.${email.trim().toLowerCase()}`;

export interface PersistedIdentity {
	account: Account;
	principal: Principal;
	device: Device;
	session?: Session | null;
	roles: string[];
}

function safeGet(key: string): string | null {
	try {
		return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
	} catch {
		return null;
	}
}

function safeSet(key: string, value: string): void {
	try {
		localStorage?.setItem(key, value);
	} catch {
		/* storage unavailable (private mode, etc.) */
	}
}

function safeRemove(key: string): void {
	try {
		localStorage?.removeItem(key);
	} catch {
		/* ignore */
	}
}

export function loadToken(): string | null {
	return safeGet(TOKEN_KEY);
}

export function saveToken(token: string): void {
	safeSet(TOKEN_KEY, token);
}

export function loadIdentity(): PersistedIdentity | null {
	const raw = safeGet(IDENTITY_KEY);
	if (!raw) return null;
	try {
		return JSON.parse(raw) as PersistedIdentity;
	} catch {
		return null;
	}
}

export function saveIdentity(identity: PersistedIdentity): void {
	safeSet(IDENTITY_KEY, JSON.stringify(identity));
}

export function clearSession(): void {
	safeRemove(TOKEN_KEY);
	safeRemove(IDENTITY_KEY);
}

export function loadDeviceId(email: string): string | undefined {
	if (!email) return undefined;
	return safeGet(deviceKey(email)) ?? undefined;
}

export function saveDeviceId(email: string | null | undefined, deviceId: string): void {
	if (!email) return;
	safeSet(deviceKey(email), deviceId);
}
