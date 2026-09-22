import { describe, it, expect } from 'vitest';
import { ImageBackendError, type ImageRequest } from './types';

describe('ImageRequest', () => {
	it('survives JSON round-tripping once the reference bytes are dropped', () => {
		// The request crosses a boundary in every backend (an HTTP body, a
		// Tauri command). Nothing non-serialisable may creep into it; the
		// reference image is the one binary field and every backend handles it
		// separately.
		const req: ImageRequest = {
			prompt: 'a tin can',
			negativePrompt: 'blurry',
			width: 512,
			height: 512,
			seed: 7,
			model: 'sd15.safetensors',
			referenceStrength: 0.6,
			loras: [{ name: 'pixel', strength: 0.8 }],
			sampler: { name: 'euler_ancestral', steps: 28, cfg: 7 },
			seamless: false
		};
		expect(JSON.parse(JSON.stringify(req))).toEqual(req);
	});

	it('treats a null seed as "the backend chooses"', () => {
		const req: ImageRequest = { prompt: 'x', width: 64, height: 64, seed: null };
		expect(JSON.parse(JSON.stringify(req)).seed).toBeNull();
	});
});

describe('ImageBackendError', () => {
	it('carries the kind, status and body a caller branches on', () => {
		const e = new ImageBackendError('rejected', 'boom', { status: 500, body: 'no model' });
		expect(e).toBeInstanceOf(Error);
		expect(e.name).toBe('ImageBackendError');
		expect(e.kind).toBe('rejected');
		expect(e.status).toBe(500);
		expect(e.body).toBe('no model');
	});

	it('needs only a kind and a message', () => {
		const e = new ImageBackendError('timeout', 'slow');
		expect(e.status).toBeUndefined();
		expect(e.body).toBeUndefined();
	});
});
