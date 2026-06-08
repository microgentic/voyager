<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import { cn } from '$lib/utils/cn';
	import Spinner from './Spinner.svelte';

	type Variant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'subtle' | 'danger';
	type Size = 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm';

	interface Props extends Omit<HTMLButtonAttributes, 'class'> {
		variant?: Variant;
		size?: Size;
		loading?: boolean;
		fullWidth?: boolean;
		href?: string;
		class?: string;
		children?: Snippet;
	}

	let {
		variant = 'primary',
		size = 'md',
		loading = false,
		fullWidth = false,
		href,
		class: className,
		disabled,
		children,
		...rest
	}: Props = $props();

	const base =
		'relative inline-flex items-center justify-center gap-2 font-medium whitespace-nowrap select-none transition-[background-color,box-shadow,transform,color,opacity] duration-150 active:scale-[.98] disabled:pointer-events-none disabled:opacity-50';

	const variants: Record<Variant, string> = {
		primary: 'bg-primary text-primary-foreground hover:bg-primary-hover shadow-sm',
		secondary: 'bg-surface-2 text-foreground hover:bg-surface-3 border border-border',
		outline: 'border border-border-strong text-foreground hover:bg-surface-2',
		ghost: 'text-foreground hover:bg-surface-2',
		subtle: 'bg-primary-soft text-primary hover:brightness-105 dark:hover:brightness-110',
		danger: 'bg-danger text-danger-foreground hover:brightness-110 shadow-sm'
	};

	const sizes: Record<Size, string> = {
		sm: 'h-8 px-3 text-[13px] rounded-lg',
		md: 'h-10 px-4 text-sm rounded-xl',
		lg: 'h-12 px-5 text-[15px] rounded-xl',
		icon: 'h-10 w-10 rounded-xl',
		'icon-sm': 'h-8 w-8 rounded-lg'
	};

	const classes = $derived(
		cn(base, variants[variant], sizes[size], fullWidth && 'w-full', className)
	);
</script>

{#if href}
	<a {href} class={classes} aria-disabled={disabled} {...rest as Record<string, unknown>}>
		{#if loading}<Spinner size="sm" />{/if}
		{@render children?.()}
	</a>
{:else}
	<button class={classes} disabled={disabled || loading} {...rest}>
		{#if loading}<Spinner size="sm" />{/if}
		{@render children?.()}
	</button>
{/if}
