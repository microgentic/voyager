<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { ShieldCheck } from '@lucide/svelte';
	import { isApiError } from '$lib/api';
	import { auth } from '$lib/stores';
	import { Button, Field, PasswordInput, StrengthMeter, TextInput } from '$lib/components/ui';
	import { MIN_PASSWORD_LENGTH, passwordStrength } from '$lib/utils/password';

	let token = $state(page.url.searchParams.get('token') ?? '');
	let password = $state('');
	let confirm = $state('');
	let loading = $state(false);
	let error = $state<string | null>(null);

	const ready = $derived(
		token.trim().length >= 20 &&
			passwordStrength(password).meetsMinimum &&
			password === confirm
	);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!ready || loading) return;
		loading = true;
		error = null;
		try {
			await auth.activate(token.trim(), password);
			await goto('/app', { replaceState: true });
		} catch (err) {
			error = isApiError(err) ? err.display : 'Activation failed. Check your token and try again.';
		} finally {
			loading = false;
		}
	}
</script>

<svelte:head><title>Activate · Voyager</title></svelte:head>

<form onsubmit={submit} class="space-y-5">
	<div>
		<h2 class="text-lg font-semibold text-foreground">Activate your account</h2>
		<p class="mt-0.5 text-sm text-muted">
			Use the invitation you received and choose a passphrase.
		</p>
	</div>

	<Field label="Activation token" for="token">
		<TextInput id="token" bind:value={token} placeholder="vgr_…" autocapitalize="off" spellcheck={false} />
	</Field>

	<Field label="New passphrase" for="password" hint="At least {MIN_PASSWORD_LENGTH} characters.">
		<PasswordInput id="password" bind:value={password} autocomplete="new-password" placeholder="Choose a strong passphrase" />
	</Field>
	<StrengthMeter value={password} />

	<Field
		label="Confirm passphrase"
		for="confirm"
		error={confirm && password !== confirm ? 'Passphrases do not match.' : null}
	>
		<PasswordInput
			id="confirm"
			bind:value={confirm}
			autocomplete="new-password"
			placeholder="Re-enter passphrase"
			invalid={!!confirm && password !== confirm}
		/>
	</Field>

	<div class="flex gap-2.5 rounded-xl bg-surface-2 p-3 text-xs text-muted">
		<ShieldCheck class="mt-0.5 h-4 w-4 shrink-0 text-primary" />
		<p>
			Your passphrase unlocks this account. Messages and media are protected in transit and
			gated by room membership while MLS end-to-end encryption is in development. It is never
			sent to anyone and <strong class="font-semibold text-foreground">cannot be recovered</strong> — store it safely.
		</p>
	</div>

	{#if error}
		<p class="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>
	{/if}

	<Button type="submit" fullWidth size="lg" {loading} disabled={!ready}>
		Activate &amp; continue
	</Button>

	<p class="text-center text-sm text-muted">
		Already activated? <a href="/login" class="font-medium text-primary hover:underline">Sign in</a>
	</p>
</form>
