import { invoke } from '@tauri-apps/api/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
vi.mock('#lib/stores/approvalOverride.ts', () => ({ isAutoApproveActive: () => true }));

import { executeTool } from '#lib/agent/tools/index.ts';
import { invokeRouter } from '#lib/testing/invoke.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';

beforeEach(() => {
	vi.mocked(invoke).mockReset();
	vi.mocked(invoke).mockImplementation(invokeRouter({ fs_created_move: null }));
});

/** A job run's turn: it overwrites without asking, so both paths are reached. */
const job = () => makeToolContext({ workingDir: '/w', jobRunId: 7 });
const moves = () => vi.mocked(invoke).mock.calls.filter((c) => c[0] === 'fs_created_move');

describe('fs_move', () => {
	it('moves under the turn scope, and carries the turn record with it', async () => {
		const ctx = job();
		ctx.filesWrittenThisTurn.add('a.md');
		const out = await executeTool('fs_move', { from: 'a.md', to: 'docs/b.md' }, ctx);
		expect(out.result).toBe('Moved a.md to docs/b.md.');
		expect(moves()).toEqual([
			['fs_created_move', { workdir: '/w', from: 'a.md', to: 'docs/b.md', scope: 'job:7' }]
		]);
		expect([...ctx.filesWrittenThisTurn]).toEqual(['docs/b.md']);
	});

	it('leaves the turn record alone for a file it did not write this turn', async () => {
		const ctx = job();
		ctx.filesWrittenThisTurn.add('other.md');
		await executeTool('fs_move', { from: 'a.md', to: 'b.md' }, ctx);
		expect([...ctx.filesWrittenThisTurn]).toEqual(['other.md']);
	});

	it('needs both paths, and trims them', async () => {
		const out = await executeTool('fs_move', { from: 'a.md', to: '   ' }, job());
		expect(JSON.parse(out.result).error).toBe('fs_move needs "from" and "to".');
		await executeTool('fs_move', { from: ' a.md ', to: ' b.md ' }, job());
		expect(moves()[0][1]).toMatchObject({ from: 'a.md', to: 'b.md' });
	});

	it('stays inside a write root, on either side of the move', async () => {
		const ctx = makeToolContext({ workingDir: '/w', jobRunId: 7, writeRoot: 'plan/x/' });
		for (const args of [
			{ from: 'src/main.rs', to: 'plan/x/main.rs' },
			{ from: 'plan/x/a.md', to: 'src/a.md' }
		]) {
			const out = await executeTool('fs_move', args, ctx);
			expect(out.result).toMatch(/may only write inside plan\/x\//);
		}
		expect(moves()).toEqual([]);
	});

	it('is refused in Shell, read-only Code and with no folder', async () => {
		const args = { from: 'a.md', to: 'b.md' };
		const shell = makeToolContext({ workingDir: '/w', shellMode: true, conversationId: 'c' });
		expect((await executeTool('fs_move', args, shell)).result).toContain(
			"isn't available in Shell"
		);
		const ro = makeToolContext({ workingDir: '/w', codeSessionId: 's', codeReadOnly: true });
		expect((await executeTool('fs_move', args, ro)).result).toContain('read-only');
		const none = makeToolContext({ conversationId: 'c' });
		expect((await executeTool('fs_move', args, none)).result).toContain('No working directory set');
		expect(moves()).toEqual([]);
	});

	it("passes on Rust's refusal and keeps the turn record", async () => {
		vi.mocked(invoke).mockImplementation(
			invokeRouter({
				fs_created_move: () => {
					throw "b.md is already there and you didn't make it, so it can't be replaced.";
				}
			})
		);
		const ctx = job();
		ctx.filesWrittenThisTurn.add('a.md');
		const out = await executeTool('fs_move', { from: 'a.md', to: 'b.md' }, ctx);
		expect(out.result).toContain("b.md is already there and you didn't make it");
		expect([...ctx.filesWrittenThisTurn]).toEqual(['a.md']);
	});
});
