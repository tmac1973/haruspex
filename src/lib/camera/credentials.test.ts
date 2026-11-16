import { describe, it, expect } from 'vitest';
import { redactCameraError, splitUrlCredentials } from './credentials';

describe('splitUrlCredentials', () => {
	it('takes the user name and password out of the address', () => {
		expect(splitUrlCredentials(' rtsp://admin:secret@192.168.1.50:554/ch0 ')).toEqual({
			url: 'rtsp://192.168.1.50:554/ch0',
			username: 'admin',
			password: 'secret'
		});
	});

	it('decodes an escaped password, and keeps an unescaped @ in it', () => {
		expect(splitUrlCredentials('rtsp://u:p%40ss@cam/ch0').password).toBe('p@ss');
		expect(splitUrlCredentials('rtsp://u:p@ss@cam/ch0')).toMatchObject({
			url: 'rtsp://cam/ch0',
			password: 'p@ss'
		});
	});

	it('takes a user name with no password', () => {
		expect(splitUrlCredentials('rtsp://admin@cam/ch0')).toEqual({
			url: 'rtsp://cam/ch0',
			username: 'admin',
			password: null
		});
	});

	it('leaves an address with no sign-in, or an @ only in its path, alone', () => {
		for (const url of ['rtsp://cam:554/ch0', 'rtsp://cam/live@main']) {
			expect(splitUrlCredentials(url)).toEqual({ url, username: null, password: null });
		}
	});
});

describe('redactCameraError', () => {
	it('takes out the password and any sign-in in an address', () => {
		const shown = redactCameraError(
			'rtsp://admin:hunter2@cam/ch0: 401 Unauthorized (hunter2)',
			'hunter2'
		);
		expect(shown).not.toContain('hunter2');
		expect(shown).toContain('rtsp://***@cam/ch0');
	});
});
