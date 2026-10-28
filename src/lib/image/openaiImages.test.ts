import { describe, it, expect } from 'vitest';
import { editUploads, imagesFrom } from './openaiImages';

describe('imagesFrom', () => {
	it('reads OpenAI-style images, skipping URL entries', () => {
		expect(imagesFrom({ data: [{ b64_json: 'AQID' }, { url: 'x' }] })).toEqual([
			new Uint8Array([1, 2, 3])
		]);
	});

	it('reads nothing from an answer without data', () => {
		expect(imagesFrom({ error: 'x' })).toEqual([]);
		expect(imagesFrom(null)).toEqual([]);
	});
});

describe('editUploads', () => {
	it('sends cached pictures by hash and new ones by bytes, then the mask', () => {
		const parts = editUploads({
			images: [
				{ name: 'a.png', hash: 'abc' },
				{ name: 'b.png', bytes: [1, 2] }
			],
			mask: { name: 'm.png', bytes: [255] }
		} as never);
		expect(parts).toEqual([
			{ field: 'image[]', filename: 'a.png', hash: 'abc', cache: 'image', bytes: null },
			{ field: 'image[]', filename: 'b.png', hash: null, cache: null, bytes: [1, 2] },
			{ field: 'mask', filename: 'm.png', hash: null, cache: null, bytes: [255] }
		]);
	});

	it('leaves the mask out when there is none', () => {
		const parts = editUploads({ images: [{ name: 'a.png', hash: 'abc' }] } as never);
		expect(parts.map((p) => p.field)).toEqual(['image[]']);
	});
});
