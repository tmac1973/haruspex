import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeToolContext } from '#lib/testing/toolContext.ts';
import { invokeRouter } from '#lib/testing/invoke.ts';
import { MAX_DRAFT_REWRITES } from '#lib/agent/tools/_drafts.ts';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	disk: new Set<string>(),
	askFileConflict: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('#lib/stores/approvalOverride.ts', () => ({ isAutoApproveActive: () => false }));
vi.mock('#lib/stores/fileConflict.svelte.ts', () => ({ askFileConflict: mocks.askFileConflict }));

const ctx = makeToolContext({ workingDir: '/w' });

beforeEach(() => {
	ctx.filesWrittenThisTurn = new Set();
	mocks.disk.clear();
	mocks.askFileConflict.mockReset();
	mocks.askFileConflict.mockResolvedValue('overwrite');
	mocks.invoke.mockReset();
	const write = (a?: Record<string, unknown>) => {
		mocks.disk.add(String(a?.relPath));
		return null;
	};
	mocks.invoke.mockImplementation(
		invokeRouter({
			fs_path_exists: (a) => mocks.disk.has(String(a?.relPath)),
			fs_write_pdf: write,
			fs_write_docx: write
		})
	);
});

async function write(args: Record<string, unknown>) {
	const { executeTool } = await import('#lib/agent/tools/index.ts');
	return executeTool('fs_write_document', args, ctx);
}

const writes = () => mocks.invoke.mock.calls.filter((c) => c[0] !== 'fs_path_exists');
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
			expect(out.result).toBe(`Wrote: ${path}`);
		}
	});

	it('writes a path with space around it under the trimmed name', async () => {
		const out = await write({ path: ' hp-research-final.pdf\n', content: DRAFT });
		expect(out.result).toBe('Wrote: hp-research-final.pdf');
		expect(writes()[0][1]).toMatchObject({ relPath: 'hp-research-final.pdf' });
	});

	it('says a missing path is missing, not that its extension is wrong', async () => {
		// What a use_tool call with the path beside `arguments` used to get.
		const out = await write({ content: DRAFT });
		expect(JSON.parse(out.result).error).toBe(
			'fs_write_document needs a path ending in .docx, .odt, .pdf.'
		);
		expect(mocks.invoke).not.toHaveBeenCalled();
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
		expect(out.result).toBe('Wrote: hp-research-final.pdf');
	});
});

describe('rewriting a document in the same turn', () => {
	it('rewrites a document the turn created when it keeps its title', async () => {
		await write({ path: 'hp-research.pdf', content: DRAFT });
		const out = await write({ path: 'hp-research.pdf', content: SHORTER });
		expect(out.result).toBe('Wrote: hp-research.pdf');
		expect(writes()[1][1]).toMatchObject({ relPath: 'hp-research.pdf', overwrite: true });
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
			expect(out.result).toBe('Wrote: r.pdf');
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
		mocks.invoke.mockImplementation(
			invokeRouter({
				fs_path_exists: (a) => mocks.disk.has(String(a?.relPath)),
				fs_find_available_path: 'report (1).pdf',
				fs_write_pdf: (a) => {
					mocks.disk.add(String(a?.relPath));
					return null;
				}
			})
		);
		const first = await write({ path: 'report.pdf', content: DRAFT });
		expect(first.result).toBe('Wrote: report (1).pdf');
		const again = await write({ path: 'report (1).pdf', content: SHORTER });
		expect(again.result).toBe('Wrote: report (1).pdf');
	});

	it('starts each turn with no drafts', async () => {
		await write({ path: 'a.pdf', content: DRAFT });
		ctx.filesWrittenThisTurn = new Set();
		mocks.askFileConflict.mockResolvedValue('overwrite');
		const out = await write({ path: 'a.pdf', content: SHORTER });
		expect(out.result).toBe('Wrote: a.pdf');
		// A later turn treats the file as the user's: it asks.
		expect(mocks.askFileConflict).toHaveBeenCalledTimes(1);
	});
});
