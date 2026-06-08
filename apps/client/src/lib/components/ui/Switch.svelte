<script lang="ts">
	import { Switch } from 'bits-ui';

	let {
		checked = $bindable(false),
		disabled = false,
		'aria-label': ariaLabel
	}: { checked?: boolean; disabled?: boolean; 'aria-label'?: string } = $props();
</script>

<Switch.Root
	bind:checked
	{disabled}
	aria-label={ariaLabel}
	class="inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full bg-border-strong transition-colors outline-none focus-visible:ring-4 focus-visible:ring-primary/20 data-[state=checked]:bg-primary disabled:cursor-not-allowed disabled:opacity-50"
>
	<Switch.Thumb
		class="pointer-events-none block h-5 w-5 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-[22px]"
	/>
</Switch.Root>
