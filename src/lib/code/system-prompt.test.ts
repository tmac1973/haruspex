import { describe, it, expect } from 'vitest';
import { buildCodeSystemPrompt, buildShellCodeSystemPrompt } from '#lib/code/system-prompt.ts';

const tab = (over: Partial<Parameters<typeof buildCodeSystemPrompt>[0]> = {}) =>
	String(buildCodeSystemPrompt({ root: '/proj', ...over }).content);

describe('Code tab prompt', () => {
	it('says when a session is read-only, and leaves out the write tools', () => {
		const text = tab({ readOnly: true });
		expect(text).toContain('READ-ONLY');
		expect(text).not.toContain('- fs_write_text');
		expect(text).not.toContain('- fs_edit_text');
		expect(tab()).toContain('- fs_write_text');
		expect(tab()).not.toContain('READ-ONLY');
	});

	it('tells a worktree session its branch and that ignored files are missing', () => {
		const text = tab({ worktree: { branch: 'fix-login-fork' } });
		expect(text).toContain('fresh git worktree on branch fix-login-fork');
		expect(text).toContain('node_modules');
		expect(text).toContain('set up dependencies');
	});

	it('names the project folder and the background tools', () => {
		const text = tab();
		expect(text).toContain('Project folder: /proj');
		expect(text).toContain('- command_output');
		expect(text).toContain('- command_stop');
		expect(text).toContain('call haruspex_docs');
	});

	it('hands terminal-only commands to open_in_shell', () => {
		const text = tab();
		expect(text).toContain('- open_in_shell');
		expect(text).toContain('Use open_in_shell for it');
		expect(text).toContain('- open_in_editor');
		expect(text).not.toContain('run in a terminal and wait');
	});

	it('says nothing about a live terminal', () => {
		const text = tab();
		for (const terminalOnly of [
			'shell_read',
			'shell_input',
			'shell_interrupt',
			'shell_snapshot',
			'TWO ENVIRONMENTS',
			'live interactive terminal'
		]) {
			expect(text).not.toContain(terminalOnly);
		}
	});

	it('shares the working rules with the Shell variant', () => {
		const shell = String(
			buildShellCodeSystemPrompt({
				sessionContext: {
					os: 'linux',
					kernel: '6.0',
					distroId: null,
					distroName: null,
					distroVersion: null,
					shellPath: '/bin/bash',
					shellName: 'bash',
					shellVersion: null,
					home: null,
					hostname: null
				},
				currentCwd: '/proj',
				recentHistory: []
			}).content
		);
		const rules = (s: string) => s.slice(s.indexOf('HOW TO WORK:'));
		expect(rules(tab())).toBe(rules(shell));
	});

	it('puts AGENTS.md after the fixed rules and before the skill list', () => {
		const text = tab({
			projectInstructions: '\n\nPROJECT INSTRUCTIONS:\nrules',
			skillsSection: '\n\nSKILLS:\n- deploy: d'
		});
		const at = (s: string) => text.indexOf(s);
		expect(at('HOW TO WORK:')).toBeLessThan(at('PROJECT INSTRUCTIONS:'));
		expect(at('PROJECT INSTRUCTIONS:')).toBeLessThan(at('SKILLS:'));
	});
});
