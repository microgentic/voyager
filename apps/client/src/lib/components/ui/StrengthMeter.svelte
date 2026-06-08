<script lang="ts">
	import { passwordStrength } from '$lib/utils/password';
	import { cn } from '$lib/utils/cn';

	let { value }: { value: string } = $props();

	const strength = $derived(passwordStrength(value));
	const colors = ['bg-danger', 'bg-danger', 'bg-warning', 'bg-primary', 'bg-success'];
</script>

{#if value}
	<div class="flex items-center gap-2">
		<div class="flex flex-1 gap-1">
			{#each [1, 2, 3, 4] as level (level)}
				<span
					class={cn(
						'h-1 flex-1 rounded-full transition-colors',
						level <= strength.score ? colors[strength.score] : 'bg-border'
					)}
				></span>
			{/each}
		</div>
		<span class={cn('w-16 text-right text-xs', strength.meetsMinimum ? 'text-muted' : 'text-danger')}>
			{strength.label}
		</span>
	</div>
{/if}
