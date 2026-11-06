import { afterEach, describe, expect, it, vi } from 'vitest';
import { toImageResult, type MadeImages } from './result';

const SAMPLER = { name: 'euler', steps: 20, cfg: 5 };

function made(extra: Partial<MadeImages> = {}): MadeImages {
	return {
		backend: 'lemonade',
		width: 64,
		height: 32,
		seed: 7,
		model: 'm',
		sampler: SAMPLER,
		started: 1000,
		...extra
	};
}

/** A PNG header claiming w×h. */
function png(w: number, h: number): Uint8Array {
	const b = new Uint8Array(24);
	b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const v = new DataView(b.buffer);
	v.setUint32(16, w);
	v.setUint32(20, h);
	return b;
}

afterEach(() => vi.useRealTimers());

describe('toImageResult', () => {
	it('shapes the bytes at the size asked for, and times the work', () => {
		vi.useFakeTimers({ now: 1250 });
		const bytes = new Uint8Array([1, 2]);
		expect(toImageResult([bytes], made())).toEqual({
			images: [{ bytes, mimeType: 'image/png', width: 64, height: 32 }],
			meta: {
				seed: 7,
				model: 'm',
				backend: 'lemonade',
				sampler: SAMPLER,
				loras: [],
				durationMs: 250
			}
		});
	});

	it('reads the size from the PNG header when asked, falling back to the request', () => {
		const out = toImageResult([png(128, 96), new Uint8Array(4)], made({ sizeFromPng: true }));
		expect(out.images.map(({ width, height }) => [width, height])).toEqual([
			[128, 96],
			[64, 32]
		]);
	});

	it('ignores the header unless asked', () => {
		const [img] = toImageResult([png(128, 96)], made()).images;
		expect([img.width, img.height]).toEqual([64, 32]);
	});

	it('keeps the LoRAs and failure notes it is given, and leaves out empty notes', () => {
		const loras = [{ name: 'l', strength: 0.5 }];
		const meta = toImageResult(
			[],
			made({ loras, seamFailed: 'no seams', transparencyFailed: undefined })
		).meta;
		expect(meta.loras).toBe(loras);
		expect(meta.seamFailed).toBe('no seams');
		expect('transparencyFailed' in meta).toBe(false);
	});
});
