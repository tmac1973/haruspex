import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: mocks.invoke
}));

const chatCtx = {
	workingDir: '/tmp/work',
	pendingImages: [],
	deepResearch: false,
	shellMode: false,
	filesWrittenThisTurn: new Set<string>()
};

const shellCtx = {
	workingDir: null,
	pendingImages: [],
	deepResearch: false,
	shellMode: true,
	filesWrittenThisTurn: new Set<string>()
};

beforeEach(() => {
	mocks.invoke.mockReset();
});

describe('fs_read tools in Chat mode', () => {
	it('fs_read_text dispatches to the workdir-relative Tauri command', async () => {
		mocks.invoke.mockResolvedValue('file contents');
		const { executeTool } = await import('$lib/agent/tools');
		const out = await executeTool('fs_read_text', { path: 'config.json' }, chatCtx);
		expect(mocks.invoke).toHaveBeenCalledWith('fs_read_text', {
			workdir: '/tmp/work',
			relPath: 'config.json'
		});
		expect(out.result).toBe('file contents');
	});

	it('fs_list_dir dispatches to the workdir-relative command', async () => {
		mocks.invoke.mockResolvedValue({ path: '.', entries: [], truncated: false });
		const { executeTool } = await import('$lib/agent/tools');
		await executeTool('fs_list_dir', { path: '.' }, chatCtx);
		expect(mocks.invoke).toHaveBeenCalledWith('fs_list_dir', {
			workdir: '/tmp/work',
			relPath: '.'
		});
	});
});

describe('fs_read tools in Shell mode', () => {
	it('fs_read_text dispatches to the absolute-path Tauri command', async () => {
		mocks.invoke.mockResolvedValue('NAME="Fedora Linux"\n');
		const { executeTool } = await import('$lib/agent/tools');
		const out = await executeTool('fs_read_text', { path: '/etc/os-release' }, shellCtx);
		expect(mocks.invoke).toHaveBeenCalledWith('fs_read_text_absolute', {
			path: '/etc/os-release'
		});
		expect(out.result).toContain('Fedora');
	});

	it('fs_list_dir dispatches to the absolute-path command', async () => {
		mocks.invoke.mockResolvedValue({ path: '/etc', entries: [], truncated: false });
		const { executeTool } = await import('$lib/agent/tools');
		await executeTool('fs_list_dir', { path: '/etc' }, shellCtx);
		expect(mocks.invoke).toHaveBeenCalledWith('fs_list_dir_absolute', { path: '/etc' });
	});

	it('fs_read_pdf dispatches to the absolute-path command', async () => {
		mocks.invoke.mockResolvedValue('pdf body');
		const { executeTool } = await import('$lib/agent/tools');
		await executeTool('fs_read_pdf', { path: '/var/spool/file.pdf' }, shellCtx);
		expect(mocks.invoke).toHaveBeenCalledWith('fs_read_pdf_absolute', {
			path: '/var/spool/file.pdf'
		});
	});

	it('fs tools are exposed even without a working directory', async () => {
		const { getToolSchemas } = await import('$lib/agent/tools');
		const schemas = getToolSchemas({ hasWorkingDir: false, shellMode: true });
		const names = schemas.map((s) => s.function.name);
		expect(names).toContain('fs_read_text');
		expect(names).toContain('fs_list_dir');
		expect(names).toContain('fs_read_pdf');
	});

	it('fs tools are hidden when shellMode=false and no workingDir', async () => {
		const { getToolSchemas } = await import('$lib/agent/tools');
		const schemas = getToolSchemas({ hasWorkingDir: false, shellMode: false });
		const names = schemas.map((s) => s.function.name);
		expect(names).not.toContain('fs_read_text');
	});
});
