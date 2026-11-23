import { describe, expect, it } from 'vitest';
import { isLoopbackHost } from './loopback';

const host = (url: string) => new URL(url).hostname;

describe('isLoopbackHost', () => {
	it('takes every spelling of this machine', () => {
		for (const url of [
			'http://localhost:8188',
			'http://comfy.localhost',
			'http://127.0.0.1:8188',
			'http://127.0.0.2',
			'http://[::1]:8188'
		]) {
			expect(isLoopbackHost(host(url)), url).toBe(true);
		}
	});

	it('refuses names and addresses that only look local', () => {
		for (const url of [
			'http://localhost.example.com',
			'http://notlocalhost',
			'http://10.0.0.1',
			'http://0.0.0.0',
			'http://[::]',
			'http://128.0.0.1'
		]) {
			expect(isLoopbackHost(host(url)), url).toBe(false);
		}
	});
});
