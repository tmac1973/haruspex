import { describe, it, expect } from 'vitest';
import { buildCodeSystemPrompt, delegationHint, isMacOS } from '#lib/code/systemPrompt.ts';

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

	it('tells a WSL session it is Linux in its distro, never the macOS note', () => {
		const text = tab({ root: '/home/tim/p', wslDistro: 'Ubuntu', macOS: true });
		expect(text).toContain('inside the WSL distro Ubuntu');
		expect(text).toContain('*.exe');
		expect(text).not.toContain('bash 3.2');
		expect(tab()).not.toContain('WSL');
	});

	it('tells a session in a Windows folder which PowerShell runs its commands', () => {
		const seven = tab({ root: 'C:\\p', powershell: { pwsh: true }, macOS: false });
		expect(seven).toContain('PowerShell 7');
		expect(seven).not.toContain('no && or ||');
		const five = tab({ root: 'C:\\p', powershell: { pwsh: false }, macOS: false });
		expect(five).toContain('Windows PowerShell 5.1');
		expect(five).toContain('no && or ||');
	});

	it('steers away from bash-4 features on macOS only', () => {
		const mac = tab({ macOS: true });
		expect(mac).toContain('bash 3.2');
		expect(mac).toContain('declare -A');
		expect(mac).toContain('mapfile');
		expect(mac).toContain('|&');
		expect(tab({ macOS: false })).not.toContain('bash 3.2');
		// jsdom's user agent is Linux.
		expect(tab()).not.toContain('bash 3.2');
	});

	it('reads macOS from the user agent', () => {
		expect(
			isMacOS(
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'
			)
		).toBe(true);
		expect(
			isMacOS('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)')
		).toBe(false);
		expect(isMacOS('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')).toBe(false);
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

	it('without the hand-off, says the user runs such a command themselves', () => {
		const text = tab({ shellHandoff: false });
		expect(text).not.toContain('open_in_shell');
		expect(text).toContain('the user runs it themselves');
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

describe('Code tab prompt with subtasks', () => {
	it('tells the agent about delegate only when it has the tool', () => {
		expect(tab({ delegate: 'read' })).toContain('SUBTASKS:');
		expect(tab()).not.toContain('SUBTASKS:');
	});

	it('gives a subtask its task, read-only tools and the report limit, without the parent’s tools', () => {
		const text = tab({ subtask: { task: 'Find the callers of foo.' } });
		expect(text).toContain('YOUR TASK:\nFind the callers of foo.');
		expect(text).toContain('under 4000 characters');
		expect(text).toContain('only commands that read');
		expect(text).toContain('tests, builds and installs included');
		expect(text).not.toContain('- fs_write_text');
		expect(text).not.toContain('open_in_shell');
		expect(text).not.toContain('command_output');
		expect(text).not.toContain('SUBTASKS:');
	});
});

describe('Code tab prompt with writing subtasks', () => {
	it('tells the agent about write mode only when it is offered', () => {
		expect(tab({ delegate: 'write' })).toContain('mode write:');
		expect(tab({ delegate: 'read' })).not.toContain('mode write:');
	});

	it('gives a writing subtask its copy, the write tools and the shared folders', () => {
		const text = tab({
			subtask: {
				task: 'Add a mute toggle.',
				worktree: { root: '/w', linked: ['node_modules', '.venv'] }
			}
		});
		expect(text).toContain('Project folder: /w');
		expect(text).toContain('your own copy of the project');
		expect(text).toContain('node_modules, .venv are shared');
		expect(text).toContain('- fs_edit_text');
		expect(text).toContain("Don't commit");
		expect(text).not.toContain('only commands that read');
	});
});

describe('Code tab prompt with background subtasks', () => {
	it('tells the agent how background subtasks report', () => {
		expect(tab({ delegate: 'read' })).toContain('background: true returns at once');
	});
});

describe('delegationHint', () => {
	const asks = (n: number) =>
		Array.from({ length: n }, (_, i) => `${i + 1}. ask ${i + 1}`).join('\n');

	it('needs three numbered asks and the tool', () => {
		expect(delegationHint(asks(2), 'read')).toBeNull();
		expect(delegationHint(asks(3), undefined)).toBeNull();
		expect(delegationHint(`Steps:\n${asks(4)}`, 'read')).toContain('lists 4 separate asks');
		expect(delegationHint('1) one\n2) two\n3) three', 'read')).toContain('lists 3');
		expect(delegationHint('- a\n- b\n- c\n- d', 'read')).toBeNull();
	});

	it('mentions writing subtasks only when they are offered', () => {
		expect(delegationHint(asks(3), 'write')).toContain('mode write');
		expect(delegationHint(asks(3), 'read')).not.toContain('mode write');
	});

	it('is matched by a firmer line in the prompt', () => {
		expect(tab({ delegate: 'read' })).toContain('delegate them in your FIRST response');
	});
});
