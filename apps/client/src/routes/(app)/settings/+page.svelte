<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		Sun, Moon, KeyRound, Smartphone, Monitor, Globe, LogOut, ShieldAlert,
		Trash2, Laptop, Info, ChevronRight, Activity, Radio
	} from '@lucide/svelte';
	import type { Device, Session } from '$lib/api/types';
	import { api, isApiError } from '$lib/api';
	import { auth, ui, toasts, realtime, sync, calls } from '$lib/stores';
	import { APP_VERSION, getApiBase, setApiBase, defaultApiBase } from '$lib/config';
	import { isTauri } from '$lib/platform';
	import { messageCodec } from '$lib/protocol/codec';
	import SectionHeader from '$lib/components/nav/SectionHeader.svelte';
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Modal from '$lib/components/ui/Modal.svelte';
	import Field from '$lib/components/ui/Field.svelte';
	import PasswordInput from '$lib/components/ui/PasswordInput.svelte';
	import StrengthMeter from '$lib/components/ui/StrengthMeter.svelte';
	import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte';
	import TextInput from '$lib/components/ui/TextInput.svelte';
	import { cn } from '$lib/utils/cn';
	import { passwordStrength } from '$lib/utils/password';
	import { formatRelativeShort } from '$lib/utils/time';

	let devices = $state<Device[]>([]);
	let sessions = $state<Session[]>([]);
	let loadingAccount = $state(true);

	let showPass = $state(false);
	let currentPass = $state('');
	let newPass = $state('');
	let confirmPass = $state('');
	let changingPass = $state(false);

	let revokeDeviceTarget = $state<Device | null>(null);
	let confirmSignOut = $state(false);
	let working = $state(false);

	let apiBase = $state(getApiBase());
	let showAdvanced = $state(false);

	async function loadAccount() {
		loadingAccount = true;
		try {
			[devices, sessions] = await Promise.all([api.listDevices(), api.listSessions()]);
		} catch {
			/* ignore */
		} finally {
			loadingAccount = false;
		}
	}

	onMount(loadAccount);

	const passReady = $derived(
		currentPass.length > 0 && passwordStrength(newPass).meetsMinimum && newPass === confirmPass
	);

	async function changePassphrase() {
		if (!passReady || changingPass) return;
		changingPass = true;
		try {
			await api.changePassword(currentPass, newPass);
			toasts.success('Passphrase updated.');
			showPass = false;
			currentPass = newPass = confirmPass = '';
		} catch (err) {
			toasts.error(isApiError(err) ? err.display : 'Could not change passphrase.');
		} finally {
			changingPass = false;
		}
	}

	async function revokeDevice() {
		if (!revokeDeviceTarget) return;
		working = true;
		try {
			await api.revokeDevice(revokeDeviceTarget.deviceId, 'user_requested');
			toasts.success('Device revoked.');
			revokeDeviceTarget = null;
			await loadAccount();
		} catch (err) {
			toasts.error(isApiError(err) ? err.display : 'Could not revoke device.');
		} finally {
			working = false;
		}
	}

	async function revokeSession(session: Session) {
		try {
			await api.revokeSession(session.sessionId);
			sessions = sessions.filter((s) => s.sessionId !== session.sessionId);
			toasts.info('Session signed out.');
		} catch (err) {
			toasts.error(isApiError(err) ? err.display : 'Could not revoke session.');
		}
	}

	function saveApiBase() {
		setApiBase(apiBase.trim() || null);
		toasts.info('API endpoint updated — signing out.');
		void auth.logout().then(() => location.reload());
	}

	async function signOut() {
		working = true;
		await auth.logout();
		await goto('/login', { replaceState: true });
	}

	function platformIcon(platform: string) {
		if (platform === 'desktop') return Laptop;
		if (/web|browser/i.test(platform)) return Globe;
		if (/ios|android|mobile|phone/i.test(platform)) return Smartphone;
		return Monitor;
	}

	function diagnosticTime(value: Date | null) {
		return value ? formatRelativeShort(value.toISOString()) : 'never';
	}

	function diagnosticDuration(value: number | null) {
		return value === null ? '—' : `${value}ms`;
	}

	function diagnosticBytes(value: number) {
		if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)} GB`;
		if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)} MB`;
		if (value >= 1_000) return `${(value / 1_000).toFixed(1)} KB`;
		return `${value} B`;
	}
	</script>

<svelte:head><title>Settings · Voyager</title></svelte:head>

