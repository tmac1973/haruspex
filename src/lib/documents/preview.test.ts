import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeToolContext } from '#lib/testing/toolContext.ts';
import { canRewriteDraft, noteDraft } from '#lib/agent/tools/_drafts.ts';
import { DOCUMENT_SHEETS } from '#lib/slides/sheets.ts';
import type { ToolExecOutput } from '#lib/agent/tools/types.ts';
import { attachPdfPreview, pdfPreviewText } from './preview';

const render = vi.hoisted(() => vi.fn());
vi.mock('#lib/agent/pdfRender.ts', () => ({ renderPdfSheets: render }));

const PDF = new TextEncoder().encode('%PDF-1.7');
let ctx = makeToolContext({ workingDir: '/w' });

beforeEach(() => {
	ctx = makeToolContext({ workingDir: '/w' });
	render.mockReset();
	render.mockResolvedValue({ sheets: ['data:one', 'data:two'], shown: 8, total: 11 });
});

const wrote = (): ToolExecOutput => ({ result: 'Wrote: r.pdf (11 pages)' });

describe('attachPdfPreview', () => {
	it('hands the model the sheets and says what to look for', async () => {
		const out = await attachPdfPreview(wrote(), ctx, 'r.pdf', PDF);
		expect(render).toHaveBeenCalledWith(PDF, DOCUMENT_SHEETS);
		// A copy: pdf.js may take the buffer it is given.
		expect(render.mock.calls[0][0]).not.toBe(PDF);
		expect(ctx.pendingImages).toEqual([
			{ path: 'r.pdf#sheet1', dataUrl: 'data:one' },
			{ path: 'r.pdf#sheet2', dataUrl: 'data:two' }
		]);
		expect(out.result).toContain('pages 1–8 of 11');
		expect(out.result).toContain('heading alone at the foot');
	});

	it('lets a document the model was shown be rewritten, though it was there before', async () => {
		const turn = ctx.filesWrittenThisTurn;
		turn.add('r.pdf');
		noteDraft(turn, 'r.pdf', ['report'], true);
		expect(canRewriteDraft(turn, 'r.pdf')).toBe(false);
		const out = await attachPdfPreview(wrote(), ctx, 'r.pdf', PDF);
		expect(canRewriteDraft(turn, 'r.pdf')).toBe(true);
		expect(out.result).toContain('write the whole document again to "r.pdf"');
	});

	it('shows nothing to a model that cannot see, or while images are waiting', async () => {
		ctx.visionSupported = false;
		expect((await attachPdfPreview(wrote(), ctx, 'r.pdf', PDF)).result).toBe(
			'Wrote: r.pdf (11 pages)'
		);
		ctx.visionSupported = true;
		ctx.pendingImages.push({ path: 'x.png', dataUrl: 'data:x' });
		await attachPdfPreview(wrote(), ctx, 'r.pdf', PDF);
		expect(render).not.toHaveBeenCalled();
	});

	it('leaves a refused write, or a preview that fails, as it was', async () => {
		const refused = { result: '{"error":"no"}' };
		expect(await attachPdfPreview(refused, ctx, 'r.pdf', PDF)).toEqual(refused);
		render.mockRejectedValue(new Error('no canvas'));
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect((await attachPdfPreview(wrote(), ctx, 'r.pdf', PDF)).result).toBe(
			'Wrote: r.pdf (11 pages)'
		);
		expect(warn).toHaveBeenCalledWith('PDF preview failed: no canvas');
		expect(ctx.pendingImages).toEqual([]);
	});
});

describe('pdfPreviewText', () => {
	it('names the pages shown', () => {
		expect(pdfPreviewText({ sheets: [], shown: 1, total: 1 }, 'a.pdf', true)).toContain(
			'show its page'
		);
		expect(pdfPreviewText({ sheets: [], shown: 3, total: 3 }, 'a.pdf', true)).toContain(
			'all 3 pages'
		);
	});

	it('says to tell the user when no rewrites are left', () => {
		const text = pdfPreviewText({ sheets: [], shown: 1, total: 1 }, 'a.pdf', false);
		expect(text).toContain('tell the user what still needs fixing');
		expect(text).not.toContain('write the whole document again');
	});
});
