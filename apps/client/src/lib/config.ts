// Resolves the Voyager backend base URL.
//
// Precedence: explicit runtime override (Settings → saved in localStorage) >
// build-time env (VITE_API_BASE_URL) > the deployed dev Worker. The deployed
// default means the app works out of the box; pointing it at a local Worker
// (`npm run dev` in the repo root → http://localhost:8787) is a Settings tweak.

import { devicePlatform, isTauri } from '$lib/platform';

const DEFAULT_API_BASE = 'https://voyager-api-dev.microgentic-voyager.workers.dev';
const LOCAL_WORKER_BASE = 'http://127.0.0.1:8787';
// Android emulators reach the host machine via the 10.0.2.2 alias, not 127.0.0.1.
const ANDROID_EMULATOR_WORKER_BASE = 'http://10.0.2.2:8787';
const STORAGE_KEY = 'voyager.apiBase';
const CORE_REALTIME_STORAGE_KEY = 'voyager.messagingCoreRealtime';

function envBase(): string | undefined {
	try {
		return import.meta.env?.VITE_API_BASE_URL as string | undefined;
	} catch {
		return undefined;
	}
}

// In browser `vite dev` the client talks to the Worker through the dev proxy.
// Tauri dev shells call the local Worker directly: desktop + iOS Simulator via
// 127.0.0.1, the Android emulator via its 10.0.2.2 host alias. Built apps
// (DEV=false) fall through to the deployed Worker.
function devDefault(): string | undefined {
	try {
		if (!import.meta.env?.DEV) return undefined;
		if (!isTauri()) return '';
		return devicePlatform() === 'android' ? ANDROID_EMULATOR_WORKER_BASE : LOCAL_WORKER_BASE;
	} catch {
		return undefined;
	}
}

export function getApiBase(): string {
	if (typeof localStorage !== 'undefined') {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored && stored.trim()) return stripTrailingSlash(stored.trim());
	}
	return stripTrailingSlash(envBase() ?? devDefault() ?? DEFAULT_API_BASE);
}

export function setApiBase(base: string | null): void {
	if (typeof localStorage === 'undefined') return;
	if (!base || !base.trim()) {
		localStorage.removeItem(STORAGE_KEY);
		return;
	}
	localStorage.setItem(STORAGE_KEY, stripTrailingSlash(base.trim()));
}

export function defaultApiBase(): string {
	return stripTrailingSlash(envBase() ?? DEFAULT_API_BASE);
}

export function messagingCoreRealtimeEnabled(): boolean {
	if (typeof localStorage !== 'undefined') {
		const stored = localStorage.getItem(CORE_REALTIME_STORAGE_KEY);
		if (stored === '1' || stored === 'true') return true;
		if (stored === '0' || stored === 'false') return false;
	}
	try {
		const value = import.meta.env?.VITE_MESSAGING_CORE_REALTIME;
		const allCoreValue = import.meta.env?.VITE_MESSAGING_CORE_ALL_CUTOVER;
		if (allCoreValue === '1' || allCoreValue === 'true') return true;
		return value === '1' || value === 'true';
	} catch {
		return false;
	}
}

function stripTrailingSlash(value: string): string {
	return value.replace(/\/+$/, '');
}

export const APP_VERSION = '0.1.0';
export const CLIENT_PROTOCOL_VERSION = 'opaque-test-1';
