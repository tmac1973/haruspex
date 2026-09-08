import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: mocks.invoke
}));

/** Shell tab, Code mode, bound to a live PTY — the configuration where the
 *  file tools and the terminal can drift onto different machines. */
const shellCodeCtx = {
	workingDir: null,
	pendingImages: [],
	deepResearch: false,
	shellMode: true,
	codeMode: true,
	codeAutoApprove: false,
	shellCwd: '/home/tim/proj',
	shellSessionId: 1,
	filesWrittenThisTurn: new Set<string>()
};

/** Route invokes by command name; `pending` is what the PTY is running. */
function mockShell(pending: string | null, results: Record<string, unknown> = {}) {
	mocks.invoke.mockImplementation(async (cmd: string) => {
		if (cmd === 'shell_pending_command') return pending;
		if (cmd in results) return results[cmd];
		return null;
	});
}

beforeEach(() => {
	mocks.invoke.mockReset();
});

describe('file tools while the terminal is inside an ssh session', () => {
	it('refuses fs_write_text instead of writing to the local machine', async () => {
		mockShell('ssh box');
		const { executeTool } = await import('$lib/agent/tools');
		const out = await executeTool(
			'fs_write_text',
			{ path: '/etc/nginx/nginx.conf', content: 'server {}' },
			shellCodeCtx
		);
		expect(out.result).toContain('fs_write_text did not run');
		expect(out.result).toContain('ssh box');
		expect(mocks.invoke).not.toHaveBeenCalledWith('fs_write_text_absolute', expect.anything());
	});

	it('refuses fs_edit_text the same way', async () => {
		mockShell('ssh box');
		const { executeTool } = await import('$lib/agent/tools');
		const out = await executeTool(
			'fs_edit_text',
			{ path: '/etc/hosts', old_str: 'a', new_str: 'b' },
			shellCodeCtx
		);
		expect(out.result).toContain('fs_edit_text did not run');
		expect(mocks.invoke).not.toHaveBeenCalledWith('fs_edit_text_absolute', expect.anything());
	});

	it('labels a read as coming from the local machine', async () => {
		mockShell('ssh box', { fs_read_text_absolute: 'local contents' });
		const { executeTool } = await import('$lib/agent/tools');
		const out = await executeTool('fs_read_text', { path: '/etc/hosts' }, shellCodeCtx);
		expect(out.result).toContain('local contents');
		expect(out.result).toContain('NOT from that host');
	});

	it('leaves tools alone at a local prompt', async () => {
		mockShell(null, { fs_write_text_absolute: null });
		const { executeTool } = await import('$lib/agent/tools');
		const out = await executeTool(
			'fs_write_text',
			{ path: '/home/tim/proj/a.txt', content: 'hi' },
			shellCodeCtx
		);
		expect(out.result).toBe('Wrote /home/tim/proj/a.txt');
	});

	it('leaves tools alone while a plain local command is running', async () => {
		mockShell('npm run dev', { fs_read_text_absolute: 'local contents' });
		const { executeTool } = await import('$lib/agent/tools');
		const out = await executeTool('fs_read_text', { path: '/home/tim/proj/a.ts' }, shellCodeCtx);
		expect(out.result).toBe('local contents');
	});
});
