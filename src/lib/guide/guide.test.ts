import { describe, expect, it } from 'vitest';
import { GUIDE_PAGES, guideIndex, guidePage, parsePage } from './guide';

describe('the compiled-in guide', () => {
	it('has every page from docs/guide/, getting-started first', () => {
		expect(GUIDE_PAGES).toHaveLength(17);
		expect(GUIDE_PAGES[0].name).toBe('getting-started');
		expect(GUIDE_PAGES.at(-1)!.name).toBe('troubleshooting');
		for (const p of GUIDE_PAGES) {
			expect(p.title, p.name).not.toBe(p.name);
			expect(p.description, p.name).toBeTruthy();
			expect(p.body.startsWith('---'), p.name).toBe(false);
		}
	});

	it('finds a page by name, and lists each on one index line', () => {
		expect(guidePage('skills')!.body).toContain('/name');
		expect(guidePage('nope')).toBeUndefined();
		const index = guideIndex().split('\n');
		expect(index).toHaveLength(GUIDE_PAGES.length);
		expect(index[0]).toMatch(/^- getting-started — .+: .+/);
	});
});

describe('parsePage', () => {
	it('reads the frontmatter and leaves the body', () => {
		const p = parsePage(
			'x',
			'---\ntitle: X: the page\ndescription: About x.\n---\n\n# X\n\nBody.\n'
		);
		expect(p).toEqual({
			name: 'x',
			title: 'X: the page',
			description: 'About x.',
			body: '# X\n\nBody.'
		});
	});

	it('copes with a page that has none', () => {
		expect(parsePage('y', '# Y\n')).toEqual({
			name: 'y',
			title: 'y',
			description: '',
			body: '# Y'
		});
	});
});
