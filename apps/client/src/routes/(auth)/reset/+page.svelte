<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { KeyRound } from '@lucide/svelte';
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
			await auth.completeReset(token.trim(), password);
			await goto('/app', { replaceState: true });
		} catch (err) {
			error = isApiError(err) ? err.display : 'Reset failed. The token may be expired.';
		} finally {
			loading = false;
		}
	}
</script>

<svelte:head><title>Reset access · Voyager</title></svelte:head>

<form onsubmit={submit} class="space-y-5">
	<div>
		<h2 class="text-lg font-semibold text-foreground">Reset your access</h2>
		<p class="mt-0.5 text-sm text-muted">
			Complete the reset issued by your administrator with a new passphrase.
		</p>
	</div>

	<Field label="Reset token" for="token">
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
		<KeyRound class="mt-0.5 h-4 w-4 shrink-0 text-warning" />
		<p>
			A reset restores account access only. It <strong class="font-semibold text-foreground"
				>cannot decrypt earlier messages</strong
			> stored on a device you no longer have.
		</p>
	</div>

	{#if error}
		<p class="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>
	{/if}

	<Button type="submit" fullWidth size="lg" {loading} disabled={!ready}>Reset &amp; sign in</Button>

	<p class="text-center text-sm text-muted">
		Remembered it? <a href="/login" class="font-medium text-primary hover:underline">Sign in</a>
	</p>
</form>
