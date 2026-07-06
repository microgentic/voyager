import { api } from '$lib/api';
import type { Account, AuthResult, BootstrapResult, Device, Principal, Session } from '$lib/api/types';
import { APP_VERSION, CLIENT_PROTOCOL_VERSION } from '$lib/config';
import { clearClientCache } from '$lib/local-cache';
import { deviceLabel, devicePlatform } from '$lib/platform';
import {
	clearSession,
	loadDeviceId,
	loadIdentity,
	loadToken,
	saveDeviceId,
	saveIdentity,
	saveToken,
	type PersistedIdentity
} from '$lib/session';
import { toasts } from './toast.svelte';

type Status = 'loading' | 'authed' | 'anon';

const ADMIN_ROLES = new Set([
	'platform_owner',
	'user_admin',
	'security_admin',
	'auditor',
	'agent_provisioner',
	'quota_operator'
]);

class AuthStore {
	status = $state<Status>('loading');
	account = $state<Account | null>(null);
	principal = $state<Principal | null>(null);
	device = $state<Device | null>(null);
	session = $state<Session | null>(null);
	roles = $state<string[]>([]);
	private pendingBootstrap: BootstrapResult | null = null;

	private resetHandlers: Array<() => void> = [];

	readonly isAdmin = $derived(this.roles.some((role) => ADMIN_ROLES.has(role)));
	readonly isAuthed = $derived(this.status === 'authed');

	constructor() {
		api.onUnauthorized = () => this.handleUnauthorized();
	}

	/** Stores call this so a sign-out clears their cached data. */
	onSignOut(handler: () => void): void {
		this.resetHandlers.push(handler);
	}

	private deviceInput(email?: string) {
		return {
			deviceId: email ? loadDeviceId(email) : undefined,
			platform: devicePlatform(),
			label: deviceLabel(),
			clientVersion: APP_VERSION,
			protocolVersion: CLIENT_PROTOCOL_VERSION
		};
	}

	/** Restore a persisted session without blocking first paint on the messaging bootstrap. */
	async init(): Promise<void> {
		const token = loadToken();
		if (!token) {
			this.status = 'anon';
			return;
		}
		api.setToken(token);
		const cached = loadIdentity();
		if (cached) {
			this.apply(cached);
			this.status = 'authed';
			void this.refresh();
			return;
		}
		try {
			const me = await api.session();
			this.apply({
				account: me.account,
				principal: me.principal,
				device: me.device,
				session: me.session,
				roles: me.roles
			});
			saveIdentity({
				account: me.account,
				principal: me.principal,
				device: me.device,
				session: me.session,
				roles: me.roles
			});
			this.status = 'authed';
		} catch {
			this.signOutLocal();
		}
	}

	async login(email: string, password: string): Promise<void> {
		const result = await api.login(email, password, this.deviceInput(email));
		await this.completeAuth(result);
	}

	async activate(token: string, password: string): Promise<void> {
		const result = await api.acceptInvitation(token, password, this.deviceInput());
		await this.completeAuth(result);
	}

	async completeReset(token: string, password: string): Promise<void> {
		const result = await api.completeReset(token, password, this.deviceInput());
		await this.completeAuth(result);
	}

	async refresh(): Promise<void> {
		try {
			const me = await api.session();
			this.apply({
				account: me.account,
				principal: me.principal,
				device: me.device,
				session: me.session,
				roles: me.roles
			});
			saveIdentity({
				account: me.account,
				principal: me.principal,
				device: me.device,
				session: me.session,
				roles: me.roles
			});
		} catch {
			/* leave current state */
		}
	}

	async logout(): Promise<void> {
		try {
			await api.logout();
		} catch {
			/* best effort */
		}
		this.signOutLocal();
	}

	private async completeAuth(result: AuthResult): Promise<void> {
		api.setToken(result.sessionToken);
		saveToken(result.sessionToken);
		saveDeviceId(result.account.email, result.device.deviceId);
		this.account = result.account;
		this.principal = result.principal;
		this.device = result.device;
		this.session = result.session;
		this.roles = [];
		saveIdentity({
			account: this.account,
			principal: this.principal,
			device: this.device,
			session: this.session,
			roles: this.roles
		});
		this.status = 'authed';
		void this.refresh();
	}

	consumeBootstrap(): BootstrapResult | null {
		const bootstrap = this.pendingBootstrap;
		this.pendingBootstrap = null;
		return bootstrap;
	}

	private apply(identity: PersistedIdentity): void {
		this.account = identity.account;
		this.principal = identity.principal;
		this.device = identity.device;
		this.session = identity.session ?? null;
		this.roles = identity.roles ?? [];
	}

	private signOutLocal(): void {
		clearSession();
		api.setToken(null);
		this.account = null;
		this.principal = null;
		this.device = null;
		this.session = null;
		this.roles = [];
		this.pendingBootstrap = null;
		this.status = 'anon';
		void clearClientCache();
		for (const handler of this.resetHandlers) handler();
	}

	private handleUnauthorized(): void {
		if (this.status === 'authed') {
			this.signOutLocal();
			toasts.error('Your session expired. Please sign in again.');
		}
	}
}

export const auth = new AuthStore();
