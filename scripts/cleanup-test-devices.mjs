// Cleanup stale Voyager test devices through the authenticated API.
//
// Defaults are intentionally conservative:
// - dry-run unless APPLY=1
// - seeded demo accounts only
// - probe/smoke/test labels and platforms only unless INCLUDE_APP_DEVICES=1
//
// Useful remote run:
//   BASE_URL=https://voyager-api-dev.microgentic-voyager.workers.dev \
//   ADMIN_EMAIL=ada@example.com \
//   ADMIN_PASSWORD=voyager-demo-pass \
//   npm run dev:cleanup-devices
//
// Apply after reviewing the dry-run:
//   APPLY=1 BASE_URL=... ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run dev:cleanup-devices

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'ada@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'voyager-demo-pass';
const ADMIN_SESSION_TOKEN = process.env.ADMIN_SESSION_TOKEN;
const ADMIN_DEVICE_ID = process.env.ADMIN_DEVICE_ID;
const APPLY = process.env.APPLY === '1' || process.env.DRY_RUN === 'false';
const INCLUDE_APP_DEVICES = process.env.INCLUDE_APP_DEVICES === '1';
const KEEP_NEWEST_PER_ACCOUNT = Number(process.env.KEEP_NEWEST_PER_ACCOUNT ?? '1');

const SEEDED_EMAILS = [
	'ada@example.com',
	'grace@example.com',
	'alan@example.com',
	'katherine@example.com',
	'margaret@example.com',
	'hedy@example.com',
	'dorothy@example.com',
	'donald@example.com'
];

const accountEmails = (process.env.ACCOUNT_EMAILS ?? SEEDED_EMAILS.join(','))
	.split(',')
	.map((value) => value.trim().toLowerCase())
	.filter(Boolean);

async function call(path, { method = 'GET', token, body } = {}) {
	const headers = {};
	if (token) headers.authorization = `Bearer ${token}`;
	if (body) headers['content-type'] = 'application/json';
	const response = await fetch(BASE + path, {
		method,
		headers,
		body: body ? JSON.stringify(body) : undefined,
		signal: AbortSignal.timeout(20_000)
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
		platform: 'cleanup',
		label: 'Cleanup CLI',
		clientVersion: 'cleanup-script',
		protocolVersion: 'dev-test'
	};
	try {
		const result = await call('/v1/auth/password/login', {
			method: 'POST',
			body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, device }
		});
		return { token: result.sessionToken, cleanupDeviceId: ADMIN_DEVICE_ID ? null : result.device.deviceId, source: ADMIN_EMAIL };
	} catch (error) {
		if (String(error.message).includes('device_limit_reached')) {
			console.error('The admin account is at its active-device limit.');
			console.error('Set ADMIN_SESSION_TOKEN to an existing platform-owner session token, or set ADMIN_DEVICE_ID to reuse an enrolled admin device.');
		}
		throw error;
	}
}

function printCleanup(cleanup) {
	const mode = cleanup.dryRun ? 'DRY RUN' : 'APPLIED';
	console.log(`${mode}: scanned ${cleanup.scanned}, matched ${cleanup.matched}, revoked ${cleanup.revoked}`);
	if (cleanup.devices.length === 0) {
		console.log('No matching active test devices found.');
		return;
	}
	for (const device of cleanup.devices) {
		console.log(
			[
				device.deviceId,
				device.accountEmail ?? device.accountId,
				device.platform,
				JSON.stringify(device.label),
				device.reason,
				`created=${device.createdAt}`
			].join('  ')
		);
	}
}

let auth;
try {
	auth = await login();
	const payload = {
		dryRun: !APPLY,
		accountEmails,
		includeKnownAppDevices: INCLUDE_APP_DEVICES,
		includeCurrentDevice: false,
		keepNewestPerAccount: KEEP_NEWEST_PER_ACCOUNT,
		reason: 'test_device_cleanup'
	};
	const result = await call('/v1/admin/devices/test-cleanup', {
		method: 'POST',
		token: auth.token,
		body: payload
	});
	printCleanup(result.cleanup);
	if (!APPLY) {
		console.log('');
		console.log('Review the list above, then rerun with APPLY=1 to revoke those devices.');
	}
} finally {
	if (auth?.cleanupDeviceId) {
		await call(`/v1/devices/${auth.cleanupDeviceId}/revoke`, {
			method: 'POST',
			token: auth.token,
			body: { reason: 'cleanup_script_session' }
		}).catch(() => undefined);
	}
}
