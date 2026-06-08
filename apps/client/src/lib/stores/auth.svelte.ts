import { api, isApiError } from '$lib/api';
import type { Account, AuthResult, Device, Principal } from '$lib/api/types';
import { APP_VERSION, CLIENT_PROTOCOL_VERSION } from '$lib/config';
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
	roles = $state<string[]>([]);

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

	/** Restore a persisted session on boot, then confirm it with /v1/me. */
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
		}
		try {
			const me = await api.me();
			this.apply({
				account: me.account,
				principal: me.principal,
				device: me.device,
				roles: me.roles
			});
			saveIdentity({ ...me });
			this.status = 'authed';
		} catch (error) {
			if (isApiError(error) && error.isUnauthorized) {
				this.signOutLocal();
			} else if (!cached) {
				// Network failure with no cached identity: treat as signed out.
				this.signOutLocal();
			}
			// Network failure WITH a cache: stay optimistically authed (offline-friendly).
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
			const me = await api.me();
			this.apply({
				account: me.account,
				principal: me.principal,
				device: me.device,
				roles: me.roles
			});
			saveIdentity({ ...me });
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
		this.roles = [];
		// Roles are only on /v1/me, not the auth result.
		try {
			const me = await api.me();
			this.account = me.account;
			this.principal = me.principal;
			this.device = me.device;
			this.roles = me.roles;
		} catch {
			/* keep auth-result identity */
		}
		saveIdentity({
			account: this.account,
			principal: this.principal,
			device: this.device,
			roles: this.roles
		});
		this.status = 'authed';
	}

	private apply(identity: PersistedIdentity): void {
		this.account = identity.account;
		this.principal = identity.principal;
		this.device = identity.device;
		this.roles = identity.roles ?? [];
	}

	private signOutLocal(): void {
		clearSession();
		api.setToken(null);
		this.account = null;
		this.principal = null;
		this.device = null;
		this.roles = [];
		this.status = 'anon';
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
