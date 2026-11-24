import { describe, it, expect, vi } from 'vitest';
import type { EngineClient } from '#lib/engine/client.svelte.ts';
import type { NotebookCard } from '#lib/notebooks/api.ts';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { peerBackend } from './backend.svelte';

function fakeClient() {
	const ops: Record<string, unknown>[] = [];
	const client = {
		op: vi.fn(async (o: Record<string, unknown>) => {
			ops.push(o);
			return {};
		})
	} as unknown as EngineClient;
	return { client, ops };
}

const card = { id: 'c1', version: 4 } as NotebookCard;
const USER = { kind: 'user' as const };

describe('a paired computer’s notebooks', () => {
	it('maps each call to its operation there', async () => {
		const { client, ops } = fakeClient();
		const be = peerBackend('p1', 'Laptop', client);
		await be.list();
		await be.get('n1');
		await be.rows('c1', 200, 100);
		await be.search('bass', true);
		await be.addCard(
			'n1',
			{ kind: 'table', title: 'T', body: '', meta: '{}', rows: null },
			USER,
			null
		);
		await be.updateCard(card, { body: 'x' }, USER);
		await be.applyRows(card, [{ op: 'delete', row_id: 'r1' }], USER);
		await be.deleteCard('c1');
		await be.history('c1');
		await be.rollback('c1', 7, USER);
		expect(ops.map((o) => o.type)).toEqual([
			'notebooks.list',
			'notebooks.get',
			'notebooks.rows',
			'notebooks.search',
			'notebooks.card.add',
			'notebooks.card.update',
			'notebooks.rows.apply',
			'notebooks.card.delete',
			'notebooks.card.history',
			'notebooks.card.rollback'
		]);
		expect(ops[5]).toMatchObject({ cardId: 'c1', expectedVersion: 4, body: 'x' });
	});

	it('refuses what only that computer can do, naming it', async () => {
		const be = peerBackend('p1', 'Laptop', fakeClient().client);
		expect(be.can.arrange).toBe(false);
		await expect(be.updateCard(card, { meta: '{}' }, USER)).rejects.toThrow(
			'Change this on Laptop.'
		);
		await expect(
			be.addCard('n1', { kind: 'python', title: '', body: '', meta: '{}', rows: null }, USER, null)
		).rejects.toThrow('Laptop');
	});

	it('reads a picture once through that computer', async () => {
		invoke.mockResolvedValue(new Uint8Array([1, 2]).buffer);
		globalThis.URL.createObjectURL = vi.fn(() => 'blob:x');
		const be = peerBackend('p2', 'Laptop', fakeClient().client);
		expect(await be.fileUrl('h', 'image/png')).toBe('blob:x');
		expect(await be.fileUrl('h', 'image/png')).toBe('blob:x');
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(invoke).toHaveBeenCalledWith('peer_image', { peerId: 'p2', hash: 'h' });
	});
});
