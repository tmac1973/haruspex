/**
 * The file `email_compose` attaches: a notebook (or one card of it) exported
 * as a PDF, Word, OpenDocument, web page or Markdown file, or the file a
 * file or picture card holds. It is staged before the review dialog opens,
 * where the user can still remove it.
 */
import * as api from '#lib/notebooks/api.ts';
import { fileUrl } from '#lib/notebooks/api.ts';
import { fullNotebook, notebookFile, type NotebookFormat } from '#lib/notebooks/export.ts';
import { scoped, shareTitle } from '#lib/notebooks/share.ts';
import { MAX_MESSAGE_BYTES, formatSize, stagePart, type StagedFile } from '#lib/email/parts.ts';
import { resolveNotebook, str } from '#lib/agent/tools/_notebookShared.ts';

/** The formats `notebook_format` takes, first the default. */
export const ATTACH_FORMATS = ['pdf', 'docx', 'odt', 'html', 'markdown'] as const;

type File = { name: string; mime: string; bytes: Uint8Array };

/** The file a file or picture card holds. */
async function cardFile(card: api.NotebookCard): Promise<File> {
	const m = api.parseMeta<{ hash?: string; name?: string; mime?: string }>(card.meta);
	if (!m.hash) throw new Error(`Card ${card.id} holds no file.`);
	const r = await fetch(fileUrl(m.hash));
	if (!r.ok) throw new Error(`${m.name ?? 'The file'} couldn't be read.`);
	return {
		name: m.name ?? 'file',
		mime: m.mime || 'application/octet-stream',
		bytes: new Uint8Array(await r.arrayBuffer())
	};
}

/**
 * Build and stage the attachment the arguments ask for: null when they ask
 * for none, a string when they are wrong.
 */
export async function composeAttachment(
	args: Record<string, unknown>
): Promise<StagedFile | null | string> {
	const notebookRef = str(args.attach_notebook).trim();
	const cardId = str(args.attach_card).trim();
	if (!notebookRef && !cardId) return null;
	const format = (str(args.notebook_format).trim() || 'pdf') as NotebookFormat;
	if (!(ATTACH_FORMATS as readonly string[]).includes(format)) {
		return `notebook_format must be one of ${ATTACH_FORMATS.join(', ')}.`;
	}

	let card: api.NotebookCard | undefined;
	let notebookId: string;
	if (cardId) {
		card = await api.getCard(cardId);
		if (card.deleted_at !== null) return `Card ${cardId} is in Trash.`;
		notebookId = card.notebook_id;
	} else {
		notebookId = (await resolveNotebook(notebookRef)).id;
	}

	let file: File;
	if (card && (card.kind === 'attachment' || card.kind === 'image')) {
		file = await cardFile(card);
	} else {
		const full = scoped(await fullNotebook(notebookId), card);
		file = await notebookFile(full, shareTitle(full, card), format);
	}
	if (file.bytes.length > MAX_MESSAGE_BYTES) {
		return `${file.name} is ${formatSize(file.bytes.length)}, more than an email can carry (${formatSize(MAX_MESSAGE_BYTES)}).`;
	}
	const partId = await stagePart(file.name, file.mime, file.bytes);
	return { partId, name: file.name, mime: file.mime, size: file.bytes.length };
}
