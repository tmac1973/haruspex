import { describe, expect, it } from 'vitest';
import { pickedServer } from './generationServers.svelte.ts';

describe('pickedServer', () => {
	it('takes the saved server’s address and key', () => {
		expect(
			pickedServer({ kind: 'llama-toolchest', url: 'http://b:8080', keyId: 'key-b' }, 'key-a')
		).toEqual({ url: 'http://b:8080', keyId: 'key-b' });
	});

	it('does not carry the old key to a server that has none', () => {
		expect(pickedServer({ kind: 'comfyui', url: 'http://c:8188', keyId: null }, 'key-a')).toEqual({
			url: 'http://c:8188',
			keyId: null
		});
	});

	it('clears the address and keeps the key when no saved server is picked', () => {
		expect(pickedServer(null, 'key-a')).toEqual({ url: '', keyId: 'key-a' });
	});
});
