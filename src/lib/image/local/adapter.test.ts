import { describe, it, expect } from 'vitest';
import {
	FIXTURE,
	ROUTES,
	buildRequest,
	capabilitiesFrom,
	declaredCapabilities,
	fromBase64,
	imagesFrom,
	seedFrom,
	serves,
	toBase64,
	DEFAULT_SAMPLER
} from './adapter';
import type { SdCapabilityFixture } from './adapter';
import type { ImageBackendCapabilities } from '../types';

const FULL: ImageBackendCapabilities = {
	referenceConditioning: true,
	seamlessTiling: true,
	loras: true,
	maxLoras: 4
};

const req = {
	prompt: 'a sword',
	negativePrompt: 'blurry',
	seed: null as number | null,
	width: 512,
	height: 512
};

describe('the committed fixture', () => {
	it('records the pinned version and at least one generation route', () => {
		// Without a generation route the backend cannot do its one job, which
		// is why the fetch script constrains the pin to a build that has one.
		expect(FIXTURE.version).toMatch(/\S/);
		expect(FIXTURE.routes.length).toBeGreaterThan(0);
		expect(serves(ROUTES.txt2img)).toBe(true);
		expect(serves(ROUTES.ready)).toBe(true);
	});

	it('is the source of the declared capabilities, not a hand-written claim', () => {
		// The claim and the fixture must move together: a version bump that
		// drops a feature should fail here rather than leave the job trusting
		// a capability the build no longer has.
		const declared = declaredCapabilities();
		expect(declared.seamlessTiling).toBe(FIXTURE.capabilities.seamlessTiling);
		expect(declared.loras).toBe(FIXTURE.capabilities.loras);
	});

	it('agrees with the rule applied to itself', () => {
		expect(declaredCapabilities()).toEqual(capabilitiesFrom(FIXTURE));
	});
});

/**
 * Tested against fixtures OTHER than the committed one on purpose. The
 * committed fixture currently has every capability switched on, so asserting
 * only against it passes identically for a hardcoded `true` — which is the
 * exact bug the fixture exists to prevent.
 */
describe('capabilitiesFrom', () => {
	const fixture = (over: Partial<SdCapabilityFixture> = {}): SdCapabilityFixture => ({
		version: 'test',
		capabilities: { referenceConditioning: true, seamlessTiling: true, loras: true, maxLoras: 4 },
		flags: {},
		routes: [ROUTES.txt2img, ROUTES.img2img, ROUTES.ready],
		...over
	});

	it('reports what the fixture says, not what we hope', () => {
		const d = capabilitiesFrom(
			fixture({
				capabilities: {
					referenceConditioning: false,
					seamlessTiling: false,
					loras: false,
					maxLoras: 0
				}
			})
		);
		expect(d).toEqual({
			referenceConditioning: false,
			seamlessTiling: false,
			loras: false,
			maxLoras: 0
		});
	});

	it('withdraws reference conditioning when no route could carry a reference', () => {
		// The flag says IP-Adapter was compiled in; the route is how an image
		// would actually reach it. Either missing means the layer is
		// unavailable, and claiming it anyway is how the job stops degrading
		// and starts silently shipping off-style art.
		const d = capabilitiesFrom(fixture({ routes: [ROUTES.txt2img, ROUTES.ready] }));
		expect(d.referenceConditioning).toBe(false);
	});

	it('keeps reference conditioning when both the flag and the route are there', () => {
		expect(capabilitiesFrom(fixture()).referenceConditioning).toBe(true);
	});

	it('reports no LoRA slots when LoRAs are unsupported', () => {
		// maxLoras > 0 with loras false is a contradiction the generation loop
		// reads as "slots available", and it would degrade nothing.
		const d = capabilitiesFrom(
			fixture({
				capabilities: {
					referenceConditioning: true,
					seamlessTiling: true,
					loras: false,
					maxLoras: 4
				}
			})
		);
		expect(d.loras).toBe(false);
		expect(d.maxLoras).toBe(0);
	});

	it('passes the slot count through when LoRAs are supported', () => {
		expect(capabilitiesFrom(fixture()).maxLoras).toBe(4);
	});
});

