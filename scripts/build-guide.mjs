#!/usr/bin/env node
// Render the user guide (docs/guide/*.md) as pages of the website, into
// site/guide/: /guide/ is getting-started, and every page is /guide/<name>/.
// Run by .github/workflows/pages.yml before it publishes site/, and by CI to
// catch a page that won't render. The output is gitignored: the Markdown is
// the only source, the same one the app compiles in.
//
// Usage: node scripts/build-guide.mjs [out dir, default site/guide]

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Marked } from 'marked';

const FIRST = 'getting-started';

/**
 * @typedef {{ name: string, title: string, description: string, body: string }} Page
 */

/**
 * @param {string} name
 * @param {string} raw
 * @returns {Page}
 */
export function parsePage(name, raw) {
	const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
	/** @type {Record<string, string>} */
	const front = {};
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

/** @param {string} s */
const escape = (s) =>
	s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Every page's HTML, keyed by its path under the output folder. Throws when a
 * page points at a page that doesn't exist.
 * @param {Page[]} pages
 * @returns {Map<string, string>}
 */
export function renderGuide(pages) {
	// The reading order getting-started lists them in, then any others.
	const first = pages.find((p) => p.name === FIRST);
	const listed = [...(first?.body ?? '').matchAll(/^- `([a-z-]+)`/gm)].map((m) => m[1]);
	/** @param {string} name */
	const rank = (name) =>
		name === FIRST ? -1 : listed.includes(name) ? listed.indexOf(name) : listed.length;
	const ordered = [...pages].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
	const names = new Set(pages.map((p) => p.name));
	const marked = new Marked({ gfm: true });
	/** @type {Map<string, string>} */
	const out = new Map();
	for (const page of ordered) {
		const atRoot = page.name === FIRST;
		// From /guide/ a page is `name/`; from /guide/<page>/ it is `../name/`.
		/** @param {string} name */
		const href = (name) =>
			name === FIRST ? (atRoot ? './' : '../') : atRoot ? `${name}/` : `../${name}/`;
		let html = /** @type {string} */ (marked.parse(page.body));
		// "see the `skills` page" links to that page.
		html = html.replace(/<code>([a-z-]+)<\/code> page/g, (_, name) => {
			if (!names.has(name)) throw new Error(`${page.name}: no page "${name}"`);
			return `<a href="${href(name)}"><code>${name}</code></a> page`;
		});
		// So does a list item that starts with a page name ("- `models` — …").
		html = html.replace(/<li><code>([a-z-]+)<\/code>/g, (whole, name) =>
			names.has(name) ? `<li><a href="${href(name)}"><code>${name}</code></a>` : whole
		);
		const up = atRoot ? '../' : '../../';
		const nav = ordered
			.map((p) =>
				p.name === page.name
					? `<strong>${escape(p.title)}</strong>`
					: `<a href="${href(p.name)}">${escape(p.title)}</a>`
			)
			.join('\n\t\t\t\t');
		const doc = `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>${escape(page.title)} · Haruspex guide</title>
		<meta name="description" content="${escape(page.description)}" />
		<link rel="icon" href="${up}icon.png" />
		<link rel="stylesheet" href="${up}style.css" />
	</head>
	<body>
		<main class="guide">
			<header>
				<img src="${up}icon.png" alt="" />
				<a href="${up}">Haruspex</a>
				<span class="muted">User guide</span>
			</header>
			<nav class="guide-nav" aria-label="Guide pages">
				${nav}
			</nav>
			<article>
${html}
			</article>
			<footer>
				<a href="${up}">Home</a>
				<a href="${up}privacy/">Privacy policy</a>
				<a href="https://github.com/tmac1973/haruspex/tree/main/docs/guide/${page.name}.md">Edit this page</a>
			</footer>
		</main>
	</body>
</html>
`;
		out.set(atRoot ? 'index.html' : `${page.name}/index.html`, doc);
	}
	return out;
}

/** @param {string} dir */
export function readPages(dir) {
	return readdirSync(dir)
		.filter((f) => f.endsWith('.md'))
		.map((f) => parsePage(f.replace(/\.md$/, ''), readFileSync(join(dir, f), 'utf8')));
}

// Run as a command, not imported by the test.
const runAsScript = import.meta.url.endsWith(`/${process.argv[1]?.split('/').pop() ?? ''}`);
if (runAsScript) {
	const outDir = process.argv[2] ?? 'site/guide';
	const files = renderGuide(readPages('docs/guide'));
	rmSync(outDir, { recursive: true, force: true });
	for (const [path, html] of files) {
		const file = join(outDir, path);
		mkdirSync(join(file, '..'), { recursive: true });
		writeFileSync(file, html);
	}
	console.log(`Wrote ${files.size} guide pages to ${outDir}/`);
}
