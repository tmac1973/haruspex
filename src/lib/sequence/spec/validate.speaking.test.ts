import { describe, it, expect } from 'vitest';
import { validateSequenceSpec, type ValidateContext } from './validate';
import { parseSequenceSpec } from './parse';
import { LTX, LTX_CAPS, S2V_10S, S2V_CAPS, presenterSpec } from '#lib/testing/sequenceSpecs.ts';

const ctx = (over: Partial<ValidateContext> = {}): ValidateContext => ({
	instance: 'ltx',
	limits: LTX,
	capabilities: LTX_CAPS,
	imageBackend: true,
	musicBackend: true,
	files: new Set(['people/tim.png']),
	speaking: { instance: 's2v', limits: S2V_10S, capabilities: S2V_CAPS },
	projectFps: 24,
	...over
});

describe('speaking sections in a spec', () => {
	it('pass with a speaking instance, noting its frame rate against the project’s', () => {
		const v = validateSequenceSpec(presenterSpec(), ctx());
		expect(v.errors).toEqual([]);
		expect(v.notes).toEqual(['Section host: s2v makes 16 fps; the project is 24 fps.']);
	});

	it('need a speaking instance, and a portrait or an image backend to draw one', () => {
		expect(validateSequenceSpec(presenterSpec(), ctx({ speaking: undefined })).errors[0]).toContain(
			'needs a speaking video instance'
		);
		const noDraw = validateSequenceSpec(presenterSpec(), ctx({ imageBackend: false }));
		expect(noDraw.errors.join(' ')).toContain('give a portrait of the person');
		const spec = presenterSpec();
		const host = spec.sections[1];
		if (host.kind === 'speaking') host.portrait = 'people/tim.png';
		expect(validateSequenceSpec(spec, ctx({ imageBackend: false })).errors).toEqual([]);
		if (host.kind === 'speaking') host.portrait = 'people/nobody.png';
		expect(validateSequenceSpec(spec, ctx()).errors[0]).toContain('not in the episode folder');
	});

	it('refuse two lines with one id', () => {
		const spec = presenterSpec();
		const host = spec.sections[1];
		if (host.kind === 'speaking') host.lines[2].id = 'l1';
		expect(validateSequenceSpec(spec, ctx()).errors).toEqual(['Line l1: two lines have this id.']);
	});

	it('read from JSON, with what is wrong named', () => {
		const ok = parseSequenceSpec(JSON.parse(JSON.stringify(presenterSpec())));
		expect(ok.problems).toEqual([]);
		expect(ok.spec?.sections[1]).toEqual(presenterSpec().sections[1]);
		const bad = JSON.parse(JSON.stringify(presenterSpec()));
		bad.sections[1].lines = [];
		bad.sections[1].window_join = 'wipe';
		const parsed = parseSequenceSpec(bad);
		expect(parsed.problems).toEqual([
			'sections[1].lines: needs at least one line',
			'sections[1].window_join: must be "cut" or "crossfade"'
		]);
	});
});
