import { describe, it, expect } from 'vitest';
import {
	buildShellSystemPrompt,
	shellTerminalNote,
	type ShellSessionContext
} from '#lib/shell/system-prompt.ts';

function ctx(shellPath: string, shellName: string): ShellSessionContext {
	return {
		os: 'linux',
		kernel: '6.0',
		distroId: null,
		distroName: null,
		distroVersion: null,
		shellPath,
		shellName,
		shellVersion: null,
		home: null,
		hostname: null
	};
}

function promptFor(sessionContext: ShellSessionContext, fullAccess: boolean): string {
	const opts = { sessionContext, currentCwd: '/proj', recentHistory: [], fullAccess };
	return String(buildShellSystemPrompt(opts).content);
}

const fullAccess = (opts: Parameters<typeof buildShellSystemPrompt>[0]) =>
	buildShellSystemPrompt({ ...opts, fullAccess: true });

describe('shell system prompts under fish', () => {
	it('tell the model to write fish syntax in both modes', () => {
		for (const code of [true, false]) {
			const prompt = promptFor(ctx('/usr/bin/fish', 'fish'), code);
			expect(prompt).toContain('This shell is fish, not bash');
			expect(prompt).toContain("bash -c '…'");
		}
	});

	it('say nothing about fish for bash', () => {
		for (const code of [true, false]) {
			expect(promptFor(ctx('/bin/bash', 'bash'), code)).not.toContain('fish');
		}
	});
});

describe('shell system prompts — skills section', () => {
	const base = { sessionContext: ctx('/bin/bash', 'bash'), currentCwd: '/proj', recentHistory: [] };

	it('carries the section in both modes when given one, and nothing otherwise', () => {
		const section = '\n\nSKILLS:\n- deploy: Ship it.';
		for (const build of [fullAccess, buildShellSystemPrompt]) {
			expect(String(build({ ...base, skillsSection: section }).content)).toContain(
				'- deploy: Ship it.'
			);
			expect(String(build(base).content)).not.toContain('SKILLS:');
		}
	});
});

describe('shell prompts — project instructions', () => {
	const base = { sessionContext: ctx('/bin/bash', 'bash'), currentCwd: '/proj', recentHistory: [] };

	it('comes after the fixed rules and before the skill list', () => {
		const text = String(
			fullAccess({
				...base,
				projectInstructions: '\n\nPROJECT INSTRUCTIONS:\nrules',
				skillsSection: '\n\nSKILLS:\n- deploy: d'
			}).content
		);
		const at = (s: string) => text.indexOf(s);
		expect(at('FULL ACCESS:')).toBeLessThan(at('PROJECT INSTRUCTIONS:'));
		expect(at('PROJECT INSTRUCTIONS:')).toBeLessThan(at('SKILLS:'));
	});

	it('is in the troubleshooting prompt too, before the skill list', () => {
		const text = String(
			buildShellSystemPrompt({
				...base,
				projectInstructions: '\n\nPROJECT INSTRUCTIONS:\nx',
				skillsSection: '\n\nSKILLS:\n- deploy: d'
			}).content
		);
		expect(text.indexOf('CONVERSATION RULES:')).toBeLessThan(text.indexOf('PROJECT INSTRUCTIONS:'));
		expect(text.indexOf('PROJECT INSTRUCTIONS:')).toBeLessThan(text.indexOf('SKILLS:'));
	});
});

describe('shell system prompts — the user guide', () => {
	it('point the model at haruspex_docs in both modes', () => {
		for (const code of [true, false]) {
			expect(promptFor(ctx('/bin/bash', 'bash'), code)).toContain('call haruspex_docs');
		}
	});
});

describe('shell system prompt — Full access', () => {
	const base = { sessionContext: ctx('/bin/bash', 'bash'), currentCwd: '/proj', recentHistory: [] };
	const readOnly = String(buildShellSystemPrompt(base).content);
	const full = String(fullAccess(base).content);

	it('is the shell assistant prompt, not the coding prompt', () => {
		expect(full).toContain("You are Haruspex's shell troubleshooting assistant");
		expect(full).not.toContain('coding agent');
		expect(full).not.toContain('HOW TO WORK:');
		// Everything up to the addendum is the Read-only prompt, minus the two
		// lines that say it can't run or edit anything.
		const strip = (s: string) =>
			s
				.split('\n')
				.filter((l) => !l.startsWith('- You are read-only') && !l.startsWith('- NEVER pretend'))
				.join('\n');
		expect(full.slice(0, full.indexOf('\n\nFULL ACCESS:'))).toBe(strip(readOnly));
	});

	it('adds the terminal and edit tools, and the two-environments warning', () => {
		for (const tool of [
			'run_command',
			'background:true',
			'watch:true',
			'shell_read',
			'shell_input',
			'shell_interrupt',
			'shell_snapshot',
			'fs_write_text',
			'fs_edit_text',
			'TWO ENVIRONMENTS:'
		]) {
			expect(full).toContain(tool);
			expect(readOnly).not.toContain(tool);
		}
	});

	it('Read-only says it has no execute tool and points at Full access', () => {
		expect(readOnly).toContain('You have no execute tool');
		expect(readOnly).toContain('switch this shell to Full access');
		expect(full).not.toContain('You have no execute tool');
		expect(full).not.toContain('You are read-only');
	});
});

describe("the terminal's live state", () => {
	it('stays out of the system prompt, so it is the same whatever the terminal does', () => {
		const prompt = String(
			buildShellSystemPrompt({ sessionContext: ctx('/bin/bash', 'bash') }).content
		);
		expect(prompt).not.toContain('Current working directory');
		expect(prompt).not.toContain('Recent shell history');
	});

	it('goes in a note: cwd, recent commands, and a nested session', () => {
		const note = shellTerminalNote({
			currentCwd: '/srv/app',
			recentHistory: ['git pull', 'make'],
			nestedSession: { kind: 'remote', program: 'ssh', target: 'box', command: 'ssh box' },
			fullAccess: true
		})!;
		expect(note).toContain('Current working directory: /srv/app');
		expect(note).toContain('  git pull\n  make');
		expect(note).toContain('ATTENTION');
		expect(note).toContain('run_command');
	});

	it('is nothing when there is nothing to say', () => {
		expect(shellTerminalNote({ currentCwd: null, recentHistory: [] })).toBeNull();
	});
});
