import { describe, expect, it } from 'vitest';
import { filterLicences, loadLicences, LICENCES_PATH } from './licences';

const pkg = (name: string, licence: string) => ({
	name,
	version: '1.0.0',
	licence,
	url: '',
	text: ''
});

describe('loadLicences', () => {
	it('reads the list from the build', async () => {
		const data = {
			packages: [pkg('three', 'MIT')],
			sidecars: [{ name: 'uv', licence: 'MIT', url: 'u' }]
		};
		const fetcher = async (url: string | URL | Request) => {
			expect(url).toBe(LICENCES_PATH);
			return new Response(JSON.stringify(data));
		};
		expect(await loadLicences(fetcher as typeof fetch)).toEqual(data);
	});

	it('gives null when the build has none', async () => {
		const missing = async () => new Response('', { status: 404 });
		expect(await loadLicences(missing as typeof fetch)).toBeNull();
		const html = async () => new Response('<!doctype html>');
		expect(await loadLicences(html as typeof fetch)).toBeNull();
	});
});

describe('filterLicences', () => {
	it('matches the name or the licence, case-blind', () => {
		const all = [pkg('three', 'MIT'), pkg('pyodide', 'MPL-2.0')];
		expect(filterLicences(all, ' ')).toEqual(all);
		expect(filterLicences(all, 'mpl').map((p) => p.name)).toEqual(['pyodide']);
		expect(filterLicences(all, 'THR').map((p) => p.name)).toEqual(['three']);
	});
});
