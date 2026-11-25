import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
	getCard: vi.fn(),
	fullNotebook: vi.fn(),
	notebookFile: vi.fn(),
	resolveNotebook: vi.fn(),
	stagePart: vi.fn()
}));

vi.mock('#lib/notebooks/api.ts', async (orig) => ({
	...(await orig<typeof import('#lib/notebooks/api.ts')>()),
	getCard: m.getCard,
	fileUrl: (hash: string) => `haruspex-notebook-file://localhost/${hash}`
}));
vi.mock('#lib/notebooks/export.ts', () => ({
	fullNotebook: m.fullNotebook,
	notebookFile: m.notebookFile
}));
vi.mock('#lib/notebooks/share.ts', () => ({
	scoped: (full: { cards: string[] }, card?: { id: string }) =>
		card ? { ...full, cards: [card.id] } : full,
	shareTitle: (_full: unknown, card?: { title: string }) => card?.title || 'Trip'
}));
vi.mock('#lib/agent/tools/_notebookShared.ts', () => ({
	resolveNotebook: m.resolveNotebook,
	str: (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v))
}));
vi.mock('#lib/email/parts.ts', async (orig) => ({
	...(await orig<typeof import('#lib/email/parts.ts')>()),
	stagePart: m.stagePart
}));

import { MAX_MESSAGE_BYTES } from '#lib/email/parts.ts';
import { composeAttachment } from './_emailAttach';

const pdf = { name: 'Trip.pdf', mime: 'application/pdf', bytes: new Uint8Array([1, 2, 3]) };

beforeEach(() => {
	for (const f of Object.values(m)) f.mockReset();
	m.resolveNotebook.mockResolvedValue({ id: 'n1', title: 'Trip' });
	m.fullNotebook.mockResolvedValue({ cards: ['a', 'b'] });
	m.notebookFile.mockResolvedValue(pdf);
	m.stagePart.mockResolvedValue('part-1');
});

describe('email_compose attachments', () => {
	it('asks for nothing when no notebook or card is named', async () => {
		expect(await composeAttachment({ body: 'x' })).toBeNull();
	});

	it('exports a notebook as a PDF by default and stages it', async () => {
		const file = await composeAttachment({ attach_notebook: 'Trip' });
		expect(m.resolveNotebook).toHaveBeenCalledWith('Trip');
		expect(m.notebookFile).toHaveBeenCalledWith({ cards: ['a', 'b'] }, 'Trip', 'pdf');
		expect(m.stagePart).toHaveBeenCalledWith('Trip.pdf', 'application/pdf', pdf.bytes);
		expect(file).toEqual({ partId: 'part-1', name: 'Trip.pdf', mime: 'application/pdf', size: 3 });
	});

	it('exports one card in the format asked for', async () => {
		m.getCard.mockResolvedValue({
			id: 'c1',
			notebook_id: 'n1',
			kind: 'table',
			title: 'Costs',
			deleted_at: null
		});
		await composeAttachment({ attach_card: 'c1', notebook_format: 'docx' });
		expect(m.fullNotebook).toHaveBeenCalledWith('n1');
		expect(m.notebookFile).toHaveBeenCalledWith({ cards: ['c1'] }, 'Costs', 'docx');
	});

	it("attaches a file card's own file", async () => {
		m.getCard.mockResolvedValue({
			id: 'f1',
			notebook_id: 'n1',
			kind: 'attachment',
			title: '',
			deleted_at: null,
			meta: JSON.stringify({ hash: 'abc', name: 'ticket.pdf', mime: 'application/pdf' })
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(new Uint8Array([9, 9])))
		);
		const file = await composeAttachment({ attach_card: 'f1' });
		expect(m.notebookFile).not.toHaveBeenCalled();
		expect(file).toMatchObject({ name: 'ticket.pdf', size: 2 });
		vi.unstubAllGlobals();
	});

	it('refuses an unknown format, a card in Trash, and a file too large to send', async () => {
		expect(await composeAttachment({ attach_notebook: 'Trip', notebook_format: 'xls' })).toMatch(
			/notebook_format must be one of pdf, docx/
		);
		m.getCard.mockResolvedValue({ id: 'c1', notebook_id: 'n1', kind: 'text', deleted_at: 5 });
		expect(await composeAttachment({ attach_card: 'c1' })).toMatch(/in Trash/);
		m.notebookFile.mockResolvedValue({ ...pdf, bytes: new Uint8Array(MAX_MESSAGE_BYTES + 1) });
		expect(await composeAttachment({ attach_notebook: 'Trip' })).toMatch(
			/more than an email can carry/
		);
		expect(m.stagePart).not.toHaveBeenCalled();
	});
});
