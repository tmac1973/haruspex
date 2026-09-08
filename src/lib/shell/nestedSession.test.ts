import { describe, it, expect } from 'vitest';
import {
	classifyNestedSession,
	describeNestedSession,
	nestedReadNote,
	nestedSessionPromptBlock,
	nestedWriteBlockedMessage
} from './nestedSession';

describe('classifyNestedSession', () => {
	it('returns null when nothing is running', () => {
		expect(classifyNestedSession(null)).toBeNull();
		expect(classifyNestedSession('')).toBeNull();
		expect(classifyNestedSession('   ')).toBeNull();
	});

	it('leaves local long-running commands alone', () => {
		// These hold the terminal too, but the file tools are still pointed at
		// the right filesystem — warning about them would be noise.
		for (const cmd of [
			'npm run dev',
			'cargo build --release',
			'python',
			'psql mydb',
			'top',
			'su - tim',
			'sudo -i',
			'git rebase -i main'
		]) {
			expect(classifyNestedSession(cmd), cmd).toBeNull();
		}
	});

	it('detects ssh and pulls out the host', () => {
		const n = classifyNestedSession('ssh tim@box.example.com');
		expect(n).toMatchObject({ kind: 'remote', program: 'ssh', target: 'tim@box.example.com' });
	});

	it('skips ssh flags that take a value', () => {
		expect(classifyNestedSession('ssh -p 2222 -i ~/.ssh/id_ed25519 box')?.target).toBe('box');
		expect(classifyNestedSession('ssh -tt box')?.target).toBe('box');
	});

	it('sees through env assignments and wrapper programs', () => {
		expect(classifyNestedSession('TERM=xterm sudo ssh box')).toMatchObject({
			kind: 'remote',
			target: 'box'
		});
		expect(classifyNestedSession('sshpass -p hunter2 ssh admin@nas')).toMatchObject({
			kind: 'remote',
			program: 'ssh',
			target: 'admin@nas'
		});
	});

	it('keeps the full command line for display', () => {
		expect(classifyNestedSession('  sudo ssh box  ')?.command).toBe('sudo ssh box');
	});

	it('detects container entry, but not other subcommands', () => {
		expect(classifyNestedSession('docker exec -it web bash')).toMatchObject({
			kind: 'container',
			program: 'docker',
			target: 'web'
		});
		expect(classifyNestedSession('kubectl exec -it api-0 -- sh')).toMatchObject({
			kind: 'container',
			target: 'api-0'
		});
		expect(classifyNestedSession('distrobox enter arch')).toMatchObject({
			kind: 'container',
			target: 'arch'
		});
		// Not entries: these run and exit without owning the terminal.
		expect(classifyNestedSession('docker ps -a')).toBeNull();
		expect(classifyNestedSession('kubectl get pods')).toBeNull();
		expect(classifyNestedSession('docker run --rm img build')).toBeNull();
	});

	it('treats an interactive docker run as an entry', () => {
		expect(classifyNestedSession('docker run -it ubuntu bash')).toMatchObject({
			kind: 'container',
			target: 'ubuntu'
		});
	});

	it('classifies by the last stage of a chain', () => {
		expect(
			classifyNestedSession('cat key.pub | ssh box "cat >> .ssh/authorized_keys"')
		).toMatchObject({ kind: 'remote', target: 'box' });
		// The ssh part already finished; vim is what holds the terminal now.
		expect(classifyNestedSession('ssh box uptime && vim notes.md')).toBeNull();
	});

	it('handles vagrant / virsh / gcloud entries', () => {
		expect(classifyNestedSession('vagrant ssh')).toMatchObject({ kind: 'remote' });
		expect(classifyNestedSession('virsh console vm1')).toMatchObject({
			kind: 'remote',
			target: 'vm1'
		});
		expect(classifyNestedSession('gcloud compute ssh worker-1')).toMatchObject({
			kind: 'remote',
			target: 'worker-1'
		});
	});
});

describe('messages', () => {
	const remote = classifyNestedSession('ssh box')!;

	it('names the session and the machine the tools actually touch', () => {
		expect(describeNestedSession(remote)).toContain('`ssh box`');
		expect(describeNestedSession(remote)).toContain('box');

		const blocked = nestedWriteBlockedMessage('fs_write_text', remote);
		expect(blocked).toContain('fs_write_text did not run');
		expect(blocked).toContain('shell_input');

		expect(nestedReadNote(remote)).toContain('NOT from that host');
	});

	it('gives the two shell modes the advice each can act on', () => {
		// Code mode drives the session itself…
		const code = nestedSessionPromptBlock(remote, 'code');
		expect(code).toContain('run_command, shell_input and shell_read act on that host');
		expect(code).toContain('never fs_write_text/fs_edit_text');

		// …while the read-only assistant only suggests commands, which the user
		// pastes into that same session.
		const chat = nestedSessionPromptBlock(remote, 'chat');
		expect(chat).toContain('Commands you suggest');
		expect(chat).not.toContain('run_command');
	});
});
