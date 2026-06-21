import { MessageSquare, MessagesSquare, Mailbox, Bot, Settings, type Icon } from '@lucide/svelte';

export interface NavSection {
	id: string;
	href: string;
	label: string;
	icon: typeof Icon;
	badge?: 'invites' | 'threads';
	match: (pathname: string) => boolean;
}

export const sections: NavSection[] = [
	{
		id: 'chats',
		href: '/app',
		label: 'Chats',
		icon: MessageSquare,
		match: (p) => p === '/app' || p.startsWith('/app/')
	},
	{
		id: 'threads',
		href: '/threads',
		label: 'Threads',
		icon: MessagesSquare,
		badge: 'threads',
		match: (p) => p.startsWith('/threads')
	},
	{
		id: 'invites',
		href: '/invites',
		label: 'Invites',
		icon: Mailbox,
		badge: 'invites',
		match: (p) => p.startsWith('/invites')
	},
	{
		id: 'agents',
		href: '/agents',
		label: 'Agents',
		icon: Bot,
		match: (p) => p.startsWith('/agents')
	},
	{
		id: 'settings',
		href: '/settings',
		label: 'Settings',
		icon: Settings,
		match: (p) => p.startsWith('/settings')
	}
];
