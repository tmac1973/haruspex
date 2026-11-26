#!/usr/bin/env node
// Render "Things you can do" (docs/showcase/*.md) as pages of the website,
// into site/showcase/: /showcase/ is the first subject, and every other one is
// /showcase/<name>/. Run by .github/workflows/pages.yml before it publishes
// site/, and by CI to catch a page that won't parse. Unlike the user guide it
// is not compiled into the app, so its pages have no size limit.
//
// Each `## ` heading of a page is one example, in this shape:
//
//   ## Draw a picture
//
//   One to three sentences on what it does.
//
//   Tab: Chat
//   Required settings: Settings → Image generation → add a backend
//
//   Prompt:
//
//   > Draw a poster for a school bake sale.
//
//   Example output:
//
//   Any Markdown. Pictures go in docs/showcase/media/ as media/<file>.
//
//   Read more: images, image-editing
//
// "Read more" names user guide pages, which must exist.
//
// Usage: node scripts/build-showcase.mjs [out dir, default site/showcase]

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Marked } from 'marked';
import { readPages } from './build-guide.mjs';

/** The subjects, in the order the site lists them. The first is /showcase/. */
export const ORDER = [
	'research',
	'notebooks',
	'files',
	'images',
	'music-voice',
	'video',
	'code',
	'jobs',
	'email-home',
	'cameras',
	'remote',
	'memory-skills'
];

/**
 * @typedef {{ name: string, title: string, description: string, body: string }} Page
 * @typedef {{ id: string, title: string, about: string, tab: string, settings: string,
 *   prompt: string, output: string, more: string[] }} Example
 */

/** @param {string} s */
const escape = (s) =>
	s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** @param {string} title */
export const anchor = (title) =>
	title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');

/**
 * A subject page's examples. Throws, naming the page and example, when one
 * is missing a part or has them out of order.
 * @param {Page} page
 * @returns {Example[]}
 */
export function parseExamples(page) {
	const chunks = page.body.split(/^## /m);
	if (chunks[0].trim()) throw new Error(`${page.name}: text before the first "## " example`);
	return chunks.slice(1).map((chunk) => {
		const [heading, ...rest] = chunk.split('\n');
		const title = heading.trim();
		const where = `${page.name} › ${title}`;
		const text = rest.join('\n');
		const m =
			/^([\s\S]*?)^Tab: (.+)\nRequired settings: (.+)\n\s*^Prompt:\s*\n([\s\S]*?)^Example output:\s*\n([\s\S]*?)^Read more: (.+)\s*$/m.exec(
				text
			);
		if (!m) {
			throw new Error(
				`${where}: needs, in order, a description, "Tab:", "Required settings:", "Prompt:", "Example output:" and "Read more:"`
			);
		}
		const [, about, tab, settings, prompt, output, more] = m;
		if (!about.trim()) throw new Error(`${where}: no description`);
		if (!/^>/.test(prompt.trim())) throw new Error(`${where}: the prompt must be a > quote`);
		if (!output.trim()) throw new Error(`${where}: no example output`);
		const tail = text.slice(m.index + m[0].length).trim();
		if (tail) throw new Error(`${where}: text after "Read more:"`);
		return {
			id: anchor(title),
			title,
			about: about.trim(),
			tab: tab.trim(),
			settings: settings.trim(),
			prompt: prompt.trim(),
			output: output.trim(),
			more: more
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean)
		};
	});
}

/**
 * Links to a page from /showcase/ (`atRoot`) or from /showcase/<name>/.
 * @param {boolean} atRoot
 */
function linksFrom(atRoot) {
	const up = atRoot ? '../' : '../../';
	return {
		up,
		media: atRoot ? 'media/' : '../media/',
		/** @param {string} name */
		subject: (name) =>
			name === ORDER[0] ? (atRoot ? './' : '../') : atRoot ? `${name}/` : `../${name}/`,
		/** @param {string} name */
		guide: (name) => (name === 'getting-started' ? `${up}guide/` : `${up}guide/${name}/`)
	};
}

const marked = new Marked({ gfm: true });

/**
 * @param {string} md
 * @param {string} media where docs/showcase/media/ is from this page
 */
