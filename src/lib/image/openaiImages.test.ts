import { describe, it, expect } from 'vitest';
import { editUploads, imagesFrom, upscaleVia } from './openaiImages';

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

describe('upscaleVia', () => {
	const input = { bytes: [1, 2, 3], name: 'in.png' };

	it('posts the model and the picture as base64, and reads the answer under its key', async () => {
		const sent: unknown[] = [];
		const post = async (body: unknown) => {
			sent.push(body);
			return { images: [{ b64_json: 'BwgJ' }] };
		};
		expect(await upscaleVia(post, 'esrgan', input, 'images', 'S')).toEqual(
			new Uint8Array([7, 8, 9])
		);
		expect(sent).toEqual([{ model: 'esrgan', image: 'AQID' }]);
	});

	it('refuses an answer with nothing under its key, naming the server', async () => {
		const post = async () => ({ images: [{ b64_json: 'BwgJ' }] });
		await expect(upscaleVia(post, 'm', input, 'data', 'Lemonade')).rejects.toThrow(
			'Lemonade returned no upscaled picture.'
		);
		await expect(upscaleVia(async () => null, 'm', input, 'data', 'X')).rejects.toThrow(
			'X returned no upscaled picture.'
		);
	});
});
