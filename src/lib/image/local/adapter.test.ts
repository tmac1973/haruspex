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

	it('claims no transparency until the engine can produce it', () => {
		// Phase 17: the pinned build cannot run Ming-Image usably, so nothing
		// this engine loads gives alpha.
		expect(declaredCapabilities().transparency).toBe(false);
	});

	it('agrees with the rule applied to itself', () => {
		expect(declaredCapabilities()).toEqual(capabilitiesFrom(FIXTURE));
	});
});

/**
 * Tested against fixtures OTHER than the committed one on purpose. Asserting
 * only against the committed fixture passes identically for a hardcoded value
 * whenever that fixture happens to agree with it — which is the exact bug the
 * fixture exists to prevent.
 */
describe('capabilitiesFrom', () => {
	const fixture = (over: Partial<SdCapabilityFixture> = {}): SdCapabilityFixture => ({
		version: 'test',
		capabilities: { transparency: false, seamlessTiling: true, loras: true, maxLoras: 4 },
		flags: {},
		routes: [ROUTES.txt2img, ROUTES.img2img, ROUTES.ready],
		...over
	});

	it('reports what the fixture says, not what we hope', () => {
		const d = capabilitiesFrom(
			fixture({
				capabilities: { transparency: true, seamlessTiling: false, loras: false, maxLoras: 0 }
			})
		);
		expect(d).toEqual({ transparency: true, seamlessTiling: false, loras: false, maxLoras: 0 });
	});

	it('reports no LoRA slots when LoRAs are unsupported', () => {
		// maxLoras > 0 with loras false is a contradiction the generation loop
		// reads as "slots available", and it would degrade nothing.
		const d = capabilitiesFrom(
			fixture({
				capabilities: { transparency: false, seamlessTiling: true, loras: false, maxLoras: 4 }
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
		expect(buildRequest(req).body.seed).toBe(-1);
	});

	it('passes a pinned seed through untouched', () => {
		expect(buildRequest({ ...req, seed: 7 }).body.seed).toBe(7);
	});

	it('uses txt2img', () => {
		expect(buildRequest(req).route).toBe(ROUTES.txt2img);
	});

	it('carries the prompt, negative prompt and size', () => {
		const { body } = buildRequest(req);
		expect(body.prompt).toBe('a sword');
		expect(body.negative_prompt).toBe('blurry');
		expect(body.width).toBe(512);
		expect(body.height).toBe(512);
		expect(body.batch_size).toBe(1);
		expect(body.n_iter).toBe(1);
	});

	it('falls back to the pinned build’s sampler when none is given', () => {
		const { body } = buildRequest(req);
		expect(body.sampler_name).toBe(DEFAULT_SAMPLER.name);
		expect(body.steps).toBe(DEFAULT_SAMPLER.steps);
		expect(body.cfg_scale).toBe(DEFAULT_SAMPLER.cfg);
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
