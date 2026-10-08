/**
 * The user guide in `docs/guide/`, compiled into the app so the pages always
 * match the build running. Read by the `haruspex_docs` tool, which lets the
 * model answer questions about Haruspex itself (plan/self-docs/).
 */

const RAW = import.meta.glob('/docs/guide/*.md', {
	query: '?raw',
	import: 'default',
	eager: true
}) as Record<string, string>;

/** The order the index lists pages in; any page not named here goes last. */
const ORDER = [
	'getting-started',
	'models',
	'chat',
	'shell',
	'skills',
	'jobs',
	'memory',
	'images',
	'integrations',
	'search-and-network',
	'remote-access',
	'settings',
	'shortcuts',
	'troubleshooting'
];

export interface GuidePage {
	/** The file name without `.md`: what the tool's `page` argument takes. */
	name: string;
	title: string;
	/** One line, for the index. */
	description: string;
	/** The page after its frontmatter. */
	body: string;
}

/** Split a page into its frontmatter fields and its body. */
export function parsePage(name: string, raw: string): GuidePage {
	const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
	const front: Record<string, string> = {};
	for (const line of (m?.[1] ?? '').split('\n')) {
		const i = line.indexOf(':');
		if (i > 0) front[line.slice(0, i).trim()] = line.slice(i + 1).trim();
	}
	return {
		name,
		title: front.title ?? name,
		description: front.description ?? '',
		body: (m ? raw.slice(m[0].length) : raw).trim()
	};
}

function rank(name: string): number {
	const i = ORDER.indexOf(name);
	return i < 0 ? ORDER.length : i;
}

export const GUIDE_PAGES: readonly GuidePage[] = Object.entries(RAW)
	.map(([path, raw]) => parsePage(path.split('/').pop()!.replace(/\.md$/, ''), raw))
	.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));

export function guidePage(name: string): GuidePage | undefined {
	return GUIDE_PAGES.find((p) => p.name === name);
}

/** The pages as the tool's index lists them: one line each. */
export function guideIndex(): string {
	return GUIDE_PAGES.map((p) => `- ${p.name} — ${p.title}: ${p.description}`).join('\n');
}
