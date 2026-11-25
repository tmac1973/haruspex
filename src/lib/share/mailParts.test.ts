import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotebookCard, NotebookDetail } from '#lib/notebooks/api.ts';
import type { ImageRow } from '#lib/ipc/gen/ImageRow.ts';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));
vi.mock('#lib/stores/toasts.svelte.ts', () => ({ showToast: vi.fn() }));
vi.mock('#lib/sandbox/sandbox.ts', () => ({ runPython: vi.fn() }));
vi.mock('#lib/sandbox/availability.ts', () => ({ pythonRuntimeMissing: () => false }));

import { invoke } from '@tauri-apps/api/core';
import { clearResolvedImages, rememberImages } from '#lib/images/resolve.svelte.ts';
import { MAX_MESSAGE_BYTES } from '#lib/email/parts.ts';
import { prepareChatMail, prepareNotebookMail } from './mailParts';

let staged: { name: string; mime: string; size: number }[] = [];

beforeEach(() => {
	staged = [];
	vi.mocked(invoke).mockImplementation(async (cmd, body, opts) => {
		if (cmd === 'email_part_stage') {
			const h = (opts as { headers: Record<string, string> }).headers;
			staged.push({
				name: decodeURIComponent(h['x-name']),
				mime: decodeURIComponent(h['x-mime']),
				size: (body as Uint8Array).length
			});
			return `part-${staged.length}`;
		}
		return null;
	});
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }))
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	clearResolvedImages();
});

const row = (over: Partial<ImageRow>): ImageRow => ({
	hash: 'a'.repeat(64),
	source_url: 'https://pics.example/fox.jpg',
	source: 'commons',
	mime: 'image/png',
	width: 10,
	height: 10,
	bytes: 4,
	license: 'cc-by',
	attribution: 'Ann',
	description_url: 'https://commons.example/File:Fox.jpg',
	embeddable: true,
	created_at: 0,
	last_used_at: 0,
	...over
});

describe('Chat mail', () => {
	it('inlines attached and generated pictures, and credits a web one with a link', async () => {
		rememberImages({
			'https://pics.example/fox.jpg': row({}),
			'https://gen.example/cat.png': row({ hash: 'b'.repeat(64), source: 'generated' })
		});
		const mail = await prepareChatMail(
			'![Mine](data:image/png;base64,AAAA) ![Cat](https://gen.example/cat.png) ' +
				'![Fox](https://pics.example/fox.jpg) ![Gone](https://nowhere.example/x.png)'
		);
		expect(mail.markdown).toBe(
			'![Mine](cid:p1) ![Cat](cid:p2) ' +
				'[Picture: Fox (Ann · CC BY)](https://commons.example/File:Fox.jpg) ' +
				'[Picture: Gone](https://nowhere.example/x.png)'
		);
		expect(mail.pictures.map((p) => [p.cid, p.partId])).toEqual([
			['p1', 'part-1'],
			['p2', 'part-2']
		]);
		expect(staged.map((s) => s.name)).toEqual(['picture-1.png', 'picture-2.png']);
	});
});

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

const detail = {
	notebook: { id: 'n', title: 'Trip', tags: [] },
	cards: [
		card('t', { title: 'Notes', body: 'Bring a coat.' }),
		card('i', {
			kind: 'image',
			title: 'Map',
			meta: JSON.stringify({ hash: 'c'.repeat(64), name: 'map.png', mime: 'image/png' })
		}),
		card('f', {
			kind: 'attachment',
			meta: JSON.stringify({ hash: 'd'.repeat(64), name: 'ticket.pdf', mime: 'application/pdf' })
		})
	]
} as unknown as NotebookDetail;
const full = { detail, rowsOf: (c: NotebookCard) => c.rows };

describe('Notebook mail', () => {
	it('shows pictures inline and attaches files, naming them in the text', async () => {
		const mail = await prepareNotebookMail(full);
		expect(mail.markdown).toContain('![Map](cid:p1)');
		expect(mail.markdown).toContain('[File: ticket.pdf]');
		expect(mail.pictures.map((p) => p.name)).toEqual(['map.png']);
		expect(mail.attachments.map((a) => [a.name, a.mime])).toEqual([
			['ticket.pdf', 'application/pdf']
		]);
		expect(mail.skipped).toEqual([]);
	});

	it('leaves out what would take the message over the limit', async () => {
		vi.mocked(fetch).mockImplementation(
			async () => new Response(new Uint8Array(MAX_MESSAGE_BYTES - 2), { status: 200 })
		);
		const mail = await prepareNotebookMail(full);
		expect(mail.pictures.map((p) => p.name)).toEqual(['map.png']);
		expect(mail.attachments).toEqual([]);
		expect(mail.skipped).toEqual(['ticket.pdf']);
		expect(mail.markdown).toContain('[File: ticket.pdf]');
	});

	it('drops what it staged when staging fails part way', async () => {
		vi.mocked(invoke).mockImplementation(async (cmd) => {
			if (cmd === 'email_part_stage') {
				staged.push({ name: '', mime: '', size: 0 });
				if (staged.length > 1) throw new Error('disk full');
				return 'part-1';
			}
			return null;
		});
		await expect(prepareNotebookMail(full)).rejects.toThrow('disk full');
		expect(invoke).toHaveBeenCalledWith('email_part_drop', { ids: ['part-1'] });
	});
});
