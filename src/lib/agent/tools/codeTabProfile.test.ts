import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getToolSchemas } from '#lib/agent/tools/index.ts';
import { registerTool, unregisterTool } from './registry';
import { CODE_TAB_ONLY, CODE_TAB_DESCRIPTIONS } from './codeTabProfile';
import type { ToolDefinition } from '#lib/api.ts';

// The Code-tab-only tools are registered by later phases. Stand-ins under the
// same names prove the gate, which goes by name alone.
beforeAll(() => {
	for (const name of CODE_TAB_ONLY) {
		registerTool({
			category: 'exec',
			schema: {
				type: 'function',
				function: { name, description: name, parameters: { type: 'object', properties: {} } }
			},
			displayLabel: () => name,
			execute: async () => ({ result: '' })
		});
	}
});

afterAll(() => {
	for (const name of CODE_TAB_ONLY) unregisterTool(name);
});

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
