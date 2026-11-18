import { describe, it, expect } from 'vitest';
import { isLocalNavigation } from './_playwrightNavigate';

const navigate = {
	name: 'browser_navigate',
	inputSchema: { type: 'object', properties: { url: { type: 'string' } } }
};
const local = (url: unknown) => isLocalNavigation(navigate, { url });

describe('isLocalNavigation', () => {
	it('lets a page on this computer through', () => {
		for (const url of [
			'http://localhost:8123/index.html?v=5',
			'https://localhost/',
			'http://game.localhost:5173/',
			'http://127.0.0.1:3000',
			'http://127.1/',
			'http://[::1]:8080/'
		]) {
			expect(local(url), url).toBe(true);
		}
	});

	it('asks for anything else', () => {
		for (const url of [
			'https://example.com/',
			'http://localhost.example.com/',
			'http://localhost@example.com/',
			'http://192.168.1.10/',
			'http://0.0.0.0:8000/',
			'file:///etc/passwd',
			'data:text/html,hi',
			'localhost:8123',
			'not a url',
			42
		]) {
			expect(local(url), String(url)).toBe(false);
		}
	});

	it('only for Playwright’s navigate tool', () => {
		const url = { url: 'http://localhost/' };
		expect(isLocalNavigation({ ...navigate, name: 'browser_click' }, url)).toBe(false);
		expect(isLocalNavigation({ name: 'browser_navigate', inputSchema: {} }, url)).toBe(false);
	});
});
