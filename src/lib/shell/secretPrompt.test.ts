import { describe, it, expect } from 'vitest';
import { secretPrompt } from './secretPrompt';

describe('secretPrompt', () => {
	it.each([
		'[sudo] password for tim: ',
		'Reading package lists...\n[sudo] password for tim:',
		'Password: ',
		"tim@server.lan's password: ",
		'doas (tim@box) password: ',
		"Enter passphrase for key '/home/tim/.ssh/id_ed25519': ",
		'Enter PIN for authenticator: ',
		'Password:\n'
	])('sees a prompt in %j', (out) => {
		expect(secretPrompt(out)).not.toBeNull();
	});

	it.each([
		'',
		'Reading package lists... Done',
		'password: hunter2 was rejected\nDone.',
		'Set the password: in the config file\nok\n',
		'Do you want to continue? [Y/n] '
	])('sees no prompt in %j', (out) => {
		expect(secretPrompt(out)).toBeNull();
	});

	it('returns the prompt line itself', () => {
		expect(secretPrompt('foo\n[sudo] password for tim: ')).toBe('[sudo] password for tim:');
	});
});
