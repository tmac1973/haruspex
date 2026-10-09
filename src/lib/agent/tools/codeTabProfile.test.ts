import { describe, it, expect, afterEach, vi } from 'vitest';
import { getToolSchemas } from '#lib/agent/tools/index.ts';
import { CODE_TAB_ONLY, CODE_TAB_DESCRIPTIONS, isCodeWriteTool } from './codeTabProfile';
import type { ToolDefinition } from '#lib/api.ts';
import { resetShellPlatformSupported } from '#lib/shell/platformSupport.ts';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

afterEach(() => resetShellPlatformSupported());

const CODE_TOOLS = [
	'fs_read_text',
	'fs_list_dir',
	'fs_edit_text',
	'fs_write_text',
	'code_grep',
	'code_glob',
	'run_command',
	'web_search',
	'research_url'
];
const SHELL_INTERACTIVE = ['shell_read', 'shell_input', 'shell_interrupt', 'shell_snapshot'];

function schemas(codeMode: boolean, shellMode: boolean): ToolDefinition[] {
	return getToolSchemas({ hasWorkingDir: !shellMode, codeMode, shellMode });
}

function names(codeMode: boolean, shellMode: boolean): string[] {
	return schemas(codeMode, shellMode)
		.map((s) => s.function.name)
		.sort();
}

function runCommand(codeMode: boolean, shellMode: boolean) {
	return schemas(codeMode, shellMode).find((s) => s.function.name === 'run_command');
}

describe('tool profiles over (codeMode, shellMode)', () => {
	it('(code, no shell) — the Code tab: code tools plus its own, no terminal tools', () => {
		expect(names(true, false)).toEqual([...CODE_TOOLS, ...CODE_TAB_ONLY].sort());
	});

	it('(code, shell) — Shell Code mode: code tools plus the terminal tools, none of the tab’s', () => {
		expect(names(true, true)).toEqual([...CODE_TOOLS, ...SHELL_INTERACTIVE].sort());
	});

	it('(no code, shell) — the plain Shell assistant runs nothing', () => {
		const n = names(false, true);
		expect(n).not.toContain('run_command');
		for (const t of [...CODE_TAB_ONLY, ...SHELL_INTERACTIVE]) expect(n).not.toContain(t);
	});

	it('(no code, no shell) — Chat runs nothing', () => {
		const n = names(false, false);
		expect(n).not.toContain('run_command');
		for (const t of [...CODE_TAB_ONLY, ...SHELL_INTERACTIVE]) expect(n).not.toContain(t);
	});
});

describe('open_in_shell and the platform', () => {
	it('is offered while support is unknown or known', async () => {
		expect(names(true, false)).toContain('open_in_shell');
		const { loadShellPlatformSupported } = await import('#lib/shell/platformSupport.ts');
		vi.mocked(invoke).mockResolvedValueOnce(true);
		await loadShellPlatformSupported();
		expect(names(true, false)).toContain('open_in_shell');
	});

	it('is not offered where the Shell tab does not work', async () => {
		const { loadShellPlatformSupported } = await import('#lib/shell/platformSupport.ts');
		vi.mocked(invoke).mockResolvedValueOnce(false);
		await loadShellPlatformSupported();
		const n = names(true, false);
		expect(n).not.toContain('open_in_shell');
		expect(n).toContain('open_in_editor');
	});
});

describe('run_command description by profile', () => {
	const oneShot = CODE_TAB_DESCRIPTIONS.run_command;

	it('the Code tab gets the one-shot wording and the background tools', () => {
		const tool = runCommand(true, false)!;
		expect(tool.function.description).toBe(oneShot.description);
		expect(tool.function.description).not.toContain('live interactive shell');
		expect(tool.function.description).toContain('command_output');
		const props = (
			tool.function.parameters as { properties: Record<string, { description: string }> }
		).properties;
		expect(props.background.description).toBe(oneShot.params!.background);
		expect(props.background.description).not.toContain('live terminal');
		// Parameters it doesn't override keep their wording, and nothing is dropped.
		expect(Object.keys(props).sort()).toEqual(['background', 'command', 'timeout_secs', 'watch']);
		expect(props.command.description).toBe('The shell command to run.');
	});

	it('Shell Code mode keeps the live-terminal wording', () => {
		const tool = runCommand(true, true)!;
		expect(tool.function.description).toContain('live interactive shell');
		const props = (
			tool.function.parameters as { properties: Record<string, { description: string }> }
		).properties;
		expect(props.background.description).toContain('live terminal session');
	});

	it('the override does not leak into the registered schema', () => {
		runCommand(true, false);
		expect(runCommand(true, true)!.function.description).not.toBe(oneShot.description);
	});
});

describe('a read-only Code session', () => {
	it('gets the read, search and web tools, without writes, edits or make_asset', () => {
		const n = getToolSchemas({ hasWorkingDir: true, codeMode: true, codeReadOnly: true })
			.map((s) => s.function.name)
			.sort();
		expect(n).toEqual([...CODE_TOOLS, ...CODE_TAB_ONLY].filter((t) => !isCodeWriteTool(t)).sort());
		expect(n).toContain('run_command');
		expect(n).not.toContain('fs_write_text');
		expect(n).not.toContain('fs_edit_text');
	});

	it('names the write tools', () => {
		for (const t of ['fs_write_text', 'fs_write_docx', 'fs_edit_text', 'make_asset']) {
			expect(isCodeWriteTool(t)).toBe(true);
		}
		for (const t of ['fs_read_text', 'run_command', 'code_grep']) {
			expect(isCodeWriteTool(t)).toBe(false);
		}
	});
});
