import { invoke } from '@tauri-apps/api/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeToolContext } from '#lib/testing/toolContext.ts';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

const chatCtx = makeToolContext({
	workingDir: '/tmp/work'
});

const shellCtx = makeToolContext({
	shellMode: true
});

// Shell tab in Code mode — the only path that grants file writes now that the
// standalone "allow writes" toggle is gone.
const shellCtxWritable = makeToolContext({
	shellMode: true,
	codeMode: true
});

beforeEach(() => {
	vi.mocked(invoke).mockReset();
});

describe('fs_read tools in Chat mode', () => {
	it('fs_read_text dispatches to the workdir-relative Tauri command', async () => {
		vi.mocked(invoke).mockResolvedValue('file contents');
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool('fs_read_text', { path: 'config.json' }, chatCtx);
		expect(invoke).toHaveBeenCalledWith('fs_read_text', {
			workdir: '/tmp/work',
			relPath: 'config.json'
		});
		expect(out.result).toBe('file contents');
	});

	it('fs_read_text forwards offset/limit when provided, omits them otherwise', async () => {
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		vi.mocked(invoke).mockResolvedValue('windowed');
		await executeTool('fs_read_text', { path: 'big.log', offset: 10, limit: 5 }, chatCtx);
		expect(invoke).toHaveBeenCalledWith('fs_read_text', {
			workdir: '/tmp/work',
			relPath: 'big.log',
			offset: 10,
			limit: 5
		});
		// No window args → call shape unchanged (no offset/limit keys).
		vi.mocked(invoke).mockClear();
		await executeTool('fs_read_text', { path: 'big.log' }, chatCtx);
		expect(invoke).toHaveBeenCalledWith('fs_read_text', {
			workdir: '/tmp/work',
			relPath: 'big.log'
		});
	});

	it('fs_read_text label shows the line range when windowed', async () => {
		const { getDisplayLabel } = await import('#lib/agent/tools/index.ts');
		expect(getDisplayLabel('fs_read_text', { path: 'a.ts' })).toBe('a.ts');
		expect(getDisplayLabel('fs_read_text', { path: 'a.ts', offset: 10, limit: 40 })).toBe(
			'a.ts:10-49'
		);
		expect(getDisplayLabel('fs_read_text', { path: 'a.ts', limit: 40 })).toBe('a.ts:1-40');
		expect(getDisplayLabel('fs_read_text', { path: 'a.ts', offset: 10 })).toBe('a.ts:10+');
	});

	it('fs_list_dir dispatches to the workdir-relative command', async () => {
		vi.mocked(invoke).mockResolvedValue({ path: '.', entries: [], truncated: false });
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		await executeTool('fs_list_dir', { path: '.' }, chatCtx);
		expect(invoke).toHaveBeenCalledWith('fs_list_dir', {
			workdir: '/tmp/work',
			relPath: '.'
		});
	});
});

