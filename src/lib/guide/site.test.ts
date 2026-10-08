import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePage, readPages, renderGuide } from '../../../scripts/build-guide.mjs';

/** The website's copy of the guide, as scripts/build-guide.mjs renders it. */
describe('the guide on the website', () => {
	it('renders every page, getting-started at /guide/', () => {
		const files = renderGuide(readPages(join(process.cwd(), 'docs/guide')));
		expect(files.size).toBe(14);
		expect(files.get('index.html')).toContain('<title>Getting started · Haruspex guide</title>');
		expect(files.get('skills/index.html')).toContain(
			'<a href="../jobs/"><code>jobs</code></a> page'
		);
	});

	const pages = [
		parsePage(
			'getting-started',
			'---\ntitle: Start\ndescription: Begin.\n---\n# Start\n\n- `b` — the second page.\n'
		),
		parsePage(
			'b',
			'---\ntitle: B & co\ndescription: About "b".\n---\n# B\n\nSee the `getting-started` page.\n\n| K | V |\n|---|---|\n| a | b |\n'
		)
	];

	it('links page names, from either depth, and escapes the head', () => {
		const files = renderGuide(pages);
		const root = files.get('index.html')!;
		expect(root).toContain('<li><a href="b/"><code>b</code></a>');
		expect(root).toContain('<link rel="stylesheet" href="../style.css" />');
		const b = files.get('b/index.html')!;
		expect(b).toContain('<a href="../"><code>getting-started</code></a> page');
		expect(b).toContain('<link rel="stylesheet" href="../../style.css" />');
		expect(b).toContain('<title>B &amp; co · Haruspex guide</title>');
		expect(b).toContain('content="About &quot;b&quot;."');
		expect(b).toContain('<strong>B &amp; co</strong>');
		expect(b).toContain('<table>');
	});

	it('fails on a link to a page that does not exist', () => {
		const broken = parsePage('getting-started', '# S\n\nSee the `nowhere` page.\n');
		expect(() => renderGuide([broken])).toThrow('no page "nowhere"');
	});
});