describe('buildRequest', () => {
	it('sends -1 rather than 0 when no seed was pinned', () => {
		// This API reads 0 as a seed. Every unpinned request would produce the
		// identical image, and a retry would repeat its own failure.
		expect(buildRequest(req, FULL).body.seed).toBe(-1);
	});

	it('passes a pinned seed through untouched', () => {
		expect(buildRequest({ ...req, seed: 7 }, FULL).body.seed).toBe(7);
	});

	it('uses txt2img and attaches nothing when there is no reference', () => {
		const { route, body } = buildRequest(req, FULL);
		expect(route).toBe(ROUTES.txt2img);
		expect(body.init_images).toBeUndefined();
		expect(body.denoising_strength).toBeUndefined();
	});

	it('carries the prompt, negative prompt and size', () => {
		const { body } = buildRequest(req, FULL);
		expect(body.prompt).toBe('a sword');
		expect(body.negative_prompt).toBe('blurry');
		expect(body.width).toBe(512);
		expect(body.height).toBe(512);
		expect(body.batch_size).toBe(1);
		expect(body.n_iter).toBe(1);
	});

	it('falls back to the pinned build’s sampler when none is given', () => {
		const { body } = buildRequest(req, FULL);
		expect(body.sampler_name).toBe(DEFAULT_SAMPLER.name);
		expect(body.steps).toBe(DEFAULT_SAMPLER.steps);
		expect(body.cfg_scale).toBe(DEFAULT_SAMPLER.cfg);
	});

	it('switches to img2img and inverts the strength when conditioning is possible', () => {
		// The API's strength is how far to travel FROM the reference, so a
		// caller asking to be pulled hard toward it wants a LOW number. One
		// place inverts it so every caller keeps one meaning.
		const { route, body } = buildRequest(
			{ ...req, referenceImage: new Uint8Array([1, 2, 3]), referenceStrength: 0.8 },
			FULL
		);
		expect(route).toBe(ROUTES.img2img);
		expect(body.init_images).toHaveLength(1);
		expect(body.denoising_strength).toBeCloseTo(0.2);
	});

	it('ignores a reference the backend cannot use', () => {
		// Sending init_images to a backend reporting no conditioning would
		// quietly turn every generation into an img2img of the anchor.
		const caps = { ...FULL, referenceConditioning: false };
		const { route, body } = buildRequest(
			{ ...req, referenceImage: new Uint8Array([1, 2, 3]) },
			caps
		);
		expect(route).toBe(ROUTES.txt2img);
		expect(body.init_images).toBeUndefined();
	});

	it('ignores an empty reference', () => {
		const { route } = buildRequest({ ...req, referenceImage: new Uint8Array() }, FULL);
		expect(route).toBe(ROUTES.txt2img);
	});
});

describe('base64 round trip', () => {
	it('survives arbitrary bytes, including nulls and high values', () => {
		const bytes = new Uint8Array([0, 1, 127, 128, 200, 255, 0]);
		expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
	});

	it('tolerates a data: URL, which some builds return', () => {
		const bytes = new Uint8Array([137, 80, 78, 71]);
		const withPrefix = `data:image/png;base64,${toBase64(bytes)}`;
		expect([...fromBase64(withPrefix)]).toEqual([...bytes]);
	});
});

describe('reading a response', () => {
	it('decodes every image, in order', () => {
		const a = toBase64(new Uint8Array([1]));
		const b = toBase64(new Uint8Array([2]));
		const out = imagesFrom({ images: [a, b] });
		expect(out).toHaveLength(2);
		expect([...out[0]]).toEqual([1]);
		expect([...out[1]]).toEqual([2]);
	});

	it('returns nothing rather than throwing on a shape it does not recognise', () => {
		for (const bad of [{}, { images: null }, { images: 'x' }, null, undefined, 42]) {
			expect(imagesFrom(bad)).toEqual([]);
		}
	});

	it('reads the resolved seed out of the info string', () => {
		// A1111 returns it as a JSON STRING, not an object. A recipe recording
		// a seed nobody used explains nothing.
		expect(seedFrom({ info: JSON.stringify({ seed: 4242 }) }, -1)).toBe(4242);
	});

	it('falls back to all_seeds when seed is absent', () => {
		expect(seedFrom({ info: JSON.stringify({ all_seeds: [99] }) }, -1)).toBe(99);
	});

	it('falls back to the requested seed when info is missing or unparseable', () => {
		expect(seedFrom({}, 7)).toBe(7);
		expect(seedFrom({ info: 'not json' }, 7)).toBe(7);
		expect(seedFrom({ info: JSON.stringify({ seed: 'x' }) }, 7)).toBe(7);
	});
});
