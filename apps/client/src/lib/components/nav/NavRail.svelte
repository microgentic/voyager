<script lang="ts">
	import { page } from '$app/state';
	import { Moon, Sun, SquarePen } from '@lucide/svelte';
	import { sections } from './sections';
	import { auth, invitations, ui } from '$lib/stores';
	import { compose } from '$lib/stores/compose.svelte';
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import { cn } from '$lib/utils/cn';

	const path = $derived(page.url.pathname);
</script>

<nav
	class="flex w-[76px] shrink-0 flex-col items-center gap-1 border-r border-border bg-surface py-3 pt-[calc(var(--sat)+0.75rem)]"
>
	<a href="/app" class="mb-1 grid h-11 w-11 place-items-center" aria-label="Voyager">
		<img src="/favicon.svg" alt="Voyager" class="h-9 w-9 rounded-[12px]" />
	</a>

	<button
		onclick={() => compose.open()}
		title="New conversation"
		aria-label="New conversation"
		class="mb-1 grid h-11 w-11 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm transition hover:bg-primary-hover active:scale-95"
	>
		<SquarePen class="h-5 w-5" />
	</button>

	{#each sections as section (section.id)}
		{@const active = section.match(path)}
		{@const Icon = section.icon}
		<a
			href={section.href}
			title={section.label}
			aria-label={section.label}
			aria-current={active ? 'page' : undefined}
			class={cn(
				'relative grid h-12 w-12 place-items-center rounded-xl transition',
				active ? 'bg-primary-soft text-primary' : 'text-muted hover:bg-surface-2 hover:text-foreground'
			)}
		>
			<Icon class="h-[22px] w-[22px]" strokeWidth={active ? 2.4 : 2} />
			{#if section.badge === 'invites' && invitations.count > 0}
				<span
					class="absolute -right-0.5 -top-0.5 grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground"
				>
					{invitations.count}
				</span>
			{/if}
			{#if active}
				<span class="absolute -left-3 h-6 w-1 rounded-r-full bg-primary"></span>
			{/if}
		</a>
	{/each}

	<div class="mt-auto flex flex-col items-center gap-1">
		<button
			onclick={() => ui.toggleTheme()}
			title="Toggle theme"
			aria-label="Toggle theme"
			class="grid h-12 w-12 place-items-center rounded-xl text-muted transition hover:bg-surface-2 hover:text-foreground"
		>
			{#if ui.theme === 'dark'}<Sun class="h-5 w-5" />{:else}<Moon class="h-5 w-5" />{/if}
		</button>
		<a
			href="/settings"
			title="You"
			aria-label="Your profile and settings"
			class={cn(
				'grid h-12 w-12 place-items-center rounded-xl ring-2 ring-transparent transition',
				path.startsWith('/settings') && 'ring-primary'
			)}
		>
			<Avatar name={auth.principal?.displayName} seed={auth.principal?.principalId} size="sm" badge={false} />
		</a>
	</div>
</nav>
