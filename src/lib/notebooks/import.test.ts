import { describe, it, expect, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('#lib/stores/toasts.svelte.ts', () => ({ showToast: vi.fn() }));

import { baseName, cardsFromMarkdown, tableCard } from './import';
import { notebookToMarkdown } from './toMarkdown';
import type { NotebookCard, NotebookDetail } from '#lib/notebooks/api.ts';

vi.mock('#lib/sandbox/sandbox.ts', () => ({ runPython: vi.fn() }));
vi.mock('#lib/sandbox/availability.ts', () => ({ pythonRuntimeMissing: () => false }));
vi.mock('#lib/stores/settings.ts', () => ({ getSettings: () => ({}) }));

describe('importing Markdown', () => {
	it('splits at ## headings into text, table and checklist cards', () => {
		const md = `# Trip

Intro line.

## Packing
- [x] Passport
- [ ] Snorkel

## Hotels
Some text first.

| Name | Price | Link |
|---|---|---|
| Sea View | $120 | [example.com](https://example.com/sea) |

## Notes
Bring cash.
`;
		const { title, cards } = cardsFromMarkdown(md, 'file');
		expect(title).toBe('Trip');
		expect(cards.map((c) => `${c.kind}:${c.title}`)).toEqual([
			'text:',
			'checklist:Packing',
			'text:',
			'table:Hotels',
			'text:Notes'
		]);
		expect(cards[1].rows).toEqual([
			'{"text":"Passport","done":true}',
			'{"text":"Snorkel","done":false}'
		]);
		const cols = JSON.parse(cards[3].meta).columns;
		expect(cols.map((c: { type: string }) => c.type)).toEqual(['text', 'currency', 'url']);
		expect(JSON.parse(cards[3].rows![0])).toEqual({
			name: 'Sea View',
			price: 120,
			link: 'https://example.com/sea'
		});
	});

	it('round-trips what export writes', () => {
		const table = tableCard('Models', [
			['Name', 'Price'],
			['JBL', '129']
		]);
		const detail = {
			notebook: { id: 'n', title: 'Speakers', tags: [] },
			cards: [
				{
					...table,
					id: 'a',
					rows: table.rows!.map((cells, i) => ({ id: `r${i}`, position: i, cells }))
				},
				{ id: 'b', kind: 'text', title: 'Notes', body: 'Loud.', meta: '{}', rows: [] },
				{
					id: 'c',
					kind: 'checklist',
					title: 'Todo',
					body: '',
					meta: '{}',
					rows: [{ id: 'x', position: 1, cells: '{"text":"Buy","done":false}' }]
				}
			] as unknown as NotebookCard[]
		} as unknown as NotebookDetail;
		const { markdown } = notebookToMarkdown(detail);
		const back = cardsFromMarkdown(markdown, 'x');
		expect(back.title).toBe('Speakers');
		expect(back.cards.map((c) => `${c.kind}:${c.title}`)).toEqual([
			'table:Models',
			'text:Notes',
			'checklist:Todo'
		]);
		expect(JSON.parse(back.cards[0].rows![0])).toEqual({ name: 'JBL', price: 129 });
	});

	it('names a notebook after its file', () => {
		expect(baseName('/home/u/Trip notes.md')).toBe('Trip notes');
		expect(baseName('C:\\x\\prices.csv')).toBe('prices');
	});
});
