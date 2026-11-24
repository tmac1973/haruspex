import { describe, it, expect, vi } from 'vitest';
import type { NotebookCard, NotebookDetail } from '#lib/notebooks/api.ts';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));
vi.mock('#lib/sandbox/sandbox.ts', () => ({ runPython: vi.fn() }));
vi.mock('#lib/sandbox/availability.ts', () => ({ pythonRuntimeMissing: () => false }));
vi.mock('#lib/stores/settings.ts', () => ({ getSettings: () => ({}) }));
vi.mock('#lib/stores/toasts.svelte.ts', () => ({ showToast: vi.fn() }));

import { build, htmlPage, safeFileName, tableCells, toIpynb } from './export';

const card = (kind: string, over: Partial<NotebookCard>): NotebookCard =>
	({
		id: kind,
		notebook_id: 'n',
		position: 1,
		kind,
		title: '',
		body: '',
		meta: '{}',
		version: 1,
		source: '',
		created_at: 0,
		updated_at: 0,
		deleted_at: null,
		row_count: 0,
		rows: [],
		...over
	}) as NotebookCard;

const table = card('table', {
	title: 'Models',
	meta: JSON.stringify({
		columns: [
			{ id: 'name', name: 'Name', type: 'text' },
			{ id: 'price', name: 'Price', type: 'currency', currency: 'USD' }
		]
	}),
	rows: [{ id: 'r', position: 1, cells: '{"name":"JBL","price":129}' }],
	row_count: 1
});
const detail = {
	notebook: { id: 'n', title: 'Speakers', tags: [] },
	cards: [
		card('text', { title: 'Notes', body: 'Loud **and** clear.' }),
		table,
		card('python', {
			title: 'Calc',
			body: 'print(2 + 2)',
			meta: JSON.stringify({ output: { stdout: '4\n', error: null, artifacts: [], notes: [] } })
		})
	]
} as unknown as NotebookDetail;
const full = { detail, rowsOf: (c: NotebookCard) => c.rows };

describe('notebook export', () => {
	it('builds a PDF, a Word file and an OpenDocument file', async () => {
		const pdf = (await build(full, 'pdf')).bytes;
		expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe('%PDF-');
		for (const f of ['docx', 'odt'] as const) {
			const b = (await build(full, f)).bytes;
			expect([b[0], b[1]]).toEqual([0x50, 0x4b]); // a zip
		}
	});

	it('writes plain Markdown when there are no files', async () => {
		const r = await build(full, 'markdown');
		expect(r.zip).toBeFalsy();
		expect(new TextDecoder().decode(r.bytes)).toContain('| JBL | $129.00 |');
	});

	it('makes one HTML page with the table', () => {
		const html = htmlPage('A <b>', '| a |\n|---|\n| 1 |');
		expect(html).toContain('<title>A &#60;b&#62;</title>');
		expect(html).toContain('<table>');
	});

	it('makes a valid Jupyter notebook with code and output', () => {
		const nb = JSON.parse(toIpynb(detail, full.rowsOf));
		expect(nb.nbformat).toBe(4);
		const code = nb.cells.find((c: { cell_type: string }) => c.cell_type === 'code');
		expect(code.source.join('')).toBe('print(2 + 2)');
		expect(code.outputs[0].text.join('')).toBe('4\n');
	});

	it('gives table cells as typed, without formatting', () => {
		expect(tableCells(table, table.rows)).toEqual([
			['Name', 'Price'],
			['JBL', '129']
		]);
		expect(safeFileName('a/b: c')).toBe('a_b_ c');
	});
});
