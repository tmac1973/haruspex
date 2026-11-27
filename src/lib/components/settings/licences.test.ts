import { describe, expect, it } from 'vitest';
import {
	filterLicences,
	loadLicences,
	LICENCES_PATH,
	textOf,
	type LicencedPackage,
	type PackageSource
} from './licences';

const pkg = (
	name: string,
	licence: string,
	source: PackageSource = 'npm',
	text: number[] = []
): LicencedPackage => ({ source, name, version: '1.0.0', licence, url: '', text });

describe('loadLicences', () => {
	it('reads the list from the build', async () => {
		const data = {
			texts: ['MIT text', 'Apache text'],
			packages: [
				pkg('three', 'MIT', 'npm', [0]),
				pkg('serde', 'MIT OR Apache-2.0', 'crate', [0, 1])
			],
			sidecars: [{ name: 'uv', licence: 'MIT', url: 'u', text: [1] }]
		};
		const fetcher = async (url: string | URL | Request) => {
			expect(url).toBe(LICENCES_PATH);
			return new Response(JSON.stringify(data));
		};
		expect(await loadLicences(fetcher as typeof fetch)).toEqual(data);
	});

	it('gives null when the build has none, or an older list', async () => {
		const missing = async () => new Response('', { status: 404 });
		expect(await loadLicences(missing as typeof fetch)).toBeNull();
		const html = async () => new Response('<!doctype html>');
		expect(await loadLicences(html as typeof fetch)).toBeNull();
		const old = async () => new Response(JSON.stringify({ packages: [], sidecars: [] }));
		expect(await loadLicences(old as typeof fetch)).toBeNull();
	});
});

describe('textOf', () => {
	it("joins an entry's files, skipping indexes the list lacks", () => {
		const licences = { texts: ['A', 'B'], packages: [], sidecars: [] };
		expect(textOf(licences, { text: [1, 0] })).toBe('B\n\nA');
		expect(textOf(licences, { text: [7] })).toBe('');
		expect(textOf(licences, { text: [] })).toBe('');
	});
});

describe('filterLicences', () => {
	it('matches the name, the licence or the source, case-blind', () => {
		const all = [pkg('three', 'MIT'), pkg('pyodide', 'MPL-2.0'), pkg('numpy', 'BSD', 'python')];
		expect(filterLicences(all, ' ')).toEqual(all);
		expect(filterLicences(all, 'mpl').map((p) => p.name)).toEqual(['pyodide']);
		expect(filterLicences(all, 'THR').map((p) => p.name)).toEqual(['three']);
		expect(filterLicences(all, 'python').map((p) => p.name)).toEqual(['numpy']);
	});
});
