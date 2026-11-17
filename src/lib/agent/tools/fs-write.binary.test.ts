import { invoke } from '@tauri-apps/api/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeToolContext } from '#lib/testing/toolContext.ts';
import type { ToolContext } from '#lib/agent/tools/types.ts';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

beforeEach(() => {
	vi.mocked(invoke).mockReset();
});

async function write(path: string, ctx: ToolContext) {
	const { executeTool } = await import('#lib/agent/tools/index.ts');
	const out = await executeTool('fs_write_text', { path, content: '# Report\n\nText.' }, ctx);
	return out.result.startsWith('{') ? (JSON.parse(out.result).error as string) : undefined;
}

const documentsFamily = {
	id: 'documents',
	line: 'documents — write a PDF, Word or OpenDocument file, a spreadsheet or a slide deck',
	schemas: ['fs_write_document', 'fs_write_spreadsheet', 'fs_write_slides'].map((name) => ({
		type: 'function' as const,
		function: { name, description: '', parameters: {} }
	}))
};

describe('fs_write_text refuses formats it would only fill with text', () => {
	it('points Chat at the tool that builds each format', async () => {
		const ctx = makeToolContext({ workingDir: '/tmp/work' });
		expect(await write('report.pdf', ctx)).toMatch(/not a real \.pdf.*Call fs_write_document/);
		expect(await write('out/Report.DOCX', ctx)).toMatch(/Call fs_write_document/);
		expect(await write('sums.xlsx', ctx)).toMatch(/Call fs_write_spreadsheet/);
		expect(await write('deck.odp', ctx)).toMatch(/Call fs_write_slides/);
		expect(invoke).not.toHaveBeenCalled();
	});

	it('says to load the family when the turn defers it', async () => {
		const ctx = makeToolContext({
			workingDir: '/tmp/work',
			codeSessionId: 's1',
			deferredTools: [documentsFamily]
		});
		expect(await write('report.pdf', ctx)).toMatch(
			/load_tools with family "documents", then call fs_write_document through use_tool/
		);
		expect(invoke).not.toHaveBeenCalled();
	});

	it('names no tool in Shell mode', async () => {
		const ctx = makeToolContext({ workingDir: '/tmp/work', shellMode: true, codeMode: true });
		const err = await write('/home/u/report.docx', ctx);
		expect(err).toMatch(/Build it with a program instead/);
		expect(err).not.toMatch(/fs_write_document/);
	});

	it('still writes text formats', async () => {
		const ctx = makeToolContext({ workingDir: '/tmp/work' });
		vi.mocked(invoke).mockResolvedValue(false);
		for (const path of ['notes.md', 'data.csv', 'pdf', 'report.pdf.md']) {
			ctx.filesWrittenThisTurn.clear();
			expect(await write(path, ctx)).toBeUndefined();
		}
	});
});
