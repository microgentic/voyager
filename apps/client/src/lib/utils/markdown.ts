import { marked } from 'marked';
import DOMPurify from 'dompurify';

/*
 * Safe Markdown rendering (master plan §1.20 / §4.11).
 *
 * - Raw HTML is never trusted: we parse Markdown, then hard-sanitize.
 * - Remote images and tracking pixels are blocked (no <img>).
 * - Links open externally with noopener/noreferrer; dangerous URL schemes are
 *   dropped by DOMPurify's URI policy.
 * - Code blocks render as inert text.
 * "Agents speak Markdown" is a UX convenience, not a trust signal — agent and
 * human content go through exactly the same sanitizer.
 */

const ALLOWED_TAGS = [
	'p', 'br', 'span', 'strong', 'em', 'b', 'i', 'u', 's', 'del', 'code', 'pre',
	'blockquote', 'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
	'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td'
];
const ALLOWED_ATTR = ['href', 'title', 'class', 'align', 'target', 'rel'];

let configured = false;
function ensureConfigured(): void {
	if (configured || typeof window === 'undefined') return;
	marked.setOptions({ gfm: true, breaks: true });
	DOMPurify.addHook('afterSanitizeAttributes', (node) => {
		if (node.tagName === 'A') {
			node.setAttribute('target', '_blank');
			node.setAttribute('rel', 'noopener noreferrer nofollow ugc');
		}
	});
	configured = true;
}

export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/** Render trusted-as-text Markdown into sanitized HTML. */
export function renderMarkdown(text: string): string {
	if (typeof window === 'undefined') return escapeHtml(text);
	ensureConfigured();
	const raw = marked.parse(text, { async: false }) as string;
	return DOMPurify.sanitize(raw, {
		ALLOWED_TAGS,
		ALLOWED_ATTR,
		FORBID_TAGS: ['img', 'style', 'script', 'iframe', 'form', 'input', 'svg'],
		FORBID_ATTR: ['style', 'src', 'srcset', 'onerror', 'onload'],
		ALLOW_DATA_ATTR: false
	});
}

/** Render plain text safely with autolinked URLs and preserved line breaks. */
export function renderPlainText(text: string): string {
	if (typeof window === 'undefined') return escapeHtml(text);
	ensureConfigured();
	const escaped = escapeHtml(text);
	const linked = escaped.replace(/(https?:\/\/[^\s<]+)/g, (url) => {
		const clean = url.replace(/[.,;:!?)]+$/, '');
		const trail = url.slice(clean.length);
		return `<a href="${clean}">${clean}</a>${trail}`;
	});
	const withBreaks = linked.replace(/\n/g, '<br />');
	return DOMPurify.sanitize(withBreaks, { ALLOWED_TAGS: ['a', 'br'], ALLOWED_ATTR });
}

/** Collapse Markdown to a single-line preview for conversation lists. */
export function toPreview(text: string, max = 140): string {
	const stripped = text
		.replace(/```[\s\S]*?```/g, '▢ code')
		.replace(/`([^`]+)`/g, '$1')
		.replace(/!\[[^\]]*\]\([^)]*\)/g, '🖼 image')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/^#{1,6}\s+/gm, '')
		.replace(/[*_>~]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	return stripped.length > max ? `${stripped.slice(0, max - 1)}…` : stripped;
}
