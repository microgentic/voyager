<script lang="ts">
	import { page } from '$app/state';
	import { sections } from './sections';
	import { invitations, threads } from '$lib/stores';
	import { cn } from '$lib/utils/cn';

	const path = $derived(page.url.pathname);
</script>

<nav
	class="flex shrink-0 items-stretch border-t border-border bg-surface/95 pb-safe backdrop-blur-xl"
>
	{#each sections as section (section.id)}
		{@const active = section.match(path)}
		{@const Icon = section.icon}
		<a
			href={section.href}
			aria-current={active ? 'page' : undefined}
			class={cn(
				'relative flex flex-1 flex-col items-center gap-1 pb-1.5 pt-2 text-[11px] font-medium transition tap-highlight-none',
				active ? 'text-primary' : 'text-muted'
			)}
		>
			<span class="relative">
				<Icon class="h-6 w-6" strokeWidth={active ? 2.5 : 2} />
				{#if section.badge === 'invites' && invitations.count > 0}
					<span
						class="absolute -right-2.5 -top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[9px] font-bold text-primary-foreground"
					>
						{invitations.count}
					</span>
				{/if}
				{#if section.badge === 'threads' && threads.unreadCount > 0}
					<span
						class="absolute -right-2.5 -top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[9px] font-bold text-primary-foreground"
					>
						{threads.unreadCount}
					</span>
				{/if}
			</span>
			{section.label}
		</a>
	{/each}
</nav>