const block = (md, media) =>
	/** @type {string} */ (marked.parse(md)).replace(/(src|href)="media\//g, `$1="${media}`);

/** @param {string} md */
const inline = (md) => /** @type {string} */ (marked.parseInline(md));

/**
 * One example's card.
 * @param {Example} e
 * @param {ReturnType<typeof linksFrom>} links
 */
function renderExample(e, links) {
	const more = e.more
		.map((name) => `<a href="${links.guide(name)}"><code>${name}</code></a>`)
		.join(' · ');
	return `<article class="example" id="${e.id}">
					<h3><a href="#${e.id}">${escape(e.title)}</a></h3>
					${block(e.about, links.media)}
					<dl class="example-meta">
						<dt>Tab</dt>
						<dd>${inline(e.tab)}</dd>
						<dt>Required settings</dt>
						<dd>${inline(e.settings)}</dd>
					</dl>
					<div class="example-label">Prompt</div>
					<div class="example-prompt">${block(e.prompt.replace(/^> ?/gm, ''), links.media)}</div>
					<div class="example-label">Example output</div>
					<div class="example-output">${block(e.output, links.media)}</div>
					<p class="example-more">Read more: ${more}</p>
				</article>`;
}

/**
 * A subject's examples, checked: unique titles, guide pages that exist.
 * @param {Page} page
 * @param {Set<string>} guide
 */
function checkedExamples(page, guide) {
	const examples = parseExamples(page);
	const ids = new Set();
	for (const e of examples) {
		if (ids.has(e.id)) throw new Error(`${page.name}: two examples called "${e.title}"`);
		ids.add(e.id);
		for (const name of e.more) {
			if (!guide.has(name)) throw new Error(`${page.name} › ${e.title}: no guide page "${name}"`);
		}
	}
	return examples;
}

/**
 * One subject's whole page.
 * @param {Page} page
 * @param {Page[]} ordered every subject, for the nav
 * @param {Example[]} examples
 * @param {ReturnType<typeof linksFrom>} links
 */
function renderSubject(page, ordered, examples, links) {
	const { up } = links;
	const cards = examples.map((e) => renderExample(e, links)).join('\n\t\t\t\t');
	const toc = examples
		.map((e) => `<li><a href="#${e.id}">${escape(e.title)}</a></li>`)
		.join('\n\t\t\t\t\t');
	const nav = ordered
		.map((p) =>
			p.name === page.name
				? `<a class="on" aria-current="page" href="${links.subject(p.name)}">${escape(p.title)}</a>`
				: `<a href="${links.subject(p.name)}">${escape(p.title)}</a>`
		)
		.join('\n\t\t\t\t');
	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>${escape(page.title)} · Things you can do with Haruspex</title>
		<meta name="description" content="${escape(page.description)}" />
		<link rel="icon" href="${up}icon.png" />
		<link rel="stylesheet" href="${up}style.css" />
	</head>
	<body>
		<main class="guide showcase">
			<header>
				<img src="${up}icon.png" alt="" />
				<a href="${up}">Haruspex</a>
				<nav class="section-tabs" aria-label="Site sections">
					<a class="on" aria-current="page" href="${links.subject(ORDER[0])}">Things you can do</a>
					<a href="${up}guide/">User guide</a>
				</nav>
			</header>
			<h1>Things you can do</h1>
			<p class="lede">Examples to try, with what to turn on first.</p>
			<nav class="subjects" aria-label="Subjects">
				${nav}
			</nav>
			<section>
				<h2>${escape(page.title)}</h2>
				<p class="muted">${escape(page.description)}</p>
				<ul class="toc">
					${toc}
				</ul>
				${cards}
			</section>
			<footer>
				<a href="${up}">Home</a>
				<a href="${up}guide/">User guide</a>
				<a href="${up}privacy/">Privacy policy</a>
				<a href="https://github.com/tmac1973/haruspex/tree/main/docs/showcase/${page.name}.md">Edit this page</a>
			</footer>
		</main>
	</body>
</html>
`;
}

/**
 * Every subject's HTML, keyed by its path under the output folder. Throws when
 * an example is malformed or points at a guide page that doesn't exist.
 * @param {Page[]} pages the subjects
 * @param {Set<string>} guide the user guide's page names
 * @returns {Map<string, string>}
 */
export function renderShowcase(pages, guide) {
	const byName = new Map(pages.map((p) => [p.name, p]));
	for (const p of pages) {
		if (!ORDER.includes(p.name)) throw new Error(`${p.name}: not listed in ORDER`);
	}
	const ordered = ORDER.map((name) => {
		const p = byName.get(name);
		if (!p) throw new Error(`no subject page "${name}"`);
		return p;
	});
	/** @type {Map<string, string>} */
	const out = new Map();
	ordered.forEach((page, i) => {
		const html = renderSubject(page, ordered, checkedExamples(page, guide), linksFrom(i === 0));
		out.set(i === 0 ? 'index.html' : `${page.name}/index.html`, html);
	});
	return out;
}

// Run as a command, not imported by the test.
const runAsScript = import.meta.url.endsWith(`/${process.argv[1]?.split('/').pop() ?? ''}`);
if (runAsScript) {
	const outDir = process.argv[2] ?? 'site/showcase';
	const guide = new Set(readPages('docs/guide').map((p) => p.name));
	const files = renderShowcase(readPages('docs/showcase'), guide);
	rmSync(outDir, { recursive: true, force: true });
	for (const [path, html] of files) {
		const file = join(outDir, path);
		mkdirSync(join(file, '..'), { recursive: true });
		writeFileSync(file, html);
	}
	if (existsSync('docs/showcase/media')) {
		cpSync('docs/showcase/media', join(outDir, 'media'), { recursive: true });
	}
	console.log(`Wrote ${files.size} showcase pages to ${outDir}/`);
}
