<script lang="ts">
	import { cn } from '$lib/utils/cn';

	let { size = 'md', class: className }: { size?: 'sm' | 'md' | 'lg'; class?: string } = $props();

	const sizes = {
		sm: 'h-4 w-4 border-2',
		md: 'h-6 w-6 border-2',
		lg: 'h-9 w-9 border-[3px]'
	};
</script>

<span
	class={cn(
		'inline-block animate-spin rounded-full border-current border-t-transparent text-current',
		sizes[size],
		className
	)}
	role="status"
	aria-label="Loading"
></span>
