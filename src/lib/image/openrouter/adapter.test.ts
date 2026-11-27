import { describe, it, expect } from 'vitest';
import {
	buildImageBody,
	capabilitiesOf,
	costOf,
	drawsPictures,
	formatUsd,
	mimeOf,
	modelOptions,
	nearestAspectRatio,
	nearestResolution,
	parseImageModels,
	picturesFrom,
	priceLine,
	type OpenRouterImageModel
} from './adapter';

/** Rows as `GET /v1/images/models` sends them (trimmed). */
const LIST = {
	data: [
		{
			id: 'openai/gpt-image-2',
			name: 'OpenAI: GPT Image 2',
			supported_parameters: {
				aspect_ratio: { type: 'enum', values: ['1:1', '3:2', '2:3', '16:9', '9:16', 'auto'] },
				output_format: { type: 'enum', values: ['png', 'jpeg', 'webp'] },
				background: { type: 'enum', values: ['auto', 'transparent', 'opaque'] },
				n: { type: 'range', min: 1, max: 10 },
				input_references: { type: 'range', min: 0, max: 16 }
			}
		},
		{
			id: 'qwen/qwen-image-2.1-turbo',
			name: 'Qwen: Qwen Image 2.1 Turbo',
			supported_parameters: {
				resolution: { type: 'enum', values: ['1K', '2K'] },
				aspect_ratio: { type: 'enum', values: ['1:1', '4:3', '3:4'] },
				seed: { type: 'boolean' }
			}
		},
		{
			id: 'krea/k3-edit',
			name: 'Krea: K3 Edit',
			supported_parameters: { input_references: { type: 'range', min: 1, max: 4 } }
		},
		{
			id: 'recraft/recraft-v4-vector',
			name: 'Recraft: V4 Vector',
			supported_parameters: { output_format: { type: 'enum', values: ['svg'] } }
		},
		{ name: 'no id' },
		{ id: 'odd/model', supported_parameters: { weird: { type: 'list' } } }
	]
};

const models = parseImageModels(LIST);
const byId = (id: string) => models.find((m) => m.id === id) as OpenRouterImageModel;

describe('parseImageModels', () => {
	it('keeps rows with an id and the parameters it can read', () => {
		expect(models.map((m) => m.id)).toEqual([
			'openai/gpt-image-2',
			'qwen/qwen-image-2.1-turbo',
			'krea/k3-edit',
			'recraft/recraft-v4-vector',
			'odd/model'
		]);
		expect(byId('odd/model')).toEqual({ id: 'odd/model', name: 'odd/model', params: {} });
		expect(byId('qwen/qwen-image-2.1-turbo').params.seed).toEqual({ type: 'boolean' });
	});

	it('reads nothing from a malformed answer', () => {
		expect(parseImageModels(null)).toEqual([]);
		expect(parseImageModels({ data: 'x' })).toEqual([]);
	});
});

describe('drawsPictures and modelOptions', () => {
	it('leaves out edit-only and vector-only models', () => {
		expect(drawsPictures(byId('krea/k3-edit'))).toBe(false);
		expect(drawsPictures(byId('recraft/recraft-v4-vector'))).toBe(false);
		expect(drawsPictures(byId('openai/gpt-image-2'))).toBe(true);
	});

	it('lists what draws, by name', () => {
		expect(modelOptions(models)).toEqual([
			{ name: 'odd/model', label: 'odd/model' },
			{ name: 'openai/gpt-image-2', label: 'OpenAI: GPT Image 2' },
			{ name: 'qwen/qwen-image-2.1-turbo', label: 'Qwen: Qwen Image 2.1 Turbo' }
		]);
	});
});

describe('capabilitiesOf', () => {
	it('edits as many pictures as it takes, and is transparent when it says so', () => {
		expect(capabilitiesOf(byId('openai/gpt-image-2'))).toEqual({
			transparency: true,
			seamlessTiling: false,
			loras: false,
			maxLoras: 0,
			edit: true,
			maxEditImages: 16,
			upscale: false,
			inpaint: false
		});
	});

	it('neither edits nor is transparent when the model lists neither', () => {
		const caps = capabilitiesOf(byId('qwen/qwen-image-2.1-turbo'));
		expect(caps.edit).toBe(false);
		expect(caps.maxEditImages).toBe(0);
		expect(caps.transparency).toBe(false);
	});
});

