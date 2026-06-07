<script lang="ts">
	import { goto } from '$app/navigation';
	import { Mail } from '@lucide/svelte';
	import { isApiError } from '$lib/api';
	import { auth } from '$lib/stores';
	import { Button, Field, PasswordInput, TextInput } from '$lib/components/ui';

	let email = $state('');
	let password = $state('');
	let loading = $state(false);
	let error = $state<string | null>(null);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!email.trim() || !password || loading) return;
		loading = true;
		error = null;
		try {
			await auth.login(email.trim(), password);
			await goto('/app', { replaceState: true });
		} catch (err) {
			error = isApiError(err) ? err.display : 'Sign in failed. Please try again.';
		} finally {
			loading = false;
		}
	}
</script>

<svelte:head><title>Sign in · Voyager</title></svelte:head>

<form onsubmit={submit} class="space-y-5">
	<div>
		<h2 class="text-lg font-semibold text-foreground">Welcome back</h2>
		<p class="mt-0.5 text-sm text-muted">Sign in to continue to your conversations.</p>
	</div>

	<Field label="Email" for="email">
		<TextInput
			id="email"
			bind:value={email}
			type="email"
			inputmode="email"
			autocomplete="username"
			autocapitalize="off"
			placeholder="you@example.com"
		>
			{#snippet leading()}<Mail class="h-4.5 w-4.5" />{/snippet}
		</TextInput>
	</Field>

	<Field label="Passphrase" for="password">
		<PasswordInput id="password" bind:value={password} placeholder="Your passphrase" />
	</Field>

	{#if error}
		<p class="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>
	{/if}

	<Button type="submit" fullWidth size="lg" {loading} disabled={!email.trim() || !password}>
		Sign in
	</Button>

	<div class="flex items-center justify-between pt-1 text-sm">
		<a href="/activate" class="font-medium text-primary hover:underline">Have an invitation?</a>
		<a href="/reset" class="text-muted transition hover:text-foreground">Reset access</a>
	</div>
</form>
