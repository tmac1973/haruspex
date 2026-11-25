import { describe, expect, it, vi } from 'vitest';
import type { NotebookCard, NotebookDetail } from '#lib/notebooks/api.ts';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));
vi.mock('#lib/stores/toasts.svelte.ts', () => ({ showToast: vi.fn() }));

vi.mock('#lib/sandbox/sandbox.ts', () => ({ runPython: vi.fn() }));
vi.mock('#lib/sandbox/availability.ts', () => ({ pythonRuntimeMissing: () => false }));

import { pdfAttachment, scoped, shareTitle } from './share';

const card = (id: string, over: Partial<NotebookCard>): NotebookCard =>
	({
		id,
		notebook_id: 'n',
		position: 1,
		kind: 'text',
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

const notes = card('t', { title: 'Notes', body: 'Bring a coat.' });
const map = card('i', {
	kind: 'image',
	title: 'Map',
	meta: JSON.stringify({ hash: 'abc', name: 'map.png', mime: 'image/png' })
});
const ticket = card('f', {
	kind: 'attachment',
	meta: JSON.stringify({ hash: 'def', name: 'ticket.pdf', mime: 'application/pdf' })
});
const detail = {
	notebook: { id: 'n', title: 'Trip', tags: [] },
	cards: [notes, map, ticket]
} as unknown as NotebookDetail;
const full = { detail, rowsOf: (c: NotebookCard) => c.rows };

describe('sharing a notebook', () => {
	it('offers the notebook as a PDF, built only when asked for', async () => {
		const pdf = pdfAttachment(scoped(full, notes), 'Notes — Trip');
		expect(pdf.label).toBe('Attach as PDF');
		const f = await pdf.build();
		expect(f.name).toBe('Notes — Trip.pdf');
		expect(f.mime).toBe('application/pdf');
		expect(new TextDecoder().decode(f.bytes.slice(0, 5))).toBe('%PDF-');
	});

	it('shares one card under the notebook title', () => {
		const one = scoped(full, map);
		expect(one.detail.cards.map((c) => c.id)).toEqual(['i']);
		expect(shareTitle(one, map)).toBe('Map — Trip');
		expect(shareTitle(full)).toBe('Trip');
		expect(shareTitle(full, ticket)).toBe('Trip');
		expect(scoped(full)).toBe(full);
	});
});
