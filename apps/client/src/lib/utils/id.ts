// Client-side ids. Idempotency keys gate duplicate sends on the backend
// (unique per sender_device_id), so they must be unguessable and ≥ 8 chars.

export function randomToken(length = 21): string {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	let out = '';
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (const byte of bytes) out += alphabet[byte % alphabet.length];
	return out;
}

export function idempotencyKey(): string {
	if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
		return `c-${crypto.randomUUID()}`;
	}
	return `c-${randomToken(24)}`;
}

export function localId(prefix = 'local'): string {
	return `${prefix}-${randomToken(12)}`;
}
