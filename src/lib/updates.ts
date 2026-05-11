// Lightweight GitHub release check. Called once at startup from the
// layout — if the latest published release on GitHub is newer than
// the running app version, the header shows a "New version available"
// link to the release page.

const LATEST_RELEASE_API = 'https://api.github.com/repos/tmac1973/haruspex/releases/latest';
const RELEASES_PAGE = 'https://github.com/tmac1973/haruspex/releases/latest';

export interface UpdateInfo {
	version: string;
	url: string;
}

/**
 * Component-wise compare of two `MAJOR.MINOR.PATCH` strings. Returns
 * positive if `a > b`, negative if `a < b`, zero if equal. Missing
 * components are treated as 0 so `1.2` is equal to `1.2.0`. Non-numeric
 * pre-release suffixes are stripped (split on `-`) — release-please
 * doesn't currently produce them, but it's cheap defensive parsing.
 */
export function compareVersions(a: string, b: string): number {
	const parse = (v: string) =>
		v
			.replace(/^v/, '')
			.split('-')[0]
			.split('.')
			.map((n) => parseInt(n, 10) || 0);
	const pa = parse(a);
	const pb = parse(b);
	const len = Math.max(pa.length, pb.length);
	for (let i = 0; i < len; i++) {
		const x = pa[i] ?? 0;
		const y = pb[i] ?? 0;
		if (x !== y) return x - y;
	}
	return 0;
}

/**
 * Returns the latest release if it's newer than `currentVersion`,
 * otherwise `null`. Network errors, rate limits, and malformed
 * responses are swallowed and return `null` — the version check is
 * a nice-to-have, not load-bearing.
 */
export async function checkForUpdate(currentVersion: string): Promise<UpdateInfo | null> {
	try {
		const res = await fetch(LATEST_RELEASE_API, {
			headers: { Accept: 'application/vnd.github+json' }
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { tag_name?: string; html_url?: string };
		const tag = data.tag_name;
		if (!tag) return null;
		if (compareVersions(tag, currentVersion) <= 0) return null;
		return {
			version: tag.replace(/^v/, ''),
			url: data.html_url || RELEASES_PAGE
		};
	} catch {
		return null;
	}
}
