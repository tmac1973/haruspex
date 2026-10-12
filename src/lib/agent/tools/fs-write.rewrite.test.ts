import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	disk: new Map<string, string>()
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('#lib/stores/approvalOverride.ts', () => ({ isAutoApproveActive: () => true }));

import { executeTool } from '#lib/agent/tools/index.ts';
import type { ToolContext } from './types';

beforeEach(() => {
	mocks.disk.clear();
	mocks.invoke.mockReset();
	mocks.invoke.mockImplementation(async (cmd: string, a: Record<string, unknown>) => {
		const path = String(a?.relPath);
		if (cmd === 'fs_path_exists') return mocks.disk.has(path);
		if (cmd === 'fs_read_text_full') return mocks.disk.get(path);
		if (cmd === 'fs_write_text') {
			mocks.disk.set(path, String(a.content));
			return null;
		}
		if (cmd === 'run_command_capture') {
			return {
				stdout: 'FAIL\n',
				stderr: '',
				exit_code: 1,
				killed: false,
				duration_ms: 5,
				out_of_memory: false,
				memory_limit_mb: 0
			};
		}
		return null;
	});
});

/** One turn's context, as the agent loop builds it. */
const turn = (codeSessionId?: string): ToolContext =>
	({
		workingDir: '/proj',
		codeMode: true,
		shellMode: false,
		codeSessionId,
		interactive: true,
		pendingImages: [],
		deepResearch: false,
		codeAutoApprove: false,
		filesWrittenThisTurn: new Set<string>(),
		filesRewritableThisTurn: new Set<string>()
	}) as ToolContext;

const write = (ctx: ToolContext, content: string) =>
	executeTool('fs_write_text', { path: 'app.py', content }, ctx);

describe('writing a file twice in one Code turn', () => {
	it('is allowed after a command has run since the first write', async () => {
		const ctx = turn('s1');
		expect((await write(ctx, 'print(1)\n')).result).toContain('Wrote: app.py');
		await executeTool('run_command', { command: 'python app.py' }, ctx);
		const again = await write(ctx, 'print(2)\n');
		expect(again.result).toContain('Wrote: app.py');
		expect(mocks.disk.get('app.py')).toBe('print(2)\n');
	});

	it('is refused back to back, with no command in between', async () => {
		const ctx = turn('s1');
		await write(ctx, 'print(1)\n');
		const again = await write(ctx, 'print(2)\n');
		expect(again.result).toContain('already written in this turn');
		expect(mocks.disk.get('app.py')).toBe('print(1)\n');
	});

	it('needs a fresh command for each rewrite', async () => {
		const ctx = turn('s1');
		await write(ctx, 'a\n');
		await executeTool('run_command', { command: 'python app.py' }, ctx);
		await write(ctx, 'b\n');
		const third = await write(ctx, 'c\n');
		expect(third.result).toContain('already written in this turn');
		expect(mocks.disk.get('app.py')).toBe('b\n');
	});

	it('does not cover a file first written after the command', async () => {
		const ctx = turn('s1');
		await executeTool('run_command', { command: 'python app.py' }, ctx);
		await write(ctx, 'a\n');
		expect((await write(ctx, 'b\n')).result).toContain('already written in this turn');
	});
});

describe('writing a file twice in one Chat turn', () => {
	it('is still refused, whatever ran in between', async () => {
		const ctx = turn(undefined);
		await write(ctx, 'a\n');
		// Chat has no run_command; even a marked file is not rewritable there.
		ctx.filesRewritableThisTurn!.add('app.py');
		const again = await write(ctx, 'b\n');
		expect(again.result).toContain('already written in this turn');
		expect(mocks.disk.get('app.py')).toBe('a\n');
	});
});
