// Voyager local dev seed.
//
// Populates a *fresh* backend with believable demo data so the client has
// something to render: multiple human account/role types, groups that mix
// humans + agents, direct chats, messages (plain + markdown), pending room
// invitations, and an agent request.
//
// Usage (with the local Worker running on :8787 — see `npm run dev:backend`):
//   npm run seed            # from the repo root
//   BASE_URL=http://127.0.0.1:8787 node scripts/voyager-seed.mjs
//
// Idempotent: if the backend is already bootstrapped it prints the demo
// credentials and exits, so it is safe to re-run.

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const BOOTSTRAP_TOKEN = process.env.BOOTSTRAP_TOKEN ?? 'local-bootstrap-secret';
const PW = 'voyager-demo-pass';

const HUMAN_ACCOUNTS = [
	{
		key: 'owner',
		label: 'Platform owner',
		displayName: 'Ada Lovelace',
		email: 'ada@example.com',
		roles: ['platform_owner']
	},
	{ key: 'grace', label: 'Regular user', displayName: 'Grace Hopper', email: 'grace@example.com', roles: [] },
	{ key: 'alan', label: 'Regular user', displayName: 'Alan Turing', email: 'alan@example.com', roles: [] },
	{
		key: 'katherine',
		label: 'User admin',
		displayName: 'Katherine Johnson',
		email: 'katherine@example.com',
		roles: ['user_admin']
	},
	{
		key: 'margaret',
		label: 'Security admin',
		displayName: 'Margaret Hamilton',
		email: 'margaret@example.com',
		roles: ['security_admin']
	},
	{
		key: 'hedy',
		label: 'Agent provisioner',
		displayName: 'Hedy Lamarr',
		email: 'hedy@example.com',
		roles: ['agent_provisioner']
	},
	{
		key: 'dorothy',
		label: 'Quota operator',
		displayName: 'Dorothy Vaughan',
		email: 'dorothy@example.com',
		roles: ['quota_operator']
	},
	{ key: 'donald', label: 'Auditor', displayName: 'Donald Knuth', email: 'donald@example.com', roles: ['auditor'] }
];

const OWNER_ACCOUNT = HUMAN_ACCOUNTS.find((account) => account.key === 'owner');

async function call(path, { method = 'POST', token, body, bootstrap } = {}) {
	const headers = { 'content-type': 'application/json' };
	if (token) headers.authorization = `Bearer ${token}`;
	if (bootstrap) headers['x-bootstrap-token'] = bootstrap;
	const res = await fetch(BASE + path, {
		method,
		headers,
		body: body ? JSON.stringify(body) : undefined
	});
	const json = await res.json().catch(() => ({}));
	if (!res.ok || json.ok === false) {
		throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
	}
	return json;
}

