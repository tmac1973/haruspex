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
		const path = String(a.relPath);
		if (cmd === 'fs_path_exists') return mocks.disk.has(path);
		if (cmd === 'fs_read_text_full') return mocks.disk.get(path);
		if (cmd === 'fs_write_text') {
			mocks.disk.set(path, String(a.content));
			return null;
		}
		return null;
	});
});

const ctx = (codeSessionId?: string): ToolContext =>
	({
		workingDir: '/proj',
		codeMode: true,
		shellMode: false,
		codeSessionId,
		filesWrittenThisTurn: new Set<string>()
	}) as ToolContext;

describe('fs_write_text in a Code session', () => {
	it('attaches a diff against what the file held', async () => {
		mocks.disk.set('notes.md', 'one\ntwo\n');
		const out = await executeTool(
			'fs_write_text',
			{ path: 'notes.md', content: 'one\nthree\n' },
			ctx('s1')
		);
		expect(out.result).toContain('Wrote: notes.md');
		expect(out.fileDiff).toMatchObject({ path: 'notes.md', mode: 'write', added: 1, removed: 1 });
		// The previous content was read before the write replaced it.
		const order = mocks.invoke.mock.calls.map((c) => c[0]);
		expect(order.indexOf('fs_read_text_full')).toBeLessThan(order.indexOf('fs_write_text'));
	});

	it('shows a new file as all added', async () => {
		const out = await executeTool(
			'fs_write_text',
			{ path: 'new.md', content: 'a\nb\n' },
			ctx('s1')
		);
		expect(out.fileDiff).toMatchObject({ mode: 'new', added: 2, removed: 0 });
		expect(mocks.invoke).not.toHaveBeenCalledWith('fs_read_text_full', expect.anything());
	});

	it('reads nothing extra outside the Code tab', async () => {
		mocks.disk.set('notes.md', 'old');
		const out = await executeTool('fs_write_text', { path: 'notes.md', content: 'new' }, ctx());
		expect(out.fileDiff).toBeUndefined();
		expect(mocks.invoke).not.toHaveBeenCalledWith('fs_read_text_full', expect.anything());
	});
});