<div class="flex h-full min-h-0 flex-col">
	<SectionHeader title="Settings" />
	<div class="min-h-0 flex-1 overflow-y-auto pb-[calc(var(--sab)+1.5rem)]">
		<div class="mx-auto w-full max-w-2xl space-y-6 px-4 py-5">
			<!-- Profile -->
			<section class="flex items-center gap-4 rounded-2xl border border-border bg-surface p-4">
				<Avatar name={auth.principal?.displayName} seed={auth.principal?.principalId} size="lg" badge={false} />
				<div class="min-w-0 flex-1">
					<h2 class="truncate text-lg font-semibold text-foreground">{auth.principal?.displayName ?? '—'}</h2>
					<p class="truncate text-sm text-muted">{auth.account?.email ?? 'No email'}</p>
					{#if auth.roles.length > 0}
						<div class="mt-1.5 flex flex-wrap gap-1">
							{#each auth.roles as role (role)}<Badge tone="primary">{role.replace(/_/g, ' ')}</Badge>{/each}
						</div>
					{/if}
				</div>
			</section>

			<!-- Appearance -->
			<section class="space-y-2">
				<h2 class="px-1 text-xs font-semibold uppercase tracking-wide text-faint">Appearance</h2>
				<div class="flex items-center justify-between rounded-2xl border border-border bg-surface p-4">
					<div class="flex items-center gap-3">
						{#if ui.theme === 'dark'}<Moon class="h-5 w-5 text-muted" />{:else}<Sun class="h-5 w-5 text-muted" />{/if}
						<span class="font-medium text-foreground">Theme</span>
					</div>
					<div class="inline-flex items-center gap-1 rounded-xl bg-surface-2 p-1" role="group">
						<button
							onclick={() => ui.setTheme('light')}
							class={cn('rounded-lg px-3 py-1.5 text-sm font-medium transition', ui.theme === 'light' ? 'bg-surface text-foreground shadow-sm' : 'text-muted hover:text-foreground')}
						>Light</button>
						<button
							onclick={() => ui.setTheme('dark')}
							class={cn('rounded-lg px-3 py-1.5 text-sm font-medium transition', ui.theme === 'dark' ? 'bg-surface text-foreground shadow-sm' : 'text-muted hover:text-foreground')}
						>Dark</button>
					</div>
				</div>
			</section>

			<!-- Security -->
			<section class="space-y-2">
				<h2 class="px-1 text-xs font-semibold uppercase tracking-wide text-faint">Security</h2>
				<div class="overflow-hidden rounded-2xl border border-border bg-surface">
					<button onclick={() => (showPass = true)} class="flex w-full items-center gap-3 p-4 text-left transition hover:bg-surface-2">
						<KeyRound class="h-5 w-5 text-muted" />
						<span class="flex-1 font-medium text-foreground">Change passphrase</span>
						<ChevronRight class="h-4 w-4 text-faint" />
					</button>
				</div>
				<p class="px-1 text-xs text-muted">
					Your account passphrase signs you in. It is separate from any device unlock and cannot be recovered by an administrator.
				</p>
			</section>

			<!-- Devices -->
			<section class="space-y-2">
				<h2 class="px-1 text-xs font-semibold uppercase tracking-wide text-faint">Devices</h2>
				<div class="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
					{#if loadingAccount}
						<div class="p-4 text-sm text-muted">Loading…</div>
					{:else}
						{#each devices as device (device.deviceId)}
							{@const Icon = platformIcon(device.platform)}
							{@const isCurrent = device.deviceId === auth.device?.deviceId}
							<div class="flex items-center gap-3 p-4">
								<Icon class="h-5 w-5 shrink-0 text-muted" />
								<div class="min-w-0 flex-1">
									<div class="flex items-center gap-2">
										<span class="truncate font-medium text-foreground">{device.label || device.platform}</span>
										{#if isCurrent}<Badge tone="success">This device</Badge>{/if}
									</div>
									<p class="text-xs text-faint">
										{device.platform} · added {formatRelativeShort(device.createdAt)}
									</p>
								</div>
								{#if !isCurrent}
									<button onclick={() => (revokeDeviceTarget = device)} class="grid h-9 w-9 place-items-center rounded-lg text-danger transition hover:bg-danger-soft" aria-label="Revoke device">
										<Trash2 class="h-4.5 w-4.5" />
									</button>
								{/if}
							</div>
						{/each}
					{/if}
				</div>
			</section>

			<!-- Sessions -->
			<section class="space-y-2">
				<h2 class="px-1 text-xs font-semibold uppercase tracking-wide text-faint">Active sessions</h2>
				<div class="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
					{#if loadingAccount}
						<div class="p-4 text-sm text-muted">Loading…</div>
					{:else if sessions.length === 0}
						<div class="p-4 text-sm text-muted">No active sessions.</div>
					{:else}
						{#each sessions as session (session.sessionId)}
							{@const isCurrent = session.deviceId === auth.device?.deviceId}
							<div class="flex items-center gap-3 p-4">
								<Monitor class="h-5 w-5 shrink-0 text-muted" />
								<div class="min-w-0 flex-1">
									<div class="flex items-center gap-2">
										<span class="truncate font-medium text-foreground">Session</span>
										{#if isCurrent}<Badge tone="success">Current</Badge>{/if}
									</div>
									<p class="text-xs text-faint">Last used {formatRelativeShort(session.lastUsedAt ?? session.createdAt)}</p>
								</div>
								{#if !isCurrent}
									<Button size="sm" variant="ghost" onclick={() => revokeSession(session)}>Sign out</Button>
								{/if}
							</div>
						{/each}
					{/if}
				</div>
			</section>

			<!-- About / security posture (honest) -->
			<section class="space-y-2">
				<h2 class="px-1 text-xs font-semibold uppercase tracking-wide text-faint">About</h2>
				<div class="space-y-3 rounded-2xl border border-border bg-surface p-4">
					<div class="flex items-start gap-3">
						<ShieldAlert class="mt-0.5 h-5 w-5 shrink-0 text-warning" />
						<p class="text-sm text-muted">
							<span class="font-medium text-foreground">Encryption status.</span>
							Messages travel as opaque envelopes over HTTPS. Device-to-device end-to-end
							encryption (MLS) is in development and
							<span class="font-medium text-foreground">not yet active</span> in this build
							(transport: <code class="rounded bg-surface-2 px-1 py-0.5 text-xs">{messageCodec.protocolType}</code>). Treat this as a pilot.
						</p>
					</div>
					<button onclick={() => (showAdvanced = !showAdvanced)} class="flex items-center gap-2 text-sm text-muted hover:text-foreground">
						<Info class="h-4 w-4" /> Advanced {showAdvanced ? '▴' : '▾'}
					</button>
					{#if showAdvanced}
						{#if isTauri()}
							<Field
								label="API endpoint"
								hint="Fixed in desktop builds — the app's security policy (CSP) only permits the compiled-in endpoints."
							>
								<TextInput value={getApiBase() || defaultApiBase()} readonly class="opacity-70" />
							</Field>
						{:else}
							<Field label="API endpoint" hint="Changing this signs you out.">
								<div class="flex gap-2">
									<TextInput bind:value={apiBase} placeholder={defaultApiBase()} class="flex-1" />
									<Button variant="secondary" onclick={saveApiBase}>Save</Button>
								</div>
							</Field>
						{/if}
							<div class="rounded-xl border border-border bg-surface-2 p-3">
								<div class="mb-3 flex items-center justify-between gap-3">
									<div class="flex items-center gap-2">
									<Radio class="h-4 w-4 text-muted" />
									<span class="text-sm font-medium text-foreground">Realtime diagnostics</span>
								</div>
								<Badge tone={realtime.connected ? 'success' : 'neutral'}>{realtime.state}</Badge>
							</div>
							<div class="grid gap-2 text-xs text-muted sm:grid-cols-2">
								<div class="flex justify-between gap-3">
									<span>Connected</span>
									<span class="font-medium text-foreground">{realtime.connected ? 'yes' : 'no'}</span>
								</div>
								<div class="flex justify-between gap-3">
									<span>Reconnects</span>
									<span class="font-medium text-foreground">{realtime.reconnectCount}</span>
								</div>
								<div class="flex justify-between gap-3">
									<span>Ready</span>
									<span class="font-medium text-foreground">{diagnosticTime(realtime.lastReadyAt)}</span>
								</div>
								<div class="flex justify-between gap-3">
									<span>Last event</span>
									<span class="font-medium text-foreground">{diagnosticTime(realtime.lastEventAt)}</span>
								</div>
								<div class="flex justify-between gap-3">
									<span>Last room</span>
									<span class="truncate font-medium text-foreground">{realtime.lastRoomId ?? '—'}</span>
								</div>
								<div class="flex justify-between gap-3">
									<span>Sequence</span>
									<span class="font-medium text-foreground">{realtime.lastServerSequence ?? '—'}</span>
								</div>
								<div class="flex justify-between gap-3">
									<span>Full sync</span>
									<span class="font-medium text-foreground">{diagnosticDuration(sync.lastSyncDurationMs)}</span>
								</div>
								<div class="flex justify-between gap-3">
									<span>Room sync</span>
									<span class="font-medium text-foreground">{diagnosticDuration(sync.lastRoomSyncDurationMs)}</span>
								</div>
							</div>
							{#if realtime.lastError}
								<div class="mt-3 flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">
									<Activity class="mt-0.5 h-3.5 w-3.5 shrink-0" />
									<span>{realtime.lastError}</span>
									</div>
								{/if}
							</div>
							<div class="rounded-xl border border-border bg-surface-2 p-3">
								<div class="mb-3 flex items-center justify-between gap-3">
									<div class="flex items-center gap-2">
										<Activity class="h-4 w-4 text-muted" />
										<span class="text-sm font-medium text-foreground">Call diagnostics</span>
									</div>
									<Badge tone={calls.diagnostics.active ? 'success' : 'neutral'}>{calls.mediaState}</Badge>
								</div>
								<div class="grid gap-2 text-xs text-muted sm:grid-cols-2">
									<div class="flex justify-between gap-3">
										<span>Sampled</span>
										<span class="font-medium text-foreground">{calls.diagnostics.sampledAt ? formatRelativeShort(calls.diagnostics.sampledAt) : 'never'}</span>
									</div>
									<div class="flex justify-between gap-3">
										<span>Duration</span>
										<span class="font-medium text-foreground">{diagnosticDuration(calls.diagnostics.durationMs)}</span>
									</div>
									<div class="flex justify-between gap-3">
										<span>Peer</span>
										<span class="font-medium text-foreground">{calls.diagnostics.peerConnectionState}</span>
									</div>
									<div class="flex justify-between gap-3">
										<span>ICE</span>
										<span class="font-medium text-foreground">{calls.diagnostics.iceConnectionState}</span>
									</div>
									<div class="flex justify-between gap-3">
										<span>Sent</span>
										<span class="font-medium text-foreground">{diagnosticBytes(calls.diagnostics.bytesSentEstimate)}</span>
									</div>
									<div class="flex justify-between gap-3">
										<span>Received</span>
										<span class="font-medium text-foreground">{diagnosticBytes(calls.diagnostics.bytesReceivedEstimate)}</span>
									</div>
									<div class="flex justify-between gap-3">
										<span>Candidate</span>
										<span class="font-medium text-foreground">{calls.diagnostics.candidateType ?? '—'}</span>
									</div>
									<div class="flex justify-between gap-3">
										<span>Relay</span>
										<span class="font-medium text-foreground">{calls.diagnostics.relayLikely ? 'likely' : 'no'}</span>
									</div>
									<div class="flex justify-between gap-3">
										<span>Usage report</span>
										<span class="font-medium text-foreground">{calls.diagnostics.lastUsageReportAt ? formatRelativeShort(calls.diagnostics.lastUsageReportAt) : '—'}</span>
									</div>
									<div class="flex justify-between gap-3">
										<span>RTT</span>
										<span class="font-medium text-foreground">{diagnosticDuration(calls.diagnostics.roundTripTimeMs)}</span>
									</div>
								</div>
								{#if calls.diagnostics.lastUsageReportError}
									<div class="mt-3 flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">
										<Activity class="mt-0.5 h-3.5 w-3.5 shrink-0" />
										<span>{calls.diagnostics.lastUsageReportError}</span>
									</div>
								{/if}
							</div>
						{/if}
					<p class="text-xs text-faint">Voyager · v{APP_VERSION}</p>
				</div>
			</section>

			<Button variant="danger" fullWidth size="lg" onclick={() => (confirmSignOut = true)}>
				<LogOut class="h-4.5 w-4.5" /> Sign out
			</Button>
		</div>
	</div>
</div>

<!-- Change passphrase -->
<Modal bind:open={showPass} title="Change passphrase">
	<div class="space-y-4">
		<Field label="Current passphrase">
			<PasswordInput bind:value={currentPass} autocomplete="current-password" placeholder="Current passphrase" />
		</Field>
		<Field label="New passphrase">
			<PasswordInput bind:value={newPass} autocomplete="new-password" placeholder="New passphrase" />
		</Field>
		<StrengthMeter value={newPass} />
		<Field label="Confirm new passphrase" error={confirmPass && newPass !== confirmPass ? 'Passphrases do not match.' : null}>
			<PasswordInput bind:value={confirmPass} autocomplete="new-password" placeholder="Re-enter new passphrase" invalid={!!confirmPass && newPass !== confirmPass} />
		</Field>
	</div>
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (showPass = false)}>Cancel</Button>
		<Button loading={changingPass} disabled={!passReady} onclick={changePassphrase}>Update</Button>
	{/snippet}
</Modal>

<ConfirmDialog
	open={revokeDeviceTarget !== null}
	title="Revoke this device?"
	message={revokeDeviceTarget ? `${revokeDeviceTarget.label || revokeDeviceTarget.platform} will be signed out and blocked from syncing.` : ''}
	confirmLabel="Revoke"
	danger
	loading={working}
	onConfirm={revokeDevice}
/>
<ConfirmDialog
	bind:open={confirmSignOut}
	title="Sign out?"
	message="You’ll need your passphrase to sign back in."
	confirmLabel="Sign out"
	danger
	loading={working}
	onConfirm={signOut}
/>
