import { describe, it, expect, vi } from 'vitest';
import type { NotebookCard, NotebookDetail } from '#lib/notebooks/api.ts';

vi.mock('#lib/sandbox/sandbox.ts', () => ({ runPython: vi.fn() }));
vi.mock('#lib/sandbox/availability.ts', () => ({ pythonRuntimeMissing: () => false }));
vi.mock('#lib/stores/settings.ts', () => ({ getSettings: () => ({}) }));

import { notebookToMarkdown, uniqueNamer } from './toMarkdown';

let n = 0;
function card(kind: string, over: Partial<NotebookCard> = {}): NotebookCard {
	return {
		id: `c${++n}`,
		notebook_id: 'n',
		position: n,
		kind,
		title: '',
		body: '',
		meta: '{}',
		version: 1,
		source: '{"kind":"user"}',
		created_at: 0,
		updated_at: 0,
		deleted_at: null,
		row_count: 0,
		rows: [],
		...over
	};
}

const row = (cells: object) => ({ id: 'r', position: 1, cells: JSON.stringify(cells) });

describe('notebookToMarkdown', () => {
	it('writes every kind of card', () => {
		const detail = {
			notebook: { id: 'n', title: 'Speakers', tags: ['audio'] },
			cards: [
				card('text', { title: 'Notes', body: 'Long **battery**.' }),
				card('table', {
					title: 'Models',
					meta: JSON.stringify({
						columns: [
							{ id: 'name', name: 'Name', type: 'text' },
							{ id: 'price', name: 'Price', type: 'number' },
							{ id: 'link', name: 'Link', type: 'url' }
						]
					}),
					rows: [row({ name: 'A | B', price: 5, link: 'https://www.example.com/a' })]
				}),
				card('checklist', { rows: [row({ text: 'Buy', done: true })] }),
				card('python', {
					body: 'print(1)',
					meta: JSON.stringify({
						output: {
							stdout: '1\n',
							error: null,
							artifacts: [
								{ kind: 'image', mime: 'image/png', dataUrl: 'data:image/png;base64,AA' }
							],
							notes: []
						}
					})
				}),
				card('image', {
					title: 'Photo',
					meta: JSON.stringify({ hash: 'h', name: 'photo.png', mime: 'image/png' })
				}),
				card('attachment', {
					meta: JSON.stringify({ hash: 'h2', name: 'photo.png', mime: 'application/pdf' })
				})
			]
		} as unknown as NotebookDetail;
		const { markdown, files } = notebookToMarkdown(detail);
		expect(markdown).toContain('# Speakers\n\nTags: audio');
		expect(markdown).toContain('## Notes\n\nLong **battery**.');
		expect(markdown).toContain('| Name | Price | Link |\n| --- | ---: | --- |');
		expect(markdown).toContain('| A \\| B | 5 | [example.com/a](https://www.example.com/a) |');
		expect(markdown).toContain('- [x] Buy');
		expect(markdown).toContain('```python\nprint(1)\n```\n\n```\n1\n```');
		expect(markdown).toContain('![plot](files/plot-1.png)');
		expect(markdown).toContain('![Photo](files/photo.png)');
		expect(markdown).toContain('[photo (2).png](files/photo%20(2).png)');
		expect(files.map((f) => f.name)).toEqual(['plot-1.png', 'photo.png', 'photo (2).png']);
	});

	it('lets the caller point file links elsewhere', () => {
		const detail = {
			notebook: { id: 'n', title: 'T', tags: [] },
			cards: [
				card('image', { meta: JSON.stringify({ hash: 'h', name: 'a.png', mime: 'image/png' }) })
			]
		} as unknown as NotebookDetail;
		const { markdown } = notebookToMarkdown(detail, { fileRef: () => 'data:x' });
		expect(markdown).toContain('](data:x)');
	});
});

describe('uniqueNamer', () => {
	it('numbers repeats, any case, and strips path characters', () => {
		const name = uniqueNamer();
		expect(name('a.png')).toBe('a.png');
		expect(name('A.png')).toBe('A (2).png');
		expect(name('x/y.txt')).toBe('x_y.txt');
	});
});
