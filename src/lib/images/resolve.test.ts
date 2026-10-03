import { describe, it, expect, vi, beforeEach } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { clearResolvedImages, getResolvedImages, rehydrateImages } from './resolve.svelte';
import { imageSrc } from './url';

const H = 'c'.repeat(64);
const row = {
	hash: H,
	source_url: `haruspex-generated:${H}`,
	source: 'generated',
	mime: 'image/png',
	width: 1024,
	height: 768,
	bytes: 10,
	license: null,
	attribution: null,
	description_url: null,
	embeddable: true,
	created_at: 0,
	last_used_at: 0
};

beforeEach(() => {
	clearResolvedImages();
	invoke
		.mockReset()
		.mockImplementation(async (cmd: string) => (cmd === 'image_rehydrate_local' ? [row] : []));
});

describe('rehydrating a chat', () => {
	it('looks generated pictures up by hash, so they show after a reload', async () => {
		const url = imageSrc(H)!;
		await rehydrateImages('chat-1', [`Here: ![a lighthouse](${url})`], [[]], () => true);
		expect(invoke).toHaveBeenCalledWith('image_rehydrate_local', {
			conversationId: 'chat-1',
			hashes: [H]
		});
		expect(getResolvedImages().get(url)?.height).toBe(768);
	});

	it('asks for nothing when no generated picture is shown', async () => {
		await rehydrateImages('chat-1', ['just text'], [[]], () => true);
		expect(invoke).not.toHaveBeenCalledWith('image_rehydrate_local', expect.anything());
	});

	it('drops the answer when the user has moved to another chat', async () => {
		await rehydrateImages('chat-1', [`![x](${imageSrc(H)})`], [[]], () => false);
		expect(getResolvedImages().size).toBe(0);
	});
});
