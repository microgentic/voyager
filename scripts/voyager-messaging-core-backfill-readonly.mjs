// Import current Voyager room/message read-parity rows into Messaging Core.
//
// Useful remote run:
//   BASE_URL=https://voyager-api-dev.microgentic-voyager.workers.dev \
//   ADMIN_EMAIL=ada@example.com \
//   ADMIN_PASSWORD=voyager-demo-pass \
//   npm run messaging-core:backfill-readonly

const BASE = trimTrailingSlash(process.env.VOYAGER_BASE_URL ?? process.env.BASE_URL ?? 'http://127.0.0.1:8787');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? process.env.VOYAGER_LOGIN_EMAIL ?? 'ada@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? process.env.VOYAGER_LOGIN_PASSWORD ?? 'voyager-demo-pass';
const ADMIN_SESSION_TOKEN = process.env.ADMIN_SESSION_TOKEN ?? process.env.VOYAGER_SESSION_TOKEN;
const ADMIN_DEVICE_ID = process.env.ADMIN_DEVICE_ID;
const ROOM_LIMIT = integerEnv('ROOM_LIMIT', 1, 500);
const MESSAGE_LIMIT = integerEnv('MESSAGE_LIMIT', 1, 500);
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

async function call(path, { method = 'GET', token, body } = {}) {
	const headers = {};
	if (token) headers.authorization = `Bearer ${token}`;
	if (body !== undefined) headers['content-type'] = 'application/json';
	const response = await fetch(`${BASE}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(Number(process.env.FETCH_TIMEOUT_MS ?? 30_000))
	});
	const text = await response.text();
	const payload = text ? JSON.parse(text) : {};
	if (!response.ok || payload.ok === false) {
		throw new Error(`${method} ${path} -> ${response.status} ${text}`);
	}
	return payload;
}

async function login() {
	if (ADMIN_SESSION_TOKEN) {
		return { token: ADMIN_SESSION_TOKEN, cleanupDeviceId: null, source: 'ADMIN_SESSION_TOKEN' };
	}
	const device = {
		deviceId: ADMIN_DEVICE_ID,
		platform: 'backfill',
		label: 'Messaging Core readonly backfill',
		clientVersion: 'backfill-script',
		protocolVersion: 'dev-test'
	};
	const result = await call('/v1/auth/password/login', {
		method: 'POST',
		body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, device }
	});
	return {
		token: result.sessionToken,
		cleanupDeviceId: ADMIN_DEVICE_ID ? null : result.device.deviceId,
		source: ADMIN_EMAIL
	};
}

let auth;
try {
	auth = await login();
	const body = {
		dryRun: DRY_RUN,
		...(ROOM_LIMIT === null ? {} : { roomLimit: ROOM_LIMIT }),
		...(MESSAGE_LIMIT === null ? {} : { messageLimit: MESSAGE_LIMIT })
	};
	const result = await call('/v1/admin/messaging-core/backfill-readonly', {
		method: 'POST',
		token: auth.token,
		body
	});
	console.log(JSON.stringify({
		ok: true,
		baseUrl: BASE,
		authenticatedAs: auth.source,
		dryRun: result.dryRun,
		tenantId: result.tenantId,
		limits: result.limits,
		snapshot: result.snapshot,
		imported: result.core?.imported?.imported ?? null
	}, null, 2));
} finally {
	if (auth?.cleanupDeviceId) {
		await call(`/v1/devices/${auth.cleanupDeviceId}/revoke`, {
			method: 'POST',
			token: auth.token,
			body: { reason: 'messaging_core_readonly_backfill_script' }
		}).catch(() => undefined);
	}
}

function integerEnv(key, min, max) {
	const value = process.env[key];
	if (value === undefined || value === '') return null;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
		throw new Error(`${key} must be an integer between ${min} and ${max}.`);
	}
	return parsed;
}

function trimTrailingSlash(value) {
	return value.trim().replace(/\/+$/, '');
}
