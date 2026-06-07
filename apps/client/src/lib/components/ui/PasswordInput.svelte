<script lang="ts">
	import { Eye, EyeOff } from '@lucide/svelte';
	import TextInput from './TextInput.svelte';

	let {
		value = $bindable(''),
		placeholder = '',
		autocomplete = 'current-password',
		invalid = false,
		id
	}: {
		value?: string;
		placeholder?: string;
		autocomplete?: 'current-password' | 'new-password' | 'off';
		invalid?: boolean;
		id?: string;
	} = $props();

	let show = $state(false);
</script>

<TextInput
	bind:value
	{id}
	type={show ? 'text' : 'password'}
	{placeholder}
	{autocomplete}
	{invalid}
	autocapitalize="off"
	autocorrect="off"
	spellcheck={false}
>
	{#snippet trailing()}
		<button
			type="button"
			tabindex="-1"
			onclick={() => (show = !show)}
			class="grid h-8 w-8 place-items-center rounded-lg text-faint transition hover:text-foreground"
			aria-label={show ? 'Hide password' : 'Show password'}
		>
			{#if show}<EyeOff class="h-4.5 w-4.5" />{:else}<Eye class="h-4.5 w-4.5" />{/if}
		</button>
	{/snippet}
</TextInput>