describe('fs_read tools in Shell mode', () => {
	it('fs_read_text dispatches to the absolute-path Tauri command', async () => {
		vi.mocked(invoke).mockResolvedValue('NAME="Fedora Linux"\n');
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool('fs_read_text', { path: '/etc/os-release' }, shellCtx);
		expect(invoke).toHaveBeenCalledWith('fs_read_text_absolute', {
			path: '/etc/os-release'
		});
		expect(out.result).toContain('Fedora');
	});

	it('fs_list_dir dispatches to the absolute-path command', async () => {
		vi.mocked(invoke).mockResolvedValue({ path: '/etc', entries: [], truncated: false });
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		await executeTool('fs_list_dir', { path: '/etc' }, shellCtx);
		expect(invoke).toHaveBeenCalledWith('fs_list_dir_absolute', { path: '/etc' });
	});

	it('fs_read_pdf dispatches to the absolute-path command', async () => {
		vi.mocked(invoke).mockResolvedValue('pdf body');
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		await executeTool('fs_read_pdf', { path: '/var/spool/file.pdf' }, shellCtx);
		expect(invoke).toHaveBeenCalledWith('fs_read_pdf_absolute', {
			path: '/var/spool/file.pdf'
		});
	});

	it('resolves a relative path against the shell cwd before dispatching', async () => {
		vi.mocked(invoke).mockResolvedValue('contents');
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		await executeTool(
			'fs_read_text',
			{ path: 'notes.txt' },
			{ ...shellCtx, shellCwd: '/home/tim' }
		);
		expect(invoke).toHaveBeenCalledWith('fs_read_text_absolute', {
			path: '/home/tim/notes.txt'
		});
	});

	it('leaves an absolute path untouched even when a shell cwd is known', async () => {
		vi.mocked(invoke).mockResolvedValue('contents');
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		await executeTool(
			'fs_read_text',
			{ path: '/etc/hosts' },
			{ ...shellCtx, shellCwd: '/home/tim' }
		);
		expect(invoke).toHaveBeenCalledWith('fs_read_text_absolute', { path: '/etc/hosts' });
	});

	it('passes a relative path through unchanged when no cwd is known (graceful fallback)', async () => {
		vi.mocked(invoke).mockResolvedValue('contents');
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		await executeTool('fs_read_text', { path: 'notes.txt' }, shellCtx);
		expect(invoke).toHaveBeenCalledWith('fs_read_text_absolute', { path: 'notes.txt' });
	});

	it('fs_write_text resolves a relative path against the shell cwd', async () => {
		vi.mocked(invoke).mockResolvedValue(undefined);
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool(
			'fs_write_text',
			{ path: 'snake_game.py', content: 'print("hi")' },
			{ ...shellCtxWritable, shellCwd: '/home/tim/games' }
		);
		expect(invoke).toHaveBeenCalledWith('fs_write_text_absolute', {
			path: '/home/tim/games/snake_game.py',
			content: 'print("hi")',
			overwrite: true
		});
		expect(out.result).toContain('/home/tim/games/snake_game.py');
	});

	it('fs tools are exposed even without a working directory', async () => {
		const { getToolSchemas } = await import('#lib/agent/tools/index.ts');
		const schemas = getToolSchemas({ hasWorkingDir: false, shellMode: true });
		const names = schemas.map((s) => s.function.name);
		expect(names).toContain('fs_read_text');
		expect(names).toContain('fs_list_dir');
		expect(names).toContain('fs_read_pdf');
	});

	it('fs tools are hidden when shellMode=false and no workingDir', async () => {
		const { getToolSchemas } = await import('#lib/agent/tools/index.ts');
		const schemas = getToolSchemas({ hasWorkingDir: false, shellMode: false });
		const names = schemas.map((s) => s.function.name);
		expect(names).not.toContain('fs_read_text');
	});

	it('write tools are hidden in the plain (read-only) shell assistant', async () => {
		const { getToolSchemas } = await import('#lib/agent/tools/index.ts');
		const schemas = getToolSchemas({
			hasWorkingDir: false,
			shellMode: true
		});
		const names = schemas.map((s) => s.function.name);
		expect(names).not.toContain('fs_write_text');
		expect(names).not.toContain('fs_edit_text');
	});

	it('write tools are exposed when a shell session is in Code mode', async () => {
		const { getToolSchemas } = await import('#lib/agent/tools/index.ts');
		const schemas = getToolSchemas({
			hasWorkingDir: false,
			shellMode: true,
			codeMode: true
		});
		const names = schemas.map((s) => s.function.name);
		expect(names).toContain('fs_write_text');
		expect(names).toContain('fs_edit_text');
	});

	it('document builders and sandbox are hidden in shell mode', async () => {
		const { getToolSchemas } = await import('#lib/agent/tools/index.ts');
		const schemas = getToolSchemas({
			hasWorkingDir: false,
			shellMode: true,
			codeMode: true
		});
		const names = schemas.map((s) => s.function.name);
		expect(names).not.toContain('fs_write_document');
		expect(names).not.toContain('fs_write_spreadsheet');
		expect(names).not.toContain('fs_write_slides');
		expect(names).not.toContain('fs_download_url');
		expect(names).not.toContain('run_python');
	});

	it('fs_write_text dispatches to the absolute command in shell-mode Code mode', async () => {
		vi.mocked(invoke).mockResolvedValue(undefined);
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		await executeTool(
			'fs_write_text',
			{ path: '/tmp/test.conf', content: 'foo', overwrite: true },
			shellCtxWritable
		);
		expect(invoke).toHaveBeenCalledWith('fs_write_text_absolute', {
			path: '/tmp/test.conf',
			content: 'foo',
			overwrite: true
		});
	});

	it('fs_edit_text dispatches to the absolute command in shell-mode Code mode', async () => {
		vi.mocked(invoke).mockResolvedValue(undefined);
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		await executeTool(
			'fs_edit_text',
			{ path: '/etc/hosts', old_str: 'old', new_str: 'new' },
			shellCtxWritable
		);
		expect(invoke).toHaveBeenCalledWith('fs_edit_text_absolute', {
			path: '/etc/hosts',
			oldStr: 'old',
			newStr: 'new'
		});
	});
});

describe('fs tools in a WSL Shell session', () => {
	it('pass the distro so in-distro paths resolve through the WSL share', async () => {
		const { updateSettings } = await import('#lib/stores/settings.ts');
		updateSettings({ shellSelection: { kind: 'wsl', distro: 'Ubuntu-24.04' } });
		try {
			const { executeTool } = await import('#lib/agent/tools/index.ts');
			vi.mocked(invoke).mockResolvedValue({ path: '/home/tim', entries: [], truncated: false });
			await executeTool('fs_list_dir', { path: '/home/tim' }, shellCtx);
			expect(invoke).toHaveBeenCalledWith('fs_list_dir_absolute', {
				path: '/home/tim',
				wslDistro: 'Ubuntu-24.04'
			});
			vi.mocked(invoke).mockResolvedValue('');
			await executeTool('fs_read_text', { path: '/home/tim/.bashrc' }, shellCtx);
			expect(invoke).toHaveBeenCalledWith('fs_read_text_absolute', {
				path: '/home/tim/.bashrc',
				wslDistro: 'Ubuntu-24.04'
			});
			vi.mocked(invoke).mockResolvedValue(null);
			await executeTool(
				'fs_write_text',
				{ path: '/home/tim/a.txt', content: 'x' },
				shellCtxWritable
			);
			expect(invoke).toHaveBeenCalledWith('fs_write_text_absolute', {
				path: '/home/tim/a.txt',
				content: 'x',
				overwrite: true,
				wslDistro: 'Ubuntu-24.04'
			});
		} finally {
			updateSettings({ shellSelection: null });
		}
	});
});
