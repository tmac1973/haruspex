import { invoke } from '@tauri-apps/api/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeToolContext } from '#lib/testing/toolContext.ts';
import { invokeRouter } from '#lib/testing/invoke.ts';
import { MAX_DRAFT_REWRITES } from '#lib/agent/tools/_drafts.ts';

const mocks = vi.hoisted(() => ({
	disk: new Set<string>(),
	askFileConflict: vi.fn(),
	pdf: { pages: 1, missing: new Set<string>(), landscaped: [] as string[] },
	render: vi.fn(),
	build: vi.fn()
}));

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
vi.mock('#lib/stores/approvalOverride.ts', () => ({ isAutoApproveActive: () => false }));
vi.mock('#lib/stores/fileConflict.svelte.ts', () => ({ askFileConflict: mocks.askFileConflict }));
// The PDF itself is built and tested in `documents/`; here it is bytes to write.
vi.mock('#lib/documents/pdf.ts', async (original) => ({
	landscapeNote: (await original<typeof import('#lib/documents/pdf.ts')>()).landscapeNote,
	pdfFromMarkdown: async (...args: unknown[]) => {
		mocks.build(...args);
		return {
			bytes: new TextEncoder().encode('%PDF-1.7'),
			pages: mocks.pdf.pages,
			missing: mocks.pdf.missing,
			landscaped: mocks.pdf.landscaped
		};
	}
}));

vi.mock('#lib/agent/pdfRender.ts', () => ({ renderPdfSheets: mocks.render }));

type Headers = { headers: Record<string, string> };

/** Where a write went and whether it replaced the file: a PDF says so in
 *  headers, since the file is the body; the other formats in their args. */
function sentTo(call: unknown[]): { relPath: string; overwrite: boolean } {
	if (call[0] === 'fs_write_pdf') {
		const { headers } = call[2] as Headers;
		return {
			relPath: decodeURIComponent(headers['x-rel-path']),
			overwrite: headers['x-overwrite'] === 'true'
		};
	}
	const args = call[1] as { relPath: string; overwrite: boolean };
	return { relPath: args.relPath, overwrite: args.overwrite };
}

/** Answer by command, as `invokeRouter`, with a PDF write going to disk. */
function route(routes: Parameters<typeof invokeRouter>[0]) {
	const router = invokeRouter(routes);
	return async <T>(cmd: string, args?: unknown, opts?: unknown): Promise<T> => {
		if (cmd === 'fs_write_pdf') {
			mocks.disk.add(sentTo([cmd, args, opts]).relPath);
			return null as T;
		}
		return router<T>(cmd, args as Record<string, unknown>);
	};
}

const ctx = makeToolContext({ workingDir: '/w' });

beforeEach(() => {
	ctx.filesWrittenThisTurn = new Set();
	mocks.disk.clear();
	mocks.askFileConflict.mockReset();
	mocks.askFileConflict.mockResolvedValue('overwrite');
	mocks.pdf = { pages: 1, missing: new Set(), landscaped: [] };
	// The preview has its own tests; these see it only where they turn it on.
	ctx.visionSupported = false;
	ctx.pendingImages = [];
	mocks.render.mockReset();
	mocks.render.mockResolvedValue({ sheets: ['data:sheet'], shown: 2, total: 2 });
	vi.mocked(invoke).mockReset();
	vi.mocked(invoke).mockImplementation(
		route({
			fs_path_exists: (a) => mocks.disk.has(String(a?.relPath)),
			fs_write_docx: (a) => {
				mocks.disk.add(String(a?.relPath));
				return null;
			}
		})
	);
});

async function write(args: Record<string, unknown>) {
	const { executeTool } = await import('#lib/agent/tools/index.ts');
	return executeTool('fs_write_document', args, ctx);
}

const writes = () => vi.mocked(invoke).mock.calls.filter((c) => c[0] !== 'fs_path_exists');
const DRAFT =
	'# How Heat Pumps Work\n\n## The idea\n\nThey move heat.\n\n## The cycle\n\nFour parts.';
const SHORTER = '# How Heat Pumps Work\n\n**The idea.** They move heat. **The cycle.** Four parts.';

