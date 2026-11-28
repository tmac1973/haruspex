import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

import {
	clearResolvedImages,
	getResolvedImages,
	MAX_IMAGES_PER_MESSAGE,
	registerLocalImage,
	resolveReplyImages,
	sweepImages
} from './resolve.svelte.ts';
import { imageSrc } from './url.ts';
import { invokeRouter } from '#lib/testing/invoke.ts';
import type { SearchStep } from '#lib/agent/loop.ts';
import type { ImageRequest } from '#lib/ipc/gen/ImageRequest.ts';
import type { ImageRow } from '#lib/ipc/gen/ImageRow.ts';

function step(partial: Partial<SearchStep> & { toolName: string }): SearchStep {
	return { id: Math.random().toString(36), query: '', status: 'done', ...partial } as SearchStep;
}

/** An `image_search` step, its results as the tool returns them. */
function imageSearch(...urls: string[]): SearchStep {
	const results = urls.map((url) => ({ url, source: 'commons', license: 'CC0' }));
	return step({ toolName: 'image_search', result: JSON.stringify({ results }) });
}

function rowFor(req: ImageRequest): ImageRow {
	return {
		hash: 'a'.repeat(64),
		source_url: req.url,
		source: req.source,
		mime: 'image/jpeg',
		width: 640,
		height: 480,
		bytes: 10,
		license: req.license,
		attribution: null,
		description_url: null,
		embeddable: true,
		created_at: 0,
		last_used_at: 0
	};
}

/** The URLs each `image_resolve` call asked for. */
function resolvedRequests(): string[][] {
	return vi
		.mocked(invoke)
		.mock.calls.filter(([cmd]) => cmd === 'image_resolve')
		.map(([, args]) => (args as { requests: ImageRequest[] }).requests.map((r) => r.url));
}

const A = 'https://upload.wikimedia.org/a.jpg';
const B = 'https://upload.wikimedia.org/b.jpg';

beforeEach(() => {
	clearResolvedImages();
	vi.mocked(invoke)
		.mockReset()
		.mockImplementation(
			invokeRouter({
				image_resolve: (a) => (a as { requests: ImageRequest[] }).requests.map(rowFor)
			})
		);
});

describe('resolveReplyImages', () => {
	it('fetches only the pictures a tool produced, not ones the model made up', async () => {
		const reply = `![a](${A})\n![made up](https://evil.example/track.gif)`;
		await resolveReplyImages('chat-1', reply, [imageSearch(A, B)], () => true);
		expect(resolvedRequests()).toEqual([[A]]);
		expect([...getResolvedImages().keys()]).toEqual([A]);
	});

	it(`asks for at most ${MAX_IMAGES_PER_MESSAGE} per reply`, async () => {
		const urls = ['1', '2', '3', '4', '5'].map((n) => `https://upload.wikimedia.org/${n}.jpg`);
		const reply = urls.map((u) => `![x](${u})`).join('\n');
		await resolveReplyImages('chat-1', reply, [imageSearch(...urls)], () => true);
		expect(resolvedRequests()[0]).toHaveLength(MAX_IMAGES_PER_MESSAGE);
	});

	it('falls back to a strip from image_search when the reply embeds none', async () => {
		await resolveReplyImages('chat-1', 'Pandas are bears.', [imageSearch(A)], () => true);
		expect(resolvedRequests()).toEqual([[A]]);
		expect(getResolvedImages().has(A)).toBe(true);
	});

	it('fetches nothing for made-up URLs when no picture was searched for', async () => {
		await resolveReplyImages('chat-1', '![x](https://evil.example/x.png)', [], () => true);
		expect(invoke).not.toHaveBeenCalled();
	});

	it('drops what comes back once the user has moved to another chat', async () => {
		await resolveReplyImages('chat-1', `![a](${A})`, [imageSearch(A)], () => false);
		expect(resolvedRequests()).toEqual([[A]]);
		expect(getResolvedImages().size).toBe(0);
	});

	it('shows nothing, and throws nothing, when the fetch fails', async () => {
		vi.mocked(invoke).mockRejectedValue(new Error('offline'));
		await expect(
			resolveReplyImages('chat-1', `![a](${A})`, [imageSearch(A)], () => true)
		).resolves.toBeUndefined();
		expect(getResolvedImages().size).toBe(0);
	});
});

describe('registerLocalImage', () => {
	it('makes a generated picture renderable at once', () => {
		const hash = 'b'.repeat(64);
		const url = registerLocalImage(hash, { mime: 'image/png', width: 512, height: 256 });
		expect(url).toBe(imageSrc(hash));
		const row = getResolvedImages().get(url!);
		expect(row).toMatchObject({ hash, source: 'generated', width: 512, license: null });
	});

	it('refuses something that is not a hash', () => {
		expect(registerLocalImage('not-a-hash', { mime: 'image/png', width: 1, height: 1 })).toBeNull();
		expect(getResolvedImages().size).toBe(0);
	});
});

describe('sweepImages', () => {
	it('asks Rust to reclaim unlinked bytes', async () => {
		await sweepImages();
		expect(invoke).toHaveBeenCalledWith('image_sweep');
	});

	it('keeps a failed sweep to the log', async () => {
		vi.mocked(invoke).mockRejectedValue(new Error('disk busy'));
		await expect(sweepImages()).resolves.toBeUndefined();
	});
});