describe('nearestAspectRatio', () => {
	const ratios = ['1:1', '3:2', '2:3', '16:9', '9:16', 'auto'];
	it('picks the closest listed ratio', () => {
		expect(nearestAspectRatio(ratios, 1024, 1024)).toBe('1:1');
		expect(nearestAspectRatio(ratios, 1920, 1080)).toBe('16:9');
		expect(nearestAspectRatio(ratios, 1200, 800)).toBe('3:2');
		expect(nearestAspectRatio(ratios, 640, 960)).toBe('2:3');
	});
	it('is null with nothing it can read', () => {
		expect(nearestAspectRatio(['auto'], 512, 512)).toBeNull();
	});
});

describe('nearestResolution', () => {
	it('takes the smallest tier that reaches the long side, else the largest', () => {
		expect(nearestResolution(['1K', '2K', '4K'], 512)).toBe('1K');
		expect(nearestResolution(['2K', '1K'], 1500)).toBe('2K');
		expect(nearestResolution(['1K', '2K'], 3000)).toBe('2K');
		expect(nearestResolution(['huge'], 512)).toBeNull();
	});
});

describe('buildImageBody', () => {
	const req = {
		model: 'openai/gpt-image-2',
		prompt: 'a red apple',
		width: 1024,
		height: 576,
		seed: 42,
		transparent: true,
		references: []
	};

	it('sends only what the model lists', () => {
		expect(buildImageBody(byId('openai/gpt-image-2'), req)).toEqual({
			model: 'openai/gpt-image-2',
			prompt: 'a red apple',
			response_format: 'b64_json',
			aspect_ratio: '16:9',
			output_format: 'png',
			background: 'transparent'
		});
	});

	it('sends a seed and a tier to a model that takes them, and no background it lacks', () => {
		const body = buildImageBody(byId('qwen/qwen-image-2.1-turbo'), {
			...req,
			model: 'qwen/qwen-image-2.1-turbo',
			width: 512,
			height: 512
		});
		expect(body).toMatchObject({ aspect_ratio: '1:1', resolution: '1K', seed: 42 });
		expect(body).not.toHaveProperty('background');
	});

	it('sends pictures to edit as image_url references', () => {
		const body = buildImageBody(byId('openai/gpt-image-2'), {
			...req,
			transparent: false,
			references: ['data:image/png;base64,AAAA']
		});
		expect(body.input_references).toEqual([
			{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
		]);
		expect(body).not.toHaveProperty('background');
	});
});

describe('answers', () => {
	it('reads the pictures and the cost', () => {
		const payload = {
			data: [{ b64_json: 'AAA' }, { url: 'x' }, { b64_json: '' }],
			usage: { cost: 0.13 }
		};
		expect(picturesFrom(payload)).toEqual(['AAA']);
		expect(costOf(payload)).toBe(0.13);
		expect(costOf({})).toBeNull();
		expect(picturesFrom(null)).toEqual([]);
	});
});

describe('priceLine', () => {
	const endpoints = (pricing: unknown[]) => ({ endpoints: [{ pricing }] });

	it('says a per-picture price, the cheapest variant', () => {
		expect(
			priceLine(
				endpoints([
					{ billable: 'input_image', unit: 'image', cost_usd: 0 },
					{ billable: 'output_image', unit: 'image', cost_usd: 0.04, variant: '2k' },
					{ billable: 'output_image', unit: 'image', cost_usd: 0.0184, variant: '1k' }
				])
			)
		).toBe('$0.018 a picture');
	});

	it('says free, per megapixel, or by token', () => {
		expect(priceLine(endpoints([{ billable: 'output_image', unit: 'image', cost_usd: 0 }]))).toBe(
			'free'
		);
		expect(
			priceLine(endpoints([{ billable: 'output_image', unit: 'megapixel', cost_usd: 0.03 }]))
		).toBe('$0.03 a megapixel');
		expect(
			priceLine(endpoints([{ billable: 'output_image', unit: 'token', cost_usd: 0.00003 }]))
		).toBe('priced by token');
	});

	it('is null with no output price', () => {
		expect(priceLine(endpoints([]))).toBeNull();
		expect(priceLine({})).toBeNull();
	});
});

describe('formatUsd', () => {
	it('rounds to cents at a dollar and up, two figures below', () => {
		expect(formatUsd(1.234)).toBe('$1.23');
		expect(formatUsd(0.0184)).toBe('$0.018');
		expect(formatUsd(0.13)).toBe('$0.13');
		expect(formatUsd(0.4)).toBe('$0.40');
		expect(formatUsd(0)).toBe('$0.00');
	});
});

describe('mimeOf', () => {
	it('knows PNG, JPEG, WebP and GIF by their first bytes', () => {
		expect(mimeOf(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png');
		expect(mimeOf(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
		expect(
			mimeOf(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))
		).toBe('image/webp');
		expect(mimeOf(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBe('image/gif');
		expect(mimeOf(new Uint8Array([1, 2, 3]))).toBe('image/png');
	});
});
