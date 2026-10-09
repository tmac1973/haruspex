import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHORTCUTS } from '#lib/shortcuts.ts';

/**
 * The user guide in `docs/guide/`, checked as files: the shape every page
 * needs for the `haruspex_docs` tool's index (plan/self-docs/), a size that
 * fits in a turn, links that go somewhere, and a Settings reference that
 * names every section the app has.
 */

const GUIDE = join(process.cwd(), 'docs/guide');
/** A page is read whole into a turn; past this it costs too much context. */
const MAX_BYTES = 6000;

const PAGES = [
	'getting-started',
	'models',
	'chat',
	'shell',
	'code',
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

interface Page {
	name: string;
	raw: string;
	front: Record<string, string>;
}

function readPages(): Page[] {
	return readdirSync(GUIDE)
		.filter((f) => f.endsWith('.md'))
		.map((f) => {
			const raw = readFileSync(join(GUIDE, f), 'utf8');
			const m = /^---\n([\s\S]*?)\n---\n/.exec(raw);
			const front: Record<string, string> = {};
			for (const line of (m?.[1] ?? '').split('\n')) {
				const i = line.indexOf(':');
				if (i > 0) front[line.slice(0, i).trim()] = line.slice(i + 1).trim();
			}
			return { name: f.replace(/\.md$/, ''), raw, front };
		});
}

const pages = readPages();

describe('the user guide', () => {
	it('has every planned page, and no other', () => {
		expect(pages.map((p) => p.name).sort()).toEqual([...PAGES].sort());
	});

	it('gives every page a title and a one-line description', () => {
		for (const p of pages) {
			expect(p.front.title, p.name).toBeTruthy();
			expect(p.front.description, p.name).toBeTruthy();
			expect(p.front.description.length, p.name).toBeLessThanOrEqual(200);
		}
	});

	it('keeps every page small enough to read whole', () => {
		for (const p of pages) {
			expect(Buffer.byteLength(p.raw), p.name).toBeLessThan(MAX_BYTES);
		}
	});

	it('only points at pages that exist', () => {
		for (const p of pages) {
			for (const m of p.raw.matchAll(/`([a-z-]+)` page/g)) {
				expect(PAGES, `${p.name} → ${m[1]}`).toContain(m[1]);
			}
		}
	});

	it('names every Settings section on the settings page', () => {
		const panel = readFileSync(
			join(process.cwd(), 'src/lib/components/settings/SettingsPanel.svelte'),
			'utf8'
		);
		const sections = [...panel.matchAll(/id: '[a-z-]+',\s*label: '([^']+)'/g)].map((m) => m[1]);
		expect(sections.length).toBeGreaterThan(10);
		const settings = pages.find((p) => p.name === 'settings')!.raw;
		for (const label of sections) {
			expect(settings, label).toContain(`## ${label}`);
		}
	});

	it('lists every keyboard shortcut the app has, keyed as the app shows it', () => {
		const page = pages.find((p) => p.name === 'shortcuts')!.raw;
		for (const { items } of SHORTCUTS) {
			for (const { keys } of items) expect(page, keys).toContain(`| ${keys} |`);
		}
	});
});
