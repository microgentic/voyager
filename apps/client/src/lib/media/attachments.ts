import type { Attachment, AttachmentMediaKind, AttachmentVariantName } from '$lib/api/types';
import type { AttachmentRef, AttachmentRefVariant } from '$lib/protocol/codec';

export interface AttachmentVariantUpload {
	variant: AttachmentVariantName;
	blob: Blob;
	mimeType: string;
	bytes: number;
	width: number | null;
	height: number | null;
}

export interface AttachmentUploadPlan {
	file: File;
	mediaKind: AttachmentMediaKind;
	contentCategory: string;
	originalFilename: string;
	declaredMimeType: string;
	width: number | null;
	height: number | null;
	durationMs: number | null;
	expectedBytes: number;
	variants: AttachmentVariantUpload[];
	variantManifest: {
		source: {
			name: string;
			bytes: number;
			mimeType: string;
		};
		variants: Record<string, { bytes: number; mimeType: string; width: number | null; height: number | null }>;
	};
}

const STATIC_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);

export function mediaKindForFile(file: File): AttachmentMediaKind {
	if (file.type.startsWith('image/')) return 'image';
	if (file.type.startsWith('video/')) return 'video';
	if (file.type.startsWith('audio/')) return 'audio';
	if (file.type) return 'file';
	return 'unknown';
}

export async function buildAttachmentUploadPlan(file: File): Promise<AttachmentUploadPlan> {
	if (isOptimizableImage(file)) {
		const image = await imagePlan(file).catch(() => null);
		if (image) return image;
	}
	return filePlan(file);
}

export function attachmentRefFromUpload(
	attachment: Attachment,
	plan: AttachmentUploadPlan,
): AttachmentRef {
	const original = attachment.variants.original;
	const variants: AttachmentRef['variants'] = {
		original: variantRef(original, plan)
	};
	if (attachment.variants.preview) variants.preview = variantRef(attachment.variants.preview, plan);
	if (attachment.variants.thumbnail) variants.thumbnail = variantRef(attachment.variants.thumbnail, plan);
	return {
		attachmentId: attachment.attachmentId,
		name: attachment.originalFilename ?? plan.originalFilename,
		mediaType: attachment.declaredMimeType ?? plan.declaredMimeType,
		mediaKind: attachment.mediaKind,
		bytes: original.bytes ?? plan.variants.find((item) => item.variant === 'original')?.bytes ?? plan.file.size,
		width: attachment.width ?? plan.width ?? undefined,
		height: attachment.height ?? plan.height ?? undefined,
		durationMs: attachment.durationMs ?? plan.durationMs ?? undefined,
		variants
	};
}

export function pickLocalPreviewVariant(plan: AttachmentUploadPlan): AttachmentVariantUpload {
	return (
		plan.variants.find((item) => item.variant === 'thumbnail') ??
		plan.variants.find((item) => item.variant === 'preview') ??
		plan.variants[0]
	);
}

function isOptimizableImage(file: File): boolean {
	return STATIC_IMAGE_TYPES.has(file.type);
}

async function imagePlan(file: File): Promise<AttachmentUploadPlan> {
	const bitmap = await createImageBitmap(file);
	try {
		const outputType = await preferredImageOutputType(file.type);
		const original = await renderImageVariant(file, bitmap, {
			variant: 'original',
			maxDimension: 1600,
			mimeType: outputType,
			quality: 0.84
		});
		const preview = await renderImageVariant(file, bitmap, {
			variant: 'preview',
			maxDimension: 1024,
			mimeType: outputType,
			quality: 0.8
		});
		const thumbnail = await renderImageVariant(file, bitmap, {
			variant: 'thumbnail',
			maxDimension: 320,
			mimeType: outputType,
			quality: 0.72
		});
		const variants = dedupeVariants([original, preview, thumbnail]);
		const manifest = manifestFor(file, variants);
		return {
			file,
			mediaKind: 'image',
			contentCategory: 'image',
			originalFilename: file.name || 'image',
			declaredMimeType: original.mimeType,
			width: bitmap.width,
			height: bitmap.height,
			durationMs: null,
			expectedBytes: variants.reduce((sum, item) => sum + item.bytes, 0),
			variants,
			variantManifest: manifest
		};
	} finally {
		bitmap.close();
	}
}

