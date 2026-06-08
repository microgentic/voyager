// Platform detection + the small set of native affordances the web layer needs.
// Anything deeper (secure storage, the MLS core) lands as Tauri commands and is
// reached from here so the rest of the app stays platform-agnostic.

export function isTauri(): boolean {
	return (
		typeof window !== 'undefined' &&
		(Boolean(window.__TAURI_INTERNALS__) || Boolean(window.__TAURI__))
	);
}

export function platformKind(): 'desktop' | 'web' {
	return isTauri() ? 'desktop' : 'web';
}

/** Coarse value for the backend `device.platform` field. */
export function devicePlatform(): string {
	return isTauri() ? 'desktop' : 'web';
}

/** A friendly device label like "Chrome · macOS" for the devices list. */
export function deviceLabel(): string {
	const shell = isTauri() ? 'Desktop app' : 'Web';
	if (typeof navigator === 'undefined') return shell;
	const ua = navigator.userAgent;
	const os = /iPhone|iPad|iPod/.test(ua)
		? 'iOS'
		: /Android/.test(ua)
			? 'Android'
			: /Mac OS X|Macintosh/.test(ua)
				? 'macOS'
				: /Windows/.test(ua)
					? 'Windows'
					: /Linux/.test(ua)
						? 'Linux'
						: 'Unknown OS';
	const browser = /Edg\//.test(ua)
		? 'Edge'
		: /Chrome\//.test(ua)
			? 'Chrome'
			: /Firefox\//.test(ua)
				? 'Firefox'
				: /Safari\//.test(ua)
					? 'Safari'
					: 'Browser';
	return isTauri() ? `Desktop · ${os}` : `${browser} · ${os}`;
}

export async function openExternal(url: string): Promise<void> {
	if (isTauri()) {
		try {
			const { openUrl } = await import('@tauri-apps/plugin-opener');
			await openUrl(url);
			return;
		} catch {
			// fall through to web behavior
		}
	}
	if (typeof window !== 'undefined') {
		window.open(url, '_blank', 'noopener,noreferrer');
	}
}
