/**
 * Markdown from Chat or a notebook made ready to email: its pictures staged
 * and referred to as `cid:`, its files staged as attachments.
 *
 * Only pictures that are ours go inline: ones the user attached, ones
 * Haruspex generated, a notebook's pictures and plots. A picture from the
 * web is someone else's, so it becomes its credit with a link to where it
 * came from. A file that would take the message over the size limit is left
 * out and named in `skipped`.
 */
import type { NotebookCard, NotebookRow, NotebookDetail } from '#lib/notebooks/api.ts';
import { EMBEDDABLE, fileBytes } from '#lib/notebooks/export.ts';
import { notebookToMarkdown, type ExportFile } from '#lib/notebooks/toMarkdown.ts';
import { captionFor } from '#lib/images/caption.ts';
import type { ImageRow } from '#lib/ipc/gen/ImageRow.ts';
import { resolvedImage } from '#lib/images/resolve.svelte.ts';
import { imageSrc } from '#lib/images/url.ts';
import {
	dropParts,
	MAX_MESSAGE_BYTES,
	stagePart,
	type StagedFile,
	type StagedPicture
} from '#lib/email/parts.ts';
import { bytesToBase64 } from '#lib/utils/base64.ts';

export interface PreparedMail {
	markdown: string;
	pictures: StagedPicture[];
	attachments: StagedFile[];
	/** Files left out: too large to send, or unreadable. */
	skipped: string[];
}

const IMAGE_REF = /!\[([^\]\n]*)\]\(([^)\s]+)\)/g;

/** Collects a message's files, keeping the total under the limit. */
class Files {
	pictures: StagedPicture[] = [];
	attachments: StagedFile[] = [];
	skipped: string[] = [];
	private total = 0;

	private fits(name: string, size: number): boolean {
		if (this.total + size > MAX_MESSAGE_BYTES) {
			this.skipped.push(name);
			return false;
		}
		this.total += size;
		return true;
	}

	/** Stage a picture; its `cid:` URL, or null when it was left out. */
	async picture(name: string, mime: string, bytes: Uint8Array): Promise<string | null> {
		if (!this.fits(name, bytes.length)) return null;
		const cid = `p${this.pictures.length + 1}`;
		const partId = await stagePart(name, mime, bytes);
		const previewUrl = `data:${mime};base64,${bytesToBase64(bytes)}`;
		this.pictures.push({ partId, cid, name, mime, size: bytes.length, previewUrl });
		return `cid:${cid}`;
	}

	async attach(name: string, mime: string, bytes: Uint8Array): Promise<boolean> {
		if (!this.fits(name, bytes.length)) return false;
		const partId = await stagePart(name, mime, bytes);
		this.attachments.push({ partId, name, mime, size: bytes.length });
		return true;
	}

	ids(): string[] {
		return [...this.pictures, ...this.attachments].map((f) => f.partId);
	}

	done(markdown: string): PreparedMail {
		return {
			markdown,
			pictures: this.pictures,
			attachments: this.attachments,
			skipped: this.skipped
		};
	}
}

function dataUrlBytes(url: string): { mime: string; bytes: Uint8Array } | null {
	const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
	if (!m) return null;
	return { mime: m[1], bytes: Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)) };
}

const EXT: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/gif': 'gif',
	'image/webp': 'webp'
};
const pictureName = (n: number, mime: string) => `picture-${n}.${EXT[mime] ?? 'img'}`;

/** Stage one of our pictures; its Markdown, or its name when it was left out. */
async function ourPicture(
	files: Files,
	label: string,
	mime: string,
	bytes: Uint8Array
): Promise<string> {
	const cid = await files.picture(pictureName(files.pictures.length + 1, mime), mime, bytes);
	return cid ? `![${label}](${cid})` : `[Picture: ${label}]`;
}

async function generatedPicture(files: Files, label: string, row: ImageRow): Promise<string> {
	let bytes: Uint8Array;
	try {
		const r = await fetch(imageSrc(row.hash) ?? '');
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		bytes = new Uint8Array(await r.arrayBuffer());
	} catch (e) {
		console.warn('email: a generated picture was left out', e);
		files.skipped.push(label);
		return `[Picture: ${label}]`;
	}
	return ourPicture(files, label, row.mime, bytes);
}

/** Someone else's picture: its credit, linked to where it came from. */
function webPicture(label: string, url: string, row: ImageRow | undefined): string {
	const href = row?.description_url || row?.source_url || url;
	const caption = row ? captionFor(row) : null;
	const credit = caption ? ` (${caption.text}${caption.linkLabel})` : '';
	return /^https?:/i.test(href) ? `[Picture: ${label}${credit}](${href})` : `[Picture: ${label}]`;
}

/** One `![alt](url)` from Chat, as it goes in the email. */
function chatPicture(files: Files, alt: string, url: string): Promise<string> {
	const label = alt.trim() || 'Picture';
	const data = dataUrlBytes(url);
	if (data) return ourPicture(files, label, data.mime, data.bytes);
	const row = resolvedImage(url);
	if (row?.source === 'generated') return generatedPicture(files, label, row);
	return Promise.resolve(webPicture(label, url, row));
}

async function replaceAsync(
	text: string,
	re: RegExp,
	fn: (...m: string[]) => Promise<string>
): Promise<string> {
	const out: string[] = [];
	let last = 0;
	for (const m of text.matchAll(re)) {
		out.push(text.slice(last, m.index), await fn(...m));
		last = (m.index ?? 0) + m[0].length;
	}
	out.push(text.slice(last));
	return out.join('');
}

/** Chat Markdown (an answer, or a whole conversation) made ready to email. */
export function prepareChatMail(markdown: string): Promise<PreparedMail> {
	return collecting(async (files) =>
		replaceAsync(markdown, IMAGE_REF, (_m, alt, url) => chatPicture(files, alt, url))
	);
}

/** Run `build` with a fresh collector; on failure, drop what it staged. */
async function collecting(build: (files: Files) => Promise<string>): Promise<PreparedMail> {
	const files = new Files();
	try {
		return files.done(await build(files));
	} catch (e) {
		await dropParts(files.ids());
		throw e;
	}
}

/** A notebook (or one card of it) made ready to email. */
export async function prepareNotebookMail(full: {
	detail: NotebookDetail;
	rowsOf: (c: NotebookCard) => NotebookRow[];
}): Promise<PreparedMail> {
	return collecting(async (files) => {
		const cids = new Map<string, string>();
		for (const f of notebookToMarkdown(full.detail, { rowsOf: full.rowsOf }).files) {
			let bytes: Uint8Array;
			try {
				bytes = await fileBytes(f);
			} catch (e) {
				console.warn('email: a notebook file was left out', e);
				files.skipped.push(f.name);
				continue;
			}
			if (EMBEDDABLE.test(f.mime)) {
				const cid = await files.picture(f.name, f.mime, bytes);
				if (cid) cids.set(f.name, cid);
			} else {
				await files.attach(f.name, f.mime, bytes);
			}
		}
		const shown = (f: ExportFile) => cids.has(f.name);
		return notebookToMarkdown(full.detail, {
			rowsOf: full.rowsOf,
			fileRef: (f) => cids.get(f.name) ?? '',
			embeddable: shown,
			placeholders: (f) => !shown(f)
		}).markdown;
	});
}
