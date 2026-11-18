import { invoke } from '@tauri-apps/api/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	disk: new Map<string, string>()
}));

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
vi.mock('#lib/stores/approvalOverride.ts', () => ({ isAutoApproveActive: () => true }));

import { executeTool } from '#lib/agent/tools/index.ts';
import type { ToolContext } from './types';
import { invokeRouter } from '#lib/testing/invoke.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';

beforeEach(() => {
	mocks.disk.clear();
	vi.mocked(invoke).mockReset();
	const path = (a?: Record<string, unknown>) => String(a?.relPath);
	vi.mocked(invoke).mockImplementation(
		invokeRouter({
			fs_path_exists: (a) => mocks.disk.has(path(a)),
			fs_read_text_full: (a) => mocks.disk.get(path(a)),
			fs_write_text: (a) => {
				mocks.disk.set(path(a), String(a?.content));
				return null;
			},
			run_command_capture: {
				stdout: 'FAIL\n',
				stderr: '',
				exit_code: 1,
				killed: false,
				duration_ms: 5,
				out_of_memory: false,
				memory_limit_mb: 0
			}
		})
	);
});

/** One turn's context, as the agent loop builds it. */
const turn = (codeSessionId?: string): ToolContext =>
	makeToolContext({
		workingDir: '/proj',
		codeMode: true,
		codeSessionId,
		interactive: true,
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

	it('lets a file the turn created be revised whole, starting with the same line', async () => {
		const ctx = turn(undefined);
		await write(ctx, '// walk cycle\nconst a = 1;\n');
		const again = await write(ctx, '// walk cycle\nconst a = 2;\n');
		expect(again.result).toContain('Wrote: app.py');
		expect(mocks.disk.get('app.py')).toBe('// walk cycle\nconst a = 2;\n');
	});

	it('lets a revision that changes the first line through, when it keeps most lines', async () => {
		// #1116: a job adding a name to the import at the top of a module.
		const ctx = turn(undefined);
		const body = 'export function play(p: Pattern) {\n\treturn schedule(p.steps);\n}\n';
		await write(ctx, "import type { Song } from './types';\n" + body);
		const again = await write(ctx, "import type { Pattern, Song } from './types';\n" + body);
		expect(again.result).toContain('Wrote: app.py');
	});

	it('still refuses a second part that shares little with the first', async () => {
		const ctx = turn(undefined);
		await write(ctx, "import { a } from './a';\nexport const first = a(1);\n");
		const piece = await write(ctx, 'export const second = a(2);\nexport const third = a(3);\n');
		expect(piece.result).toContain('already written in this turn');
	});

	it('says how to revise, and that the refused write did not land', async () => {
		const ctx = turn(undefined);
		await write(ctx, '// walk cycle\n');
		const piece = await write(ctx, 'const rest = 1;\n');
		expect(piece.result).toContain('the file is unchanged');
		expect(piece.result).toContain('keeping its first line or most of its lines');
		expect(piece.result).toContain('as it is on disk now');
	});
});
