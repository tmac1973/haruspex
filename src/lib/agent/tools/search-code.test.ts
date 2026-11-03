import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchChunk } from '#lib/ipc/gen/SearchChunk.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';
// Imported once, statically: the tool registry's first load takes seconds (#409).
import { executeTool } from '#lib/agent/tools/index.ts';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

const ctx = makeToolContext({ workingDir: '/work', codeMode: true });

function chunk(path: string, start: number, lines: string[], score = 1): SearchChunk {
	return {
		path,
		start_line: start,
		end_line: start + lines.length - 1,
		text: lines.join('\n'),
		score
	};
}

function answer(chunks: SearchChunk[], terms = ['grow', 'type']) {
	mocks.invoke.mockResolvedValueOnce({ terms, chunks, files_scanned: 10 });
}

beforeEach(() => mocks.invoke.mockReset());

describe('search_code', () => {
	it('formats snippets with numbered lines and names the ranking', async () => {
		answer([chunk('src/a.ts', 10, ['one', 'two']), chunk('src/b.ts', 1, ['three'])]);
		const out = await executeTool('search_code', { query: 'grow as I type' }, ctx);
		expect(out.result).toBe(
			'== src/a.ts:10-11\n10: one\n11: two\n\n== src/b.ts:1-1\n1: three\n\n(keyword ranking)'
		);
	});

	it('merges chunks in one file whose ranges touch or overlap', async () => {
		answer([
			chunk('a.ts', 31, ['c', 'd']),
			chunk('b.ts', 1, ['x']),
			chunk('a.ts', 29, ['a', 'b']),
			chunk('a.ts', 32, ['d', 'e']),
			chunk('a.ts', 50, ['far'])
		]);
		const out = await executeTool('search_code', { query: 'q' }, ctx);
		expect(out.result).toBe(
			'== a.ts:29-33\n29: a\n30: b\n31: c\n32: d\n33: e\n\n== b.ts:1-1\n1: x\n\n== a.ts:50-50\n50: far\n\n(keyword ranking)'
		);
	});

	it('shows at most six chunks', async () => {
		answer(Array.from({ length: 10 }, (_, i) => chunk(`f${i}.ts`, 1, ['x'])));
		const out = await executeTool('search_code', { query: 'q' }, ctx);
		expect(out.result.match(/^== /gm)).toHaveLength(6);
	});

	it('says when nothing matched', async () => {
		answer([], ['grow', 'type']);
		const out = await executeTool('search_code', { query: 'grow as I type' }, ctx);
		expect(out.result).toBe(
			'No matches for: grow type. Try other words, or code_grep for an identifier.\n(keyword ranking)'
		);
	});

	it('needs a working directory', async () => {
		const out = await executeTool(
			'search_code',
			{ query: 'q' },
			makeToolContext({ codeMode: true })
		);
		expect(out.result).toContain('No working directory set');
		expect(mocks.invoke).not.toHaveBeenCalled();
	});

	it('asks for 100 candidates and passes the path and WSL distro through', async () => {
		answer([]);
		await executeTool(
			'search_code',
			{ query: 'q', path: 'src' },
			makeToolContext({ workingDir: '/work', codeMode: true, wslDistro: 'Ubuntu' })
		);
		expect(mocks.invoke).toHaveBeenCalledWith('code_search_candidates', {
			root: '/work',
			query: 'q',
			path: 'src',
			limit: 100,
			wslDistro: 'Ubuntu'
		});
	});
});