describe('fs_write_document paths', () => {
	it('takes any path that ends in a format it writes', async () => {
		for (const path of [
			'hp-research-final.pdf',
			'a.b.c.pdf',
			'Report.PDF',
			'docs/v1.2/notes.docx'
		]) {
			const out = await write({ path, content: DRAFT });
			expect(out.result).toBe(`Wrote: ${path}${/\.pdf$/i.test(path) ? ' (1 page)' : ''}`);
		}
	});

	it('says how many pages a PDF came to (#1032: one page asked, three written)', async () => {
		mocks.pdf.pages = 3;
		expect((await write({ path: 'hp.pdf', content: DRAFT })).result).toBe(
			'Wrote: hp.pdf (3 pages)'
		);
		mocks.pdf.pages = 1;
		expect((await write({ path: 'one.pdf', content: DRAFT })).result).toBe(
			'Wrote: one.pdf (1 page)'
		);
	});

	it('sends the built PDF as the raw body, with the path in headers', async () => {
		await write({ path: 'notes/Ünïcode report.pdf', content: DRAFT });
		const [cmd, body, opts] = writes()[0];
		expect(cmd).toBe('fs_write_pdf');
		expect(new TextDecoder().decode(body as Uint8Array)).toBe('%PDF-1.7');
		expect((opts as Headers).headers).toEqual({
			'x-workdir': encodeURIComponent('/w'),
			'x-rel-path': encodeURIComponent('notes/Ünïcode report.pdf'),
			'x-overwrite': 'false'
		});
	});

	it("builds the PDF with the call's page size, style, title and contents", async () => {
		mocks.build.mockClear();
		const args = { page_size: 'A4', style: 'report', title: 'Heat Pumps', toc: true };
		await write({ path: 'hp.pdf', content: DRAFT, ...args });
		expect(mocks.build.mock.calls[0][2]).toEqual({
			pageSize: 'a4',
			style: 'report',
			title: 'Heat Pumps',
			toc: true
		});
	});

	it('refuses a style it does not have, writing nothing', async () => {
		const out = await write({ path: 'hp.pdf', content: DRAFT, style: 'fancy' });
		expect(out.result).toContain('style must be one of plain, report, letter.');
		expect(writes()).toEqual([]);
	});

	it('says which tables went on a landscape page', async () => {
		mocks.pdf.landscaped = ['Region, Q1, Q2, …'];
		const out = await write({ path: 'hp.pdf', content: DRAFT });
		expect(out.result).toBe(
			'Wrote: hp.pdf (1 page)\nA table too wide for the page is on a landscape page: (Region, Q1, Q2, …).'
		);
	});

	it('names the characters the fonts could not draw', async () => {
		mocks.pdf.missing = new Set(['漢', '🚀']);
		const out = await write({ path: 'hp.pdf', content: DRAFT });
		expect(out.result).toContain('Wrote: hp.pdf');
		expect(out.result).toContain('no glyph for 漢 🚀');
	});

	it('writes a path with space around it under the trimmed name', async () => {
		const out = await write({ path: ' hp-research-final.pdf\n', content: DRAFT });
		expect(out.result).toBe('Wrote: hp-research-final.pdf (1 page)');
		expect(sentTo(writes()[0]).relPath).toBe('hp-research-final.pdf');
	});

	it('says a missing path is missing, not that its extension is wrong', async () => {
		// What a use_tool call with the path beside `arguments` used to get.
		const out = await write({ content: DRAFT });
		expect(JSON.parse(out.result).error).toBe(
			'fs_write_document needs a path ending in .docx, .odt, .pdf.'
		);
		expect(invoke).not.toHaveBeenCalled();
	});

	it('runs a use_tool call whose path sits beside its arguments', async () => {
		const { unwrapUseTool } = await import('#lib/agent/parser.ts');
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const call = unwrapUseTool({
			id: 'c1',
			name: 'use_tool',
			arguments: {
				name: 'fs_write_document',
				arguments: { content: DRAFT },
				path: 'hp-research-final.pdf'
			}
		});
		const out = await executeTool(call.name, call.arguments, ctx);
		expect(out.result).toBe('Wrote: hp-research-final.pdf (1 page)');
	});
});

