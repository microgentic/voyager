// Resolves the Voyager backend base URL.
//
// Precedence: explicit runtime override (Settings → saved in localStorage) >
// build-time env (VITE_API_BASE_URL) > the deployed dev Worker. The deployed
// default means the app works out of the box; pointing it at a local Worker
// (`npm run dev` in the repo root → http://localhost:8787) is a Settings tweak.

import { isTauri } from '$lib/platform';

const DEFAULT_API_BASE = 'https://voyager-api-dev.microgentic-voyager.workers.dev';
const LOCAL_WORKER_BASE = 'http://127.0.0.1:8787';
const STORAGE_KEY = 'voyager.apiBase';

function envBase(): string | undefined {
	try {
		return import.meta.env?.VITE_API_BASE_URL as string | undefined;
	} catch {
		return undefined;
	}
}

// In browser `vite dev` the client talks to the Worker through the dev proxy.
// Tauri dev shells call the local Worker directly; on iOS Simulator, WebKit +
// Vite proxy can forward JSON requests with an empty body.
function devDefault(): string | undefined {
	try {
		if (!import.meta.env?.DEV) return undefined;
		return isTauri() ? LOCAL_WORKER_BASE : '';
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

function stripTrailingSlash(value: string): string {
	return value.replace(/\/+$/, '');
}

export const APP_VERSION = '0.1.0';
export const CLIENT_PROTOCOL_VERSION = 'opaque-test-1';