function encode(body, contentType, senderPrincipalId) {
	const payload = {
		schema_version: 1,
		content_type: contentType,
		body,
		reply_to_message_id: null,
		attachments: [],
		client_metadata: { sender_principal_id: senderPrincipalId, created_at: new Date().toISOString() }
	};
	return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

let seq = 0;
async function send(token, roomId, principalId, body, contentType = 'text/plain') {
	seq += 1;
	return call(`/v1/rooms/${roomId}/messages`, {
		token,
		body: {
			idempotencyKey: `seed-${Date.now()}-${seq}`,
			protocolType: 'opaque-test',
			ciphertext: encode(body, contentType, principalId),
			clientCreatedAt: new Date().toISOString()
		}
	});
}

function printCredentials(prefix) {
	console.log(prefix);
	for (const account of HUMAN_ACCOUNTS) {
		console.log(`  ${account.label}: ${account.email}  /  ${PW}`);
	}
	console.log('  Agent principals: Billing Assistant, Refund Bot request (not password-login accounts)');
}

async function main() {
	// Reachability + idempotency guard.
	let status;
	try {
		status = await call('/v1/admin/bootstrap/status', { method: 'GET' });
	} catch (err) {
		console.error(`Cannot reach the backend at ${BASE}. Is \`npm run dev:backend\` running?`);
		throw err;
	}
	if (status.bootstrapped) {
		// Verify the demo graph exists — the backend may have been bootstrapped
		// with a different or older seed, in which case printing every expanded
		// credential would be misleading.
		const ownerLogin = await call('/v1/auth/password/login', {
			body: { email: OWNER_ACCOUNT.email, password: PW, device: { platform: 'web', label: 'Seed check' } }
		}).catch(() => null);
		if (!ownerLogin) {
			console.warn('⚠ Backend is already bootstrapped, but the demo owner is not present.');
			console.warn('  This script only creates the full demo graph on a FRESH backend.');
			console.warn('  Local reset: stop the Worker, `rm -rf .wrangler/local-state`, then re-run `dev:backend` + `seed`.');
			return;
		}
		const accountList = await call('/v1/admin/accounts', { method: 'GET', token: ownerLogin.sessionToken });
		await call('/v1/auth/logout', { token: ownerLogin.sessionToken }).catch(() => undefined);
		const emails = new Set(accountList.accounts.map((account) => account.email).filter(Boolean));
		const missing = HUMAN_ACCOUNTS.map((account) => account.email).filter((email) => !emails.has(email));
		if (missing.length === 0) {
			printCredentials('Backend already seeded — sign in with:');
		} else {
			console.warn('⚠ Backend is already bootstrapped, but not all expanded demo accounts are present.');
			console.warn(`  Missing or invalid demo logins: ${missing.join(', ')}`);
			console.warn('  This script only creates the full demo graph on a FRESH backend.');
			console.warn('  Local reset: stop the Worker, `rm -rf .wrangler/local-state`, then re-run `dev:backend` + `seed`.');
		}
		return;
	}

	const owner = await call('/v1/admin/bootstrap', {
		bootstrap: BOOTSTRAP_TOKEN,
		body: {
			displayName: OWNER_ACCOUNT.displayName,
			email: OWNER_ACCOUNT.email,
			password: PW,
			device: { platform: 'web', label: 'Seed' }
		}
	}).then((r) => ({
		...OWNER_ACCOUNT,
		token: r.sessionToken,
		accountId: r.account.accountId,
		principalId: r.principal.principalId
	}));

	const accounts = new Map([[owner.key, owner]]);

	async function createUser(account) {
		const inv = await call('/v1/admin/invitations', {
			token: owner.token,
			body: { displayName: account.displayName, email: account.email }
		});
		const act = await call('/v1/invitations/accept', {
			body: { token: inv.activationToken, password: PW, device: { platform: 'web', label: 'Seed' } }
		});
		return {
			...account,
			token: act.sessionToken,
			accountId: act.account.accountId,
			principalId: act.principal.principalId
		};
	}

	for (const account of HUMAN_ACCOUNTS.filter((candidate) => candidate.key !== owner.key)) {
		accounts.set(account.key, await createUser(account));
	}

	for (const account of accounts.values()) {
		for (const roleName of account.roles.filter((role) => role !== 'platform_owner')) {
			await call(`/v1/admin/accounts/${account.accountId}/roles`, {
				token: owner.token,
				body: { roleName }
			});
		}
	}

	const grace = accounts.get('grace');
	const alan = accounts.get('alan');
	const katherine = accounts.get('katherine');
	const margaret = accounts.get('margaret');
	const hedy = accounts.get('hedy');
	const dorothy = accounts.get('dorothy');
	const donald = accounts.get('donald');

	async function inviteAndAccept(roomId, account, role = 'member') {
		const rinv = await call(`/v1/rooms/${roomId}/invitations`, {
			token: owner.token,
			body: { principalId: account.principalId, role }
		});
		await call(`/v1/room-invitations/${rinv.invitation.roomInvitationId}/accept`, { token: account.token });
		return rinv.invitation;
	}

	// Group mixing humans + an agent.
	const group = (
		await call('/v1/rooms/groups', {
			token: owner.token,
			body: { name: 'Billing operations', description: 'Where billing humans and agents collaborate securely.' }
		})
	).room;
	await inviteAndAccept(group.roomId, grace, 'admin');
	await call(`/v1/rooms/${group.roomId}/invitations`, { token: owner.token, body: { principalId: alan.principalId } });

	const agent = (
		await call('/v1/admin/agents', {
			token: owner.token,
			body: { displayName: 'Billing Assistant', ownerPrincipalId: owner.principalId }
		})
	).agent;
	await call(`/v1/rooms/${group.roomId}/members`, {
		token: owner.token,
		body: { principalId: agent.principalId, role: 'agent' }
	});

	// Direct: Ada <-> Grace.
	const direct = (await call('/v1/rooms/direct', { token: owner.token, body: { principalIds: [grace.principalId] } })).room;
	await send(grace.token, direct.roomId, grace.principalId, 'Hey Ada! Did the June invoices go out?');
	await send(owner.token, direct.roomId, owner.principalId, 'Morning Grace 👋 Yes — all 42 went out last night.');
	await send(grace.token, direct.roomId, grace.principalId, 'Perfect, thank you!');

	// Direct: Ada <-> Alan. Alan also has a pending billing-room invitation.
	const alanDirect = (await call('/v1/rooms/direct', { token: owner.token, body: { principalIds: [alan.principalId] } })).room;
	await send(owner.token, alanDirect.roomId, owner.principalId, 'Welcome aboard, Alan. You should see a billing-room invite waiting.');
	await send(alan.token, alanDirect.roomId, alan.principalId, 'Thanks Ada — I will review it from my device.');

	// Direct: Ada <-> Agent.
	const agentDirect = (await call('/v1/rooms/direct', { token: owner.token, body: { principalIds: [agent.principalId] } })).room;
	await send(owner.token, agentDirect.roomId, owner.principalId, 'Can you summarize this month’s overdue accounts?');

	// Group conversation (plain + markdown).
	await send(owner.token, group.roomId, owner.principalId, 'Welcome to the room — our assistant is now here.');
	await send(
		grace.token,
		group.roomId,
		grace.principalId,
		"Thanks for setting this up! Here's the checklist:\n\n- Reconcile Stripe\n- Email overdue accounts\n- Post summary"
	);
	await send(owner.token, group.roomId, owner.principalId, 'Looks good. Use `#billing` for tickets.', 'text/markdown');

	// Admin-role group: useful for testing the same deployment from several
	// human accounts with different backend privileges.
	const adminGroup = (
		await call('/v1/rooms/groups', {
			token: owner.token,
			body: { name: 'Admin review', description: 'Seeded admin-role humans for cross-device testing.' }
		})
	).room;
	for (const account of [katherine, margaret, hedy, dorothy, donald]) {
		await inviteAndAccept(adminGroup.roomId, account);
	}
	await send(owner.token, adminGroup.roomId, owner.principalId, 'This room includes each seeded admin role type.');
	await send(katherine.token, adminGroup.roomId, katherine.principalId, 'User admin account online.');
	await send(margaret.token, adminGroup.roomId, margaret.principalId, 'Security admin account online.');

	// Grace invites Ada to a group → Ada has a pending invitation to review.
	const support = (await call('/v1/rooms/groups', { token: grace.token, body: { name: 'Support escalations' } })).room;
	await call(`/v1/rooms/${support.roomId}/invitations`, { token: grace.token, body: { principalId: owner.principalId } });

	// An agent request awaiting admin review.
	await call('/v1/agent-requests', {
		token: owner.token,
		body: {
			desiredAgentName: 'Refund Bot',
			summary: 'Approves refunds up to $200 automatically and escalates anything larger to a human.'
		}
	});

	printCredentials('Seed complete. Sign in with:');
}

main().catch((err) => {
	console.error(err.message ?? err);
	process.exit(1);
});
