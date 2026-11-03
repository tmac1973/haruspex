import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchChunk } from '#lib/ipc/gen/SearchChunk.ts';
import { setCodeHelperConfig } from '#lib/stores/settings.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';
// Imported once, statically: the tool registry's first load takes seconds (#409).
import { executeTool } from '#lib/agent/tools/index.ts';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), rerank: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('#lib/rerank.ts', () => ({ rerankDocuments: mocks.rerank }));

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

beforeEach(() => {
	mocks.invoke.mockReset();
	mocks.rerank.mockReset();
	setCodeHelperConfig('search', undefined);
});

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

describe('search_code with a reranker', () => {
	const rerank = { url: 'http://box:3000', keyId: null, model: 'reranker-0.6b' };
	const three = [chunk('a.ts', 1, ['a']), chunk('b.ts', 1, ['b']), chunk('c.ts', 1, ['c'])];
	const heads = (out: string) => out.match(/^== \S+/gm);

	it('never reranks when none is set', async () => {
		answer(three);
		const out = await executeTool('search_code', { query: 'q' }, ctx);
		expect(mocks.rerank).not.toHaveBeenCalled();
		expect(out.result).toMatch(/\(keyword ranking\)$/);
	});

	it('orders the snippets as the reranker does and names it', async () => {
		setCodeHelperConfig('search', { rerank });
		answer(three);
		mocks.rerank.mockResolvedValueOnce({
			order: [
				{ index: 2, score: 0.9 },
				{ index: 0, score: 0.5 },
				{ index: 1, score: 0.1 }
			]
		});
		const out = await executeTool('search_code', { query: 'where is c' }, ctx);
		expect(mocks.rerank).toHaveBeenCalledWith(
			rerank,
			'where is c',
			['a.ts\na', 'b.ts\nb', 'c.ts\nc'],
			15_000
		);
		expect(heads(out.result)).toEqual(['== c.ts:1-1', '== a.ts:1-1', '== b.ts:1-1']);
		expect(out.result).toMatch(/\(reranked by reranker-0\.6b\)$/);
	});

	it('keeps the keyword order and names the error when the reranker fails', async () => {
		setCodeHelperConfig('search', { rerank });
		answer(three);
		mocks.rerank.mockRejectedValueOnce('connection refused');
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const out = await executeTool('search_code', { query: 'q' }, ctx);
		expect(heads(out.result)).toEqual(['== a.ts:1-1', '== b.ts:1-1', '== c.ts:1-1']);
		expect(out.result).toMatch(
			/\(keyword ranking: the reranker didn't answer — connection refused\)$/
		);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});
