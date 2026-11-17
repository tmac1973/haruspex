import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

import { invoke } from '@tauri-apps/api/core';
import { invokeCalls, invokeRouter } from '#lib/testing/invoke.ts';
import { peerImageUrl, releasePeerImages } from './images.ts';

const URL_A = 'haruspex-img:' + 'a'.repeat(64);
const URL_B = 'https://example.com/a.png';

beforeEach(() => {
	releasePeerImages('desk');
	vi.mocked(invoke).mockReset();
	vi.mocked(invoke).mockImplementation(
		invokeRouter({
			// Both URLs are one image there.
			peer_images_lookup: (args) => ({
				images: Object.fromEntries(
					(args as { urls: string[] }).urls.map((u) => [
						u,
						{ hash: 'a'.repeat(64), mime: 'image/png' }
					])
				)
			}),
			peer_image: () => new Uint8Array([1, 2, 3]).buffer
		})
	);
	let n = 0;
	URL.createObjectURL = vi.fn(() => `blob:${++n}`);
	URL.revokeObjectURL = vi.fn();
});

describe("another computer's pictures", () => {
	it('reads an image once, however it is asked for', async () => {
		expect(await peerImageUrl('desk', URL_A)).toBe('blob:1');
		expect(await peerImageUrl('desk', URL_B)).toBe('blob:1');
		expect(invokeCalls(vi.mocked(invoke), 'peer_image')).toHaveLength(1);
	});

	it("is null for an image it hasn't got, and lets go of the rest", async () => {
		vi.mocked(invoke).mockImplementationOnce(invokeRouter({ peer_images_lookup: { images: {} } }));
		expect(await peerImageUrl('desk', URL_A)).toBeNull();
		await peerImageUrl('desk', URL_A);
		releasePeerImages('desk');
		await new Promise((r) => setTimeout(r, 0));
		expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:1');
	});
});
