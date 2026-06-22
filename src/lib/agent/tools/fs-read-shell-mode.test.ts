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
	shellAllowWrite: false,
	codeMode: false,
	codeAutoApprove: false,
	filesWrittenThisTurn: new Set<string>()
};

const shellCtx = {
	workingDir: null,
	pendingImages: [],
	deepResearch: false,
	shellMode: true,
	shellAllowWrite: false,
	codeMode: false,
	codeAutoApprove: false,
	filesWrittenThisTurn: new Set<string>()
};

const shellCtxWritable = {
	workingDir: null,
	pendingImages: [],
	deepResearch: false,
	shellMode: true,
	shellAllowWrite: true,
	codeMode: false,
	codeAutoApprove: false,
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

	it('fs_read_text forwards offset/limit when provided, omits them otherwise', async () => {
		const { executeTool } = await import('$lib/agent/tools');
		mocks.invoke.mockResolvedValue('windowed');
		await executeTool('fs_read_text', { path: 'big.log', offset: 10, limit: 5 }, chatCtx);
		expect(mocks.invoke).toHaveBeenCalledWith('fs_read_text', {
			workdir: '/tmp/work',
			relPath: 'big.log',
			offset: 10,
			limit: 5
		});
		// No window args → call shape unchanged (no offset/limit keys).
		mocks.invoke.mockClear();
		await executeTool('fs_read_text', { path: 'big.log' }, chatCtx);
		expect(mocks.invoke).toHaveBeenCalledWith('fs_read_text', {
			workdir: '/tmp/work',
			relPath: 'big.log'
		});
	});

	it('fs_read_text label shows the line range when windowed', async () => {
		const { getDisplayLabel } = await import('$lib/agent/tools');
		expect(getDisplayLabel('fs_read_text', { path: 'a.ts' })).toBe('a.ts');
		expect(getDisplayLabel('fs_read_text', { path: 'a.ts', offset: 10, limit: 40 })).toBe(
			'a.ts:10-49'
		);
		expect(getDisplayLabel('fs_read_text', { path: 'a.ts', limit: 40 })).toBe('a.ts:1-40');
		expect(getDisplayLabel('fs_read_text', { path: 'a.ts', offset: 10 })).toBe('a.ts:10+');
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

	it('resolves a relative path against the shell cwd before dispatching', async () => {
		mocks.invoke.mockResolvedValue('contents');
		const { executeTool } = await import('$lib/agent/tools');
		await executeTool(
			'fs_read_text',
			{ path: 'notes.txt' },
			{ ...shellCtx, shellCwd: '/home/tim' }
		);
		expect(mocks.invoke).toHaveBeenCalledWith('fs_read_text_absolute', {
			path: '/home/tim/notes.txt'
		});
	});

	it('leaves an absolute path untouched even when a shell cwd is known', async () => {
		mocks.invoke.mockResolvedValue('contents');
		const { executeTool } = await import('$lib/agent/tools');
		await executeTool(
			'fs_read_text',
			{ path: '/etc/hosts' },
			{ ...shellCtx, shellCwd: '/home/tim' }
		);
		expect(mocks.invoke).toHaveBeenCalledWith('fs_read_text_absolute', { path: '/etc/hosts' });
	});

	it('passes a relative path through unchanged when no cwd is known (graceful fallback)', async () => {
		mocks.invoke.mockResolvedValue('contents');
		const { executeTool } = await import('$lib/agent/tools');
		await executeTool('fs_read_text', { path: 'notes.txt' }, shellCtx);
		expect(mocks.invoke).toHaveBeenCalledWith('fs_read_text_absolute', { path: 'notes.txt' });
	});

	it('fs_write_text resolves a relative path against the shell cwd', async () => {
		mocks.invoke.mockResolvedValue(undefined);
		const { executeTool } = await import('$lib/agent/tools');
		const out = await executeTool(
			'fs_write_text',
			{ path: 'snake_game.py', content: 'print("hi")' },
			{ ...shellCtxWritable, shellCwd: '/home/tim/games' }
		);
		expect(mocks.invoke).toHaveBeenCalledWith('fs_write_text_absolute', {
			path: '/home/tim/games/snake_game.py',
			content: 'print("hi")',
			overwrite: true
		});
		expect(out.result).toContain('/home/tim/games/snake_game.py');
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

	it('write tools are hidden in shell mode by default', async () => {
		const { getToolSchemas } = await import('$lib/agent/tools');
		const schemas = getToolSchemas({
			hasWorkingDir: false,
			shellMode: true,
			shellAllowWrite: false
		});
		const names = schemas.map((s) => s.function.name);
		expect(names).not.toContain('fs_write_text');
		expect(names).not.toContain('fs_edit_text');
	});

	it('write tools are exposed when shellMode + shellAllowWrite both on', async () => {
		const { getToolSchemas } = await import('$lib/agent/tools');
		const schemas = getToolSchemas({
			hasWorkingDir: false,
			shellMode: true,
			shellAllowWrite: true
		});
		const names = schemas.map((s) => s.function.name);
		expect(names).toContain('fs_write_text');
		expect(names).toContain('fs_edit_text');
	});

	it('document builders and sandbox are hidden in shell mode', async () => {
		const { getToolSchemas } = await import('$lib/agent/tools');
		const schemas = getToolSchemas({
			hasWorkingDir: false,
			shellMode: true,
			shellAllowWrite: true
		});
		const names = schemas.map((s) => s.function.name);
		expect(names).not.toContain('fs_write_pdf');
		expect(names).not.toContain('fs_write_docx');
		expect(names).not.toContain('fs_write_xlsx');
		expect(names).not.toContain('fs_download_url');
		expect(names).not.toContain('run_python');
	});

	it('fs_write_text dispatches to the absolute command when shell-mode + allowWrite', async () => {
		mocks.invoke.mockResolvedValue(undefined);
		const { executeTool } = await import('$lib/agent/tools');
		await executeTool(
			'fs_write_text',
			{ path: '/tmp/test.conf', content: 'foo', overwrite: true },
			shellCtxWritable
		);
		expect(mocks.invoke).toHaveBeenCalledWith('fs_write_text_absolute', {
			path: '/tmp/test.conf',
			content: 'foo',
			overwrite: true
		});
	});

	it('fs_edit_text dispatches to the absolute command when shell-mode + allowWrite', async () => {
		mocks.invoke.mockResolvedValue(undefined);
		const { executeTool } = await import('$lib/agent/tools');
		await executeTool(
			'fs_edit_text',
			{ path: '/etc/hosts', old_str: 'old', new_str: 'new' },
			shellCtxWritable
		);
		expect(mocks.invoke).toHaveBeenCalledWith('fs_edit_text_absolute', {
			path: '/etc/hosts',
			oldStr: 'old',
			newStr: 'new'
		});
	});
});
