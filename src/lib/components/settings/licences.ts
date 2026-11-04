/**
 * The third-party licences Settings → About → Licences shows: written at
 * build time by `scripts/build-licences.mjs` into the app's static files.
 */

export interface LicencedPackage {
	name: string;
	version: string;
	/** An SPDX expression, as the package states it. */
	licence: string;
	url: string;
	/** The package's licence and notice files, or '' when it ships none. */
	text: string;
}

export interface Sidecar {
	name: string;
	licence: string;
	url: string;
}

export interface Licences {
	packages: LicencedPackage[];
	sidecars: Sidecar[];
}

export const LICENCES_PATH = '/licences/third-party.json';

/** The build's licence list, or null when this build has none (a dev server started without it). */
export async function loadLicences(fetcher: typeof fetch = fetch): Promise<Licences | null> {
	try {
		const res = await fetcher(LICENCES_PATH);
		if (!res.ok) return null;
		const data = (await res.json()) as Partial<Licences>;
		if (!Array.isArray(data.packages)) return null;
		return { packages: data.packages, sidecars: Array.isArray(data.sidecars) ? data.sidecars : [] };
	} catch {
		return null;
	}
}

/** Packages that match `query` by name or licence, case-blind. */
export function filterLicences(packages: LicencedPackage[], query: string): LicencedPackage[] {
	const q = query.trim().toLowerCase();
	if (!q) return packages;
	return packages.filter(
		(p) => p.name.toLowerCase().includes(q) || p.licence.toLowerCase().includes(q)
	);
}
