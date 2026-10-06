import { describe, it, expect } from 'vitest';
import {
	buildShellCodeSystemPrompt,
	buildShellSystemPrompt,
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
