// Voyager local dev seed.
//
// Populates a *fresh* local backend with believable demo data so the client
// has something to render: a platform owner, two users, a group that mixes
// humans + an agent, direct chats, messages (plain + markdown), a pending
// room invitation, and an agent request.
//
// Usage (with the local Worker running on :8787 — see `npm run dev:backend`):
//   npm run seed            # from the repo root
//   BASE_URL=http://127.0.0.1:8787 node scripts/voyager-seed.mjs
//
// Idempotent: if the backend is already bootstrapped it prints the demo
// credentials and exits, so it is safe to re-run.

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const BOOTSTRAP_TOKEN = process.env.BOOTSTRAP_TOKEN ?? 'local-bootstrap-secret';
const PW = 'voyager-demo-passphrase';

const CREDS = {
	owner: { email: 'ada@example.com', password: PW },
	user: { email: 'grace@example.com', password: PW }
};

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
	console.log(`  Owner: ${CREDS.owner.email}  /  ${PW}`);
	console.log(`  User:  ${CREDS.user.email}  /  ${PW}`);
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
		// Verify the demo owner actually works — the backend may have been
		// bootstrapped with a different account, in which case the demo
		// credentials would be misleading.
		const ownerWorks = await call('/v1/auth/password/login', {
			body: { email: CREDS.owner.email, password: PW, device: { platform: 'web', label: 'Seed check' } }
		})
			.then(() => true)
			.catch(() => false);
		if (ownerWorks) {
			printCredentials('Backend already seeded — sign in with:');
		} else {
			console.warn('⚠ Backend is already bootstrapped, but the demo owner is not present.');
			console.warn('  The demo credentials below will NOT work — this script only seeds a FRESH local state.');
			console.warn('  Reset: stop the Worker, `rm -rf .wrangler/local-state`, then re-run `dev:backend` + `seed`.');
		}
		return;
	}

	const owner = await call('/v1/admin/bootstrap', {
		bootstrap: BOOTSTRAP_TOKEN,
		body: {
			displayName: 'Ada Lovelace',
			email: CREDS.owner.email,
			password: PW,
			device: { platform: 'web', label: 'Seed' }
		}
	}).then((r) => ({ token: r.sessionToken, principalId: r.principal.principalId }));

	async function createUser(displayName, email) {
		const inv = await call('/v1/admin/invitations', { token: owner.token, body: { displayName, email } });
		const act = await call('/v1/invitations/accept', {
			body: { token: inv.activationToken, password: PW, device: { platform: 'web', label: 'Seed' } }
		});
		return { token: act.sessionToken, principalId: act.principal.principalId, displayName };
	}

	const grace = await createUser('Grace Hopper', CREDS.user.email);
	const alan = await createUser('Alan Turing', 'alan@example.com');

	// Group mixing humans + an agent.
	const group = (
		await call('/v1/rooms/groups', {
			token: owner.token,
			body: { name: 'Billing operations', description: 'Where billing humans and agents collaborate securely.' }
		})
	).room;
	const ginv = await call(`/v1/rooms/${group.roomId}/invitations`, {
		token: owner.token,
		body: { principalId: grace.principalId, role: 'admin' }
	});
	await call(`/v1/room-invitations/${ginv.invitation.roomInvitationId}/accept`, { token: grace.token });
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