function filePlan(file: File): AttachmentUploadPlan {
	const mimeType = file.type || 'application/octet-stream';
	const original: AttachmentVariantUpload = {
		variant: 'original',
		blob: file,
		mimeType,
		bytes: file.size,
		width: null,
		height: null
	};
	return {
		file,
		mediaKind: mediaKindForFile(file),
		contentCategory: mimeType,
		originalFilename: file.name || 'attachment',
		declaredMimeType: mimeType,
		width: null,
		height: null,
		durationMs: null,
		expectedBytes: Math.max(1, file.size),
		variants: [original],
		variantManifest: manifestFor(file, [original])
	};
}

async function renderImageVariant(
	file: File,
	bitmap: ImageBitmap,
	options: {
		variant: AttachmentVariantName;
		maxDimension: number;
		mimeType: string;
		quality: number;
	},
): Promise<AttachmentVariantUpload> {
	const { width, height } = fit(bitmap.width, bitmap.height, options.maxDimension);
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext('2d');
	if (!context) throw new Error('Canvas is unavailable');
	context.imageSmoothingEnabled = true;
	context.imageSmoothingQuality = 'high';
	context.drawImage(bitmap, 0, 0, width, height);
	const blob = await canvasBlob(canvas, options.mimeType, options.quality);
	if (
		options.variant === 'original' &&
		width === bitmap.width &&
		height === bitmap.height &&
		blob.size > file.size
	) {
		return {
			variant: 'original',
			blob: file,
			mimeType: file.type || blob.type || options.mimeType,
			bytes: file.size,
			width: bitmap.width,
			height: bitmap.height
		};
	}
	return {
		variant: options.variant,
		blob,
		mimeType: blob.type || options.mimeType,
		bytes: blob.size,
		width,
		height
	};
}

function dedupeVariants(variants: AttachmentVariantUpload[]): AttachmentVariantUpload[] {
	const original = variants[0];
	const preview = variants[1];
	const thumbnail = variants[2];
	const next = [original];
	if (
		preview &&
		preview.width !== null &&
		original.width !== null &&
		(preview.width < original.width || preview.height! < original.height!) &&
		preview.bytes < original.bytes
	) {
		next.push(preview);
	}
	const comparison = next[next.length - 1];
	if (
		thumbnail &&
		thumbnail.width !== null &&
		comparison.width !== null &&
		(thumbnail.width < comparison.width || thumbnail.height! < comparison.height!) &&
		thumbnail.bytes < comparison.bytes
	) {
		next.push(thumbnail);
	}
	return next;
}

function fit(width: number, height: number, maxDimension: number): { width: number; height: number } {
	const max = Math.max(width, height);
	if (max <= maxDimension) return { width, height };
	const scale = maxDimension / max;
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale))
	};
}

async function preferredImageOutputType(inputType: string): Promise<string> {
	if (await supportsCanvasType('image/webp')) return 'image/webp';
	if (inputType === 'image/png') return 'image/png';
	return 'image/jpeg';
}

let webpSupport: boolean | null = null;

async function supportsCanvasType(type: string): Promise<boolean> {
	if (type === 'image/webp' && webpSupport !== null) return webpSupport;
	const canvas = document.createElement('canvas');
	canvas.width = 1;
	canvas.height = 1;
	const supported = canvas.toDataURL(type).startsWith(`data:${type}`);
	if (type === 'image/webp') webpSupport = supported;
	return supported;
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => {
				if (blob) resolve(blob);
				else reject(new Error('Could not encode image'));
			},
			type,
			quality,
		);
	});
}

function manifestFor(
	file: File,
	variants: AttachmentVariantUpload[],
): AttachmentUploadPlan['variantManifest'] {
	return {
		source: {
			name: file.name || 'attachment',
			bytes: file.size,
			mimeType: file.type || 'application/octet-stream'
		},
		variants: Object.fromEntries(
			variants.map((item) => [
				item.variant,
				{
					bytes: item.bytes,
					mimeType: item.mimeType,
					width: item.width,
					height: item.height
				}
			])
		)
	};
}

function variantRef(
	variant: Attachment['variants']['original'],
	plan: AttachmentUploadPlan,
): AttachmentRefVariant {
	const local = plan.variants.find((item) => item.variant === variant.variant);
	return {
		variant: variant.variant,
		bytes: variant.bytes ?? local?.bytes ?? null,
		width: variant.width ?? local?.width ?? null,
		height: variant.height ?? local?.height ?? null,
		downloadPath: variant.downloadPath
	};
}
