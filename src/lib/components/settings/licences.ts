/**
 * The third-party licences Settings → About → Licences shows: written at
 * build time by `scripts/build-licences.mjs` into the app's static files.
 */

export type PackageSource = 'npm' | 'crate' | 'python';

export interface LicencedPackage {
	source: PackageSource;
	name: string;
	version: string;
	/** An SPDX expression, as the package states it. */
	licence: string;
	url: string;
	/** Indexes into `Licences.texts`: the package's licence and notice files. */
	text: number[];
}

/** A program the app runs beside itself (a sidecar, or Pyodide). */
export interface Program {
	name: string;
	licence: string;
	url: string;
	text: number[];
}

export interface Licences {
	/** Each licence file once; entries point into it. */
	texts: string[];
	packages: LicencedPackage[];
	sidecars: Program[];
}

export const LICENCES_PATH = '/licences/third-party.json';

export const SOURCE_LABELS: Record<PackageSource, string> = {
	npm: 'npm',
	crate: 'Rust',
	python: 'Python'
};

const ids = (v: unknown): number[] =>
	Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n)) : [];

/** The build's licence list, or null when this build has none (a dev server started without it). */
export async function loadLicences(fetcher: typeof fetch = fetch): Promise<Licences | null> {
	try {
		const res = await fetcher(LICENCES_PATH);
		if (!res.ok) return null;
		const data = (await res.json()) as Partial<Licences>;
		if (!Array.isArray(data.packages) || !Array.isArray(data.texts)) return null;
		return {
			texts: data.texts,
			packages: data.packages.map((p) => ({ ...p, source: p.source ?? 'npm', text: ids(p.text) })),
			sidecars: (Array.isArray(data.sidecars) ? data.sidecars : []).map((s) => ({
				...s,
				text: ids(s.text)
			}))
		};
	} catch {
		return null;
	}
}

/** The licence text of an entry: its files, one after another, or '' when it has none. */
export function textOf(licences: Licences, entry: { text: number[] }): string {
	return entry.text
		.map((i) => licences.texts[i])
		.filter(Boolean)
		.join('\n\n');
}

/** Packages that match `query` by name, licence or source, case-blind. */
export function filterLicences(packages: LicencedPackage[], query: string): LicencedPackage[] {
	const q = query.trim().toLowerCase();
	if (!q) return packages;
	return packages.filter(
		(p) =>
			p.name.toLowerCase().includes(q) ||
			p.licence.toLowerCase().includes(q) ||
			SOURCE_LABELS[p.source].toLowerCase() === q
	);
}
