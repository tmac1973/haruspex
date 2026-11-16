import { describe, it, expect } from 'vitest';
import { cameraDataAllowed, isTrustableServer } from './trust';

describe('isTrustableServer', () => {
	it.each([
		'http://192.168.1.20:8080',
		'http://10.0.0.5:8080',
		'http://172.16.0.1',
		'http://172.31.255.254:1234/v1',
		'http://127.0.0.1:8765',
		'http://169.254.10.10',
		'http://[::1]:8080',
		'http://[fd00::1]:8080',
		'http://[fc12:3456::1]',
		'http://[fe80::1]',
		'http://[::ffff:192.168.1.5]:8080',
		'http://localhost:8080',
		'http://gpubox.local:8080',
		'https://llm.home.internal/',
		'http://compute:3000',
		' http://192.168.0.2:8080/ '
	])('trusts %s', (url) => {
		expect(isTrustableServer(url)).toBe(true);
	});

	it.each([
		'http://8.8.8.8',
		'http://172.15.0.1',
		'http://172.32.0.1',
		'http://192.169.1.1',
		'http://[2001:db8::1]',
		'http://[::ffff:8.8.8.8]',
		'https://api.example.com',
		'https://local.example.com',
		'https://example.internal.com',
		'https://openrouter.ai/api',
		'not a url',
		''
	])('refuses %s', (url) => {
		expect(isTrustableServer(url)).toBe(false);
	});
});

describe('cameraDataAllowed', () => {
	const trusted = ['http://192.168.1.20:8080/'];

	it('allows the local model', () => {
		expect(cameraDataAllowed({ kind: 'local', baseUrl: 'http://127.0.0.1:8765' }, [])).toBe(true);
	});

	it('refuses OpenRouter, even when listed', () => {
		const url = 'https://openrouter.ai/api';
		expect(cameraDataAllowed({ kind: 'openrouter', baseUrl: url }, [url])).toBe(false);
	});

	it('allows a remote server the user trusted', () => {
		expect(
			cameraDataAllowed({ kind: 'remote', baseUrl: 'http://192.168.1.20:8080' }, trusted)
		).toBe(true);
	});

	it('refuses a remote server the user did not trust', () => {
		expect(
			cameraDataAllowed({ kind: 'remote', baseUrl: 'http://192.168.1.21:8080' }, trusted)
		).toBe(false);
	});

	it('refuses a public server even if the settings list it', () => {
		const url = 'https://api.example.com';
		expect(cameraDataAllowed({ kind: 'remote', baseUrl: url }, [url])).toBe(false);
	});
});
