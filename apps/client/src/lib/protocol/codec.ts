import type { ProtocolType } from '$lib/api/types';

/*
 * Message protocol boundary.
 *
 * The master plan calls for an "application-owned protocol abstraction so UI and
 * transport do not depend on concrete protocol types". This is that seam.
 *
 * The backend stores message `ciphertext` opaquely. The real end-to-end
 * encryption (MLS/OpenMLS via the Rust client core) is deferred per the
 * backend-first deviation, so the codec shipped today is `OpaqueTestCodec`:
 * it serializes the application payload (master plan §4.12) and base64-encodes
 * it into `ciphertext` with `protocolType: "opaque-test"`. THIS IS NOT
 * ENCRYPTION — it is a transport encoding that keeps the UI honest about the
 * envelope shape. When the Rust MLS core lands, an `MlsCodec` implements this
 * same interface and the UI/stores change nothing.
 */

export type RenderableContentType = 'text/plain' | 'text/markdown';

export interface AttachmentRef {
	attachmentId: string;
	name: string;
	mediaType: string;
	bytes: number;
	sha256?: string | null;
	width?: number;
	height?: number;
}

export interface MessageContent {
	contentType: RenderableContentType;
	body: string;
	replyToMessageId?: string | null;
	attachments?: AttachmentRef[];
}

export interface EncodeContext {
	senderPrincipalId: string;
	createdAt?: string;
}

export interface DecodedMessage extends MessageContent {
	schemaVersion: number;
	senderPrincipalId: string | null;
	createdAt: string | null;
	/** True when the ciphertext could not be parsed by this codec. */
	undecodable: boolean;
}

export interface EncodedEnvelope {
	ciphertext: string;
	protocolType: ProtocolType;
}

export interface MessageCodec {
	readonly protocolType: ProtocolType;
	readonly secure: boolean;
	encode(content: MessageContent, ctx: EncodeContext): Promise<EncodedEnvelope>;
	decode(ciphertext: string, protocolType: ProtocolType): Promise<DecodedMessage>;
}

interface WirePayload {
	schema_version: number;
	content_type: string;
	body: string;
	reply_to_message_id: string | null;
	attachments: AttachmentRef[];
	client_metadata: { sender_principal_id: string; created_at: string };
}

const SCHEMA_VERSION = 1;

function utf8ToBase64(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function base64ToUtf8(value: string): string {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return new TextDecoder().decode(bytes);
}

function normalizeContentType(value: unknown): RenderableContentType {
	return value === 'text/markdown' ? 'text/markdown' : 'text/plain';
}

export class OpaqueTestCodec implements MessageCodec {
	readonly protocolType: ProtocolType = 'opaque-test';
	readonly secure = false;

	async encode(content: MessageContent, ctx: EncodeContext): Promise<EncodedEnvelope> {
		const payload: WirePayload = {
			schema_version: SCHEMA_VERSION,
			content_type: content.contentType,
			body: content.body,
			reply_to_message_id: content.replyToMessageId ?? null,
			attachments: content.attachments ?? [],
			client_metadata: {
				sender_principal_id: ctx.senderPrincipalId,
				created_at: ctx.createdAt ?? new Date().toISOString()
			}
		};
		return { ciphertext: utf8ToBase64(JSON.stringify(payload)), protocolType: this.protocolType };
	}

	async decode(ciphertext: string, _protocolType: ProtocolType): Promise<DecodedMessage> {
		try {
			const json = JSON.parse(base64ToUtf8(ciphertext)) as Partial<WirePayload>;
			if (typeof json !== 'object' || json === null || typeof json.body !== 'string') {
				throw new Error('unexpected payload');
			}
			return {
				schemaVersion: typeof json.schema_version === 'number' ? json.schema_version : 1,
				contentType: normalizeContentType(json.content_type),
				body: json.body,
				replyToMessageId: json.reply_to_message_id ?? null,
				attachments: Array.isArray(json.attachments) ? json.attachments : [],
				senderPrincipalId: json.client_metadata?.sender_principal_id ?? null,
				createdAt: json.client_metadata?.created_at ?? null,
				undecodable: false
			};
		} catch {
			// Legacy/smoke payloads or future protocols this codec doesn't speak.
			return {
				schemaVersion: 0,
				contentType: 'text/plain',
				body: ciphertext,
				replyToMessageId: null,
				attachments: [],
				senderPrincipalId: null,
				createdAt: null,
				undecodable: true
			};
		}
	}
}

/** The codec the app uses today. Swap here when the MLS core lands. */
export const messageCodec: MessageCodec = new OpaqueTestCodec();
