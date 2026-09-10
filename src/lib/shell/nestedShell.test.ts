import { describe, it, expect } from 'vitest';
import { classifyNestedShell, unhookableShellMessage } from './nestedShell';

describe('classifyNestedShell', () => {
	it('recognizes a bare shell as hookable', () => {
		expect(classifyNestedShell('bash')).toEqual({
			program: 'bash',
			hookable: true,
			command: 'bash'
		});
		expect(classifyNestedShell('zsh')?.hookable).toBe(true);
	});

	it('accepts an absolute path and interactive flags', () => {
		expect(classifyNestedShell('/usr/bin/bash -l')).toMatchObject({
			program: 'bash',
			hookable: true
		});
		expect(classifyNestedShell('bash --norc --noprofile')?.hookable).toBe(true);
	});

	it('sees through env assignments and wrappers', () => {
		expect(classifyNestedShell('sudo -u tim zsh')).toMatchObject({ program: 'zsh' });
		expect(classifyNestedShell('FOO=bar exec bash')).toMatchObject({ program: 'bash' });
	});

	it('marks the shells we ship no hook for as unhookable', () => {
		expect(classifyNestedShell('fish')).toMatchObject({ program: 'fish', hookable: false });
		expect(classifyNestedShell('nu')?.hookable).toBe(false);
		expect(classifyNestedShell('sh')?.hookable).toBe(false);
	});

	it('is not a nested shell when the shell was handed a command', () => {
		expect(classifyNestedShell("sh -c 'make all'")).toBeNull();
		expect(classifyNestedShell('bash -ec ./deploy')).toBeNull();
		expect(classifyNestedShell('bash --command foo')).toBeNull();
	});

	it('is not a nested shell when the shell was handed a script', () => {
		expect(classifyNestedShell('bash deploy.sh')).toBeNull();
		expect(classifyNestedShell('zsh -l ./setup.zsh')).toBeNull();
	});

	it('leaves anything that is not a shell alone', () => {
		expect(classifyNestedShell('npm run dev')).toBeNull();
		expect(classifyNestedShell('python')).toBeNull();
		expect(classifyNestedShell('ssh box')).toBeNull();
		expect(classifyNestedShell('')).toBeNull();
		expect(classifyNestedShell(null)).toBeNull();
	});

	it('leaves compound command lines alone', () => {
		// `make && bash` reached bash only if make passed; the capture is the
		// whole line either way, so it is too ambiguous to act on.
		expect(classifyNestedShell('make && bash')).toBeNull();
		expect(classifyNestedShell('bash < script')).toBeNull();
		expect(classifyNestedShell('bash &')).toBeNull();
	});
});

describe('unhookableShellMessage', () => {
	it('names the shell, the tools that do work, and the settings path', () => {
		const msg = unhookableShellMessage({ program: 'fish', hookable: false, command: 'fish' });
		expect(msg).toContain('`fish`');
		expect(msg).toContain('shell_input');
		expect(msg).toContain('shell_read');
		expect(msg).toContain('exit');
		expect(msg).toContain('Settings → Shell');
	});
});
