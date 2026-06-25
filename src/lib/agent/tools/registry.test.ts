import { describe, it, expect } from 'vitest';
import { getToolSchemas } from '$lib/agent/tools';

function names(opts: Parameters<typeof getToolSchemas>[0]): string[] {
	return getToolSchemas(opts).map((s) => s.function.name);
}

describe('interactive shell tool gating', () => {
	const INTERACTIVE = ['shell_read', 'shell_input', 'shell_interrupt', 'shell_snapshot'];

	it('exposes interactive tools in Shell-tab Code mode (codeMode + shellMode)', () => {
		const n = names({ hasWorkingDir: true, codeMode: true, shellMode: true });
		for (const t of INTERACTIVE) expect(n).toContain(t);
		// run_command rides along in code mode too.
		expect(n).toContain('run_command');
	});

	it('hides the vision-only shell_snapshot when the model lacks vision', () => {
		const n = names({
			hasWorkingDir: true,
			codeMode: true,
			shellMode: true,
			visionSupported: false
		});
		expect(n).not.toContain('shell_snapshot');
		// The non-vision interactive tools still appear.
		expect(n).toContain('shell_input');
		expect(n).toContain('shell_interrupt');
	});

	it('hides interactive tools in the standalone Code tab (codeMode, no shell session)', () => {
		const n = names({ hasWorkingDir: true, codeMode: true, shellMode: false });
		for (const t of INTERACTIVE) expect(n).not.toContain(t);
		expect(n).toContain('run_command');
	});

	it('hides interactive tools in plain Shell mode (no code mode)', () => {
		const n = names({ hasWorkingDir: true, shellMode: true });
		for (const t of INTERACTIVE) expect(n).not.toContain(t);
		// plain shell mode has no exec tools at all.
		expect(n).not.toContain('run_command');
	});

	it('hides interactive tools in Chat mode', () => {
		const n = names({ hasWorkingDir: true });
		for (const t of INTERACTIVE) expect(n).not.toContain(t);
	});
});

describe('tool allowlist + audit tools', () => {
	const AUDIT_TOOLS = ['submit_findings', 'submit_verdict'];

	it('audit submit tools never appear in any default mode', () => {
		const modes = [
			{ hasWorkingDir: true }, // chat
			{ hasWorkingDir: true, shellMode: true },
			{ hasWorkingDir: true, codeMode: true },
			{ hasWorkingDir: true, codeMode: true, shellMode: true }
		];
		for (const m of modes) {
			const n = names(m);
			for (const t of AUDIT_TOOLS) expect(n).not.toContain(t);
		}
	});

	it('an allowlist exposes EXACTLY the named tools, bypassing mode filters', () => {
		const n = names({
			hasWorkingDir: false,
			toolAllowlist: ['code_grep', 'fs_read_text', 'submit_findings']
		});
		expect(new Set(n)).toEqual(new Set(['code_grep', 'fs_read_text', 'submit_findings']));
	});

	it('the allowlist wins even with mode flags set, and silently drops unknown names', () => {
		const n = names({
			hasWorkingDir: true,
			codeMode: true,
			shellMode: true,
			toolAllowlist: ['code_glob', 'submit_verdict', 'not_a_real_tool']
		});
		expect(new Set(n)).toEqual(new Set(['code_glob', 'submit_verdict']));
		// run_command would normally ride along in code mode — the allowlist excludes it.
		expect(n).not.toContain('run_command');
	});

	it('an empty allowlist exposes no tools', () => {
		expect(names({ hasWorkingDir: true, toolAllowlist: [] })).toEqual([]);
	});
});
