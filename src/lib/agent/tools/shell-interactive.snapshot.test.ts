import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ToolContext } from '#lib/agent/tools/types.ts';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { executeTool } from '#lib/agent/tools/index.ts';
import {
	clearTerminalSnapshot,
	registerTerminalSnapshot
} from '#lib/stores/shellTerminalSnapshot.ts';

const SID = 7;

function shellCtx(over: Partial<ToolContext> = {}): ToolContext {
	return {
		workingDir: null,
		pendingImages: [],
		deepResearch: false,
		shellMode: true,
		codeMode: true,
		codeAutoApprove: false,
		filesWrittenThisTurn: new Set<string>(),
		shellSessionId: SID,
		...over
	};
}

function run(name: string, args: Record<string, unknown>, ctx = shellCtx()) {
	return executeTool(name, args, ctx);
}

afterEach(() => {
	clearTerminalSnapshot(SID);
});

describe('shell_snapshot', () => {
	const PNG = 'data:image/png;base64,AAAA';

	it('adds the terminal image to the turn and shows a thumbnail', async () => {
		registerTerminalSnapshot(SID, () => PNG);
		const ctx = shellCtx();
		const out = await run('shell_snapshot', {}, ctx);
		expect(out.thumbDataUrl).toBe(PNG);
		expect(out.result).toMatch(/^Captured the terminal screen as an image/);
		expect(ctx.pendingImages).toEqual([{ path: 'terminal-snapshot.png', dataUrl: PNG }]);
	});

	it('takes a fourth image but refuses a fifth until the model describes them', async () => {
		registerTerminalSnapshot(SID, () => PNG);
		const img = { path: 'a.png', dataUrl: PNG };
		const ctx = shellCtx({ pendingImages: [img, img, img] });

		const fourth = await run('shell_snapshot', {}, ctx);
		expect(fourth.thumbDataUrl).toBe(PNG);
		expect(ctx.pendingImages).toHaveLength(4);

		const fifth = await run('shell_snapshot', {}, ctx);
		expect(JSON.parse(fifth.result).error).toBe(
			"Too many images pending (4). Describe the ones you've already captured before snapshotting again."
		);
		expect(fifth.thumbDataUrl).toBeUndefined();
		expect(ctx.pendingImages).toHaveLength(4);
	});

	it('says the terminal may not be ready when no terminal is attached', async () => {
		const ctx = shellCtx();
		const out = await run('shell_snapshot', {}, ctx);
		expect(JSON.parse(out.result).error).toMatch(/Could not capture the terminal image/);
		expect(ctx.pendingImages).toEqual([]);
	});

	it('reports a capture that throws as a tool error', async () => {
		registerTerminalSnapshot(SID, () => {
			throw new Error('canvas lost');
		});
		const out = await run('shell_snapshot', {});
		expect(JSON.parse(out.result).error).toBe('shell_snapshot failed: canvas lost');
	});
});
