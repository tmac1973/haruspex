import type { ToolContext, ToolExecOutput } from '#lib/agent/tools/types.ts';
import { canRewriteDraft, noteDraftPreview } from '#lib/agent/tools/_drafts.ts';
import { DOCUMENT_SHEETS } from '#lib/slides/sheets.ts';
import { errMessage } from '#lib/utils/error.ts';

/**
 * The preview `fs_write_document` shows a model that can see images: the PDF
 * it just wrote, its pages drawn four to a contact sheet. Nothing measures a
 * finished page as well as looking at it: a heading left at the foot of a
 * page, a table squeezed narrow, a picture too small, or more pages than the
 * user asked for. The model may write the document again to fix it
 * (`_drafts.ts`), as a deck it was shown (`slides/preview.ts`).
 */

export interface PdfPreview {
	/** Contact sheets, as JPEG data URLs. */
	sheets: string[];
	shown: number;
	total: number;
}

/** Draw the PDF as sheets; null when that fails, since it was written either way. */
export async function previewPdf(bytes: Uint8Array): Promise<PdfPreview | null> {
	try {
		const { renderPdfSheets } = await import('#lib/agent/pdfRender.ts');
		// pdf.js may take the buffer for its worker: hand it a copy.
		return await renderPdfSheets(bytes.slice(), DOCUMENT_SHEETS);
	} catch (e) {
		console.warn(`PDF preview failed: ${errMessage(e)}`);
		return null;
	}
}

/** What the tool result says alongside the sheets. */
export function pdfPreviewText(preview: PdfPreview, relPath: string, canRewrite: boolean): string {
	const which =
		preview.shown < preview.total
			? `pages 1–${preview.shown} of ${preview.total}`
			: preview.total === 1
				? 'its page'
				: `all ${preview.total} pages`;
	const fix = canRewrite
		? `If something needs fixing, write the whole document again to "${relPath}", starting with the same first line.`
		: `It has been rewritten as many times as it can be this turn, so tell the user what still needs fixing.`;
	return (
		`\nThe sheets show ${which} as printed, numbered. Check for a heading alone at the foot ` +
		`of a page, a table too narrow to read, a picture missing or too small, and a page ` +
		`left mostly empty. If the user asked for a length, check the page count. ${fix} ` +
		`If they look right, say so briefly.`
	);
}

/**
 * After a PDF is written: when the model can see images and has none
 * waiting, hand it the pages, saying so in the result. Otherwise, or when
 * drawing them fails, the result is left as it was.
 */
export async function attachPdfPreview(
	out: ToolExecOutput,
	ctx: ToolContext,
	path: string,
	bytes: Uint8Array
): Promise<ToolExecOutput> {
	if (!out.result.startsWith('Wrote:')) return out;
	// One batch of images at a time: more crashes the inference server
	// (see fs_read_pdf_pages).
	if (ctx.visionSupported === false || ctx.pendingImages.length > 0) return out;
	const preview = await previewPdf(bytes);
	if (!preview) return out;
	preview.sheets.forEach((dataUrl, i) => {
		ctx.pendingImages.push({ path: `${path}#sheet${i + 1}`, dataUrl });
	});
	noteDraftPreview(ctx.filesWrittenThisTurn, path);
	out.result += pdfPreviewText(preview, path, canRewriteDraft(ctx.filesWrittenThisTurn, path));
	return out;
}
