import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePage, readPages } from '../../../scripts/build-guide.mjs';
import { ORDER, parseExamples, renderShowcase } from '../../../scripts/build-showcase.mjs';

/** "Things you can do" on the website, as scripts/build-showcase.mjs renders it. */

const example = (title: string, more = 'chat') =>
	`## ${title}\n\nDoes a thing.\n\nTab: Chat\nRequired settings: Settings → Image\n\nPrompt:\n\n> Draw a cat.\n\nExample output:\n\nA cat.\n\n<!-- media: the cat -->\n\nRead more: ${more}\n`;

const subjects = (body: string) =>
	ORDER.map((name, i) =>
		parsePage(
			name,
			`---\ntitle: S${i} & co\ndescription: About ${name}.\n---\n\n${i === 1 ? body : example('Ask')}`
		)
	);

const guide = new Set(['getting-started', 'chat', 'images']);

describe('the showcase on the website', () => {
	it('renders every subject from docs/showcase, the first at /showcase/', () => {
		const names = new Set(readPages(join(process.cwd(), 'docs/guide')).map((p) => p.name));
		const pages = readPages(join(process.cwd(), 'docs/showcase'));
		expect(pages.map((p) => p.name).sort()).toEqual([...ORDER].sort());
		const files = renderShowcase(pages, names);
		expect(files.size).toBe(ORDER.length);
		expect([...files.keys()]).toContain('index.html');
		for (const p of pages) expect(parseExamples(p).length, p.name).toBeGreaterThan(0);
	});

	it('renders each example as a card, linking guide pages from either depth', () => {
		const files = renderShowcase(
			subjects(example('Draw a picture', 'images, getting-started')),
			guide
		);
		const root = files.get('index.html')!;
		expect(root).toContain('<link rel="stylesheet" href="../style.css" />');
		expect(root).toContain('<a href="../guide/chat/"><code>chat</code></a>');
		const page = files.get(`${ORDER[1]}/index.html`)!;
		expect(page).toContain('<title>S1 &amp; co · Things you can do with Haruspex</title>');
		expect(page).toContain('<article class="example" id="draw-a-picture">');
		expect(page).toContain('<dd>Settings → Image</dd>');
		expect(page).toContain('<div class="example-prompt"><p>Draw a cat.</p>');
		expect(page).toContain('<a href="../../guide/images/"><code>images</code></a>');
		expect(page).toContain('<a href="../../guide/"><code>getting-started</code></a>');
		expect(page).toContain(
			`<a class="on" aria-current="page" href="../${ORDER[1]}/">S1 &amp; co</a>`
		);
	});

	it('fails on a link to a guide page that does not exist', () => {
		expect(() => renderShowcase(subjects(example('Draw', 'nowhere')), guide)).toThrow(
			'no guide page "nowhere"'
		);
	});

	it('fails on an example missing a part', () => {
		const broken = example('Draw').replace('Prompt:\n\n> Draw a cat.\n\n', '');
		expect(() => renderShowcase(subjects(broken), guide)).toThrow('Draw: needs, in order');
	});

	it('fails on a prompt that is not a quote', () => {
		const broken = example('Draw').replace('> Draw a cat.', 'Draw a cat.');
		expect(() => renderShowcase(subjects(broken), guide)).toThrow('the prompt must be a > quote');
	});

	it('fails on a subject missing from the order', () => {
		const extra = [...subjects(example('Draw')), parsePage('extra', example('Draw'))];
		expect(() => renderShowcase(extra, guide)).toThrow('extra: not listed in ORDER');
	});
});
