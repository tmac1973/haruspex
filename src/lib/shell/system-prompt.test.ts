import { describe, it, expect } from 'vitest';
import { buildShellSystemPrompt, type ShellSessionContext } from '#lib/shell/system-prompt.ts';
import { buildShellCodeSystemPrompt } from '#lib/code/system-prompt.ts';

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

function promptFor(sessionContext: ShellSessionContext, code: boolean): string {
	const opts = { sessionContext, currentCwd: '/proj', recentHistory: [] };
	const msg = code ? buildShellCodeSystemPrompt(opts) : buildShellSystemPrompt(opts);
	return String(msg.content);
}

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
		for (const build of [buildShellCodeSystemPrompt, buildShellSystemPrompt]) {
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
			buildShellCodeSystemPrompt({
				...base,
				projectInstructions: '\n\nPROJECT INSTRUCTIONS:\nrules',
				skillsSection: '\n\nSKILLS:\n- deploy: d'
			}).content
		);
		const at = (s: string) => text.indexOf(s);
		expect(at('HOW TO WORK:')).toBeLessThan(at('PROJECT INSTRUCTIONS:'));
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