describe('rewriting a document in the same turn', () => {
	it('rewrites a document the turn created when it keeps its title', async () => {
		await write({ path: 'hp-research.pdf', content: DRAFT });
		const out = await write({ path: 'hp-research.pdf', content: SHORTER });
		expect(out.result).toBe('Wrote: hp-research.pdf (1 page)');
		expect(sentTo(writes()[1])).toEqual({ relPath: 'hp-research.pdf', overwrite: true });
		// The turn wrote it, so there is no one else's file to ask about.
		expect(mocks.askFileConflict).not.toHaveBeenCalled();
	});

	it('refuses a second write that does not start with the title, as a chunk', async () => {
		await write({ path: 'long.pdf', content: DRAFT });
		const out = await write({ path: 'long.pdf', content: '## Part two\n\nThe rest.' });
		const error = JSON.parse(out.result).error;
		expect(error).toContain('already written in this turn');
		expect(error).toContain('same first line');
		expect(writes()).toHaveLength(1);
	});

	it(`allows ${MAX_DRAFT_REWRITES} rewrites, then refuses`, async () => {
		await write({ path: 'r.pdf', content: DRAFT });
		for (let i = 0; i < MAX_DRAFT_REWRITES; i++) {
			const out = await write({ path: 'r.pdf', content: `${SHORTER} ${i}` });
			expect(out.result).toBe('Wrote: r.pdf (1 page)');
		}
		const out = await write({ path: 'r.pdf', content: SHORTER });
		const error = JSON.parse(out.result).error;
		expect(error).toContain('already written in this turn');
		expect(error).not.toContain('same first line');
		expect(error).toContain('"r-2.pdf"');
	});

	it('asks before overwriting a file that was there before the turn', async () => {
		mocks.disk.add('report.docx');
		const out = await write({ path: 'report.docx', content: DRAFT });
		expect(out.result).toBe('Wrote: report.docx');
		expect(mocks.askFileConflict).toHaveBeenCalledTimes(1);
	});

	it('still refuses a second write to a file that was there before the turn', async () => {
		mocks.disk.add('report.docx');
		await write({ path: 'report.docx', content: DRAFT });
		const out = await write({ path: 'report.docx', content: SHORTER });
		const error = JSON.parse(out.result).error;
		expect(error).toContain('already written in this turn');
		expect(error).not.toContain('same first line');
		expect(writes()).toHaveLength(1);
	});

	it('lets a copy the user kept beside the old file be revised', async () => {
		mocks.disk.add('report.pdf');
		mocks.askFileConflict.mockResolvedValue('counter');
		vi.mocked(invoke).mockImplementation(
			route({
				fs_path_exists: (a) => mocks.disk.has(String(a?.relPath)),
				fs_find_available_path: 'report (1).pdf'
			})
		);
		const first = await write({ path: 'report.pdf', content: DRAFT });
		expect(first.result).toBe('Wrote: report (1).pdf (1 page)');
		const again = await write({ path: 'report (1).pdf', content: SHORTER });
		expect(again.result).toBe('Wrote: report (1).pdf (1 page)');
	});

	it('shows a model that can see the PDF it wrote', async () => {
		ctx.visionSupported = true;
		mocks.pdf.pages = 2;
		const out = await write({ path: 'hp.pdf', content: DRAFT });
		expect(out.result).toMatch(/^Wrote: hp\.pdf \(2 pages\)\nThe sheets show all 2 pages/);
		expect(ctx.pendingImages).toEqual([{ path: 'hp.pdf#sheet1', dataUrl: 'data:sheet' }]);
	});

	it('shows nothing for a Word document', async () => {
		ctx.visionSupported = true;
		expect((await write({ path: 'hp.docx', content: DRAFT })).result).toBe('Wrote: hp.docx');
		expect(mocks.render).not.toHaveBeenCalled();
	});

	it('lets a PDF that was there before be fixed once the model has seen it', async () => {
		ctx.visionSupported = true;
		mocks.disk.add('report.pdf');
		await write({ path: 'report.pdf', content: DRAFT });
		expect(mocks.askFileConflict).toHaveBeenCalledTimes(1);
		ctx.pendingImages = [];
		const out = await write({ path: 'report.pdf', content: SHORTER });
		expect(out.result).toMatch(/^Wrote: report\.pdf/);
		// The user said to overwrite it once; the fix is not asked about again.
		expect(mocks.askFileConflict).toHaveBeenCalledTimes(1);
		expect(writes()).toHaveLength(2);
	});

	it('previews the copy the user kept beside the old file, under its own name', async () => {
		ctx.visionSupported = true;
		mocks.disk.add('report.pdf');
		mocks.askFileConflict.mockResolvedValue('counter');
		vi.mocked(invoke).mockImplementation(
			route({
				fs_path_exists: (a) => mocks.disk.has(String(a?.relPath)),
				fs_find_available_path: 'report (1).pdf'
			})
		);
		const out = await write({ path: 'report.pdf', content: DRAFT });
		expect(out.result).toContain('write the whole document again to "report (1).pdf"');
		expect(ctx.pendingImages[0].path).toBe('report (1).pdf#sheet1');
	});

	it('starts each turn with no drafts', async () => {
		await write({ path: 'a.pdf', content: DRAFT });
		ctx.filesWrittenThisTurn = new Set();
		mocks.askFileConflict.mockResolvedValue('overwrite');
		const out = await write({ path: 'a.pdf', content: SHORTER });
		expect(out.result).toBe('Wrote: a.pdf (1 page)');
		// A later turn treats the file as the user's: it asks.
		expect(mocks.askFileConflict).toHaveBeenCalledTimes(1);
	});
});
