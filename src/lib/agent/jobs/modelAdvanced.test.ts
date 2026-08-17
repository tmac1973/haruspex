import { describe, it, expect } from 'vitest';
import {
	defaultModelAdvanced,
	defaultSourceForCaps,
	describeSamplingProfile,
	parseModelAdvanced,
	parseSamplingParams,
	serializeModelAdvanced,
	type JobModelAdvanced
} from './modelAdvanced';

/**
 * This JSON lives in user databases and is read at the start of every
 * unattended run, so the parse contract is the whole point: anything
 * unrecognized has to degrade to a working default rather than throw at 3am
 * or — worse — resolve to a value nobody chose.
 */
describe('parseModelAdvanced', () => {
	it('returns defaults for null, blank, and malformed input', () => {
		const d = defaultModelAdvanced();
		expect(parseModelAdvanced(null)).toEqual(d);
		expect(parseModelAdvanced(undefined)).toEqual(d);
		expect(parseModelAdvanced('')).toEqual(d);
		expect(parseModelAdvanced('not json')).toEqual(d);
		expect(parseModelAdvanced('[1,2,3]')).toEqual(d);
		expect(parseModelAdvanced('"a string"')).toEqual(d);
		expect(parseModelAdvanced('null')).toEqual(d);
	});

	it('defaults reasoning to inherit for anything but on/off', () => {
		expect(parseModelAdvanced('{"reasoning":{"mode":"on"}}').reasoning.mode).toBe('on');
		expect(parseModelAdvanced('{"reasoning":{"mode":"off"}}').reasoning.mode).toBe('off');
		// A value from a future version, or a typo, must not silently mean "on".
		expect(parseModelAdvanced('{"reasoning":{"mode":"maybe"}}').reasoning.mode).toBe('inherit');
		expect(parseModelAdvanced('{"reasoning":true}').reasoning.mode).toBe('inherit');
		expect(parseModelAdvanced('{"reasoning":{}}').reasoning).toEqual({
			mode: 'inherit',
			effort: null
		});
	});

	/**
	 * Jobs configured before effort existed are sitting in user databases with
	 * a bare string here. Degrading one to `inherit` would silently turn
	 * reasoning back ON for a job whose owner deliberately turned it off — at
	 * 3am, with nobody watching.
	 */
	it('reads the legacy bare-string reasoning value', () => {
		expect(parseModelAdvanced('{"reasoning":"off"}').reasoning).toEqual({
			mode: 'off',
			effort: null
		});
		expect(parseModelAdvanced('{"reasoning":"on"}').reasoning).toEqual({
			mode: 'on',
			effort: null
		});
		expect(parseModelAdvanced('{"reasoning":"nonsense"}').reasoning).toEqual({
			mode: 'inherit',
			effort: null
		});
	});

	it('keeps an effort level and drops an unusable one', () => {
		expect(parseModelAdvanced('{"reasoning":{"mode":"on","effort":"medium"}}').reasoning).toEqual({
			mode: 'on',
			effort: 'medium'
		});
		// Blank and non-string efforts mean "inherit", not a level named "".
		expect(
			parseModelAdvanced('{"reasoning":{"mode":"on","effort":""}}').reasoning.effort
		).toBeNull();
		expect(
			parseModelAdvanced('{"reasoning":{"mode":"on","effort":3}}').reasoning.effort
		).toBeNull();
	});

	it('defaults the sampling source to profile — the historical behavior', () => {
		expect(parseModelAdvanced('{}').sampling.source).toBe('profile');
		expect(parseModelAdvanced('{"sampling":{"source":"nonsense"}}').sampling.source).toBe(
			'profile'
		);
		expect(parseModelAdvanced('{"sampling":{"source":"server"}}').sampling.source).toBe('server');
	});

	it('keeps custom params only under the custom source', () => {
		const params = '{"temperature":0.4,"top_k":30}';
		expect(
			parseModelAdvanced(`{"sampling":{"source":"custom","params":${params}}}`).sampling.params
		).toMatchObject({ temperature: 0.4, top_k: 30 });
		// Stale params stored against a non-custom source must not resurface.
		expect(
			parseModelAdvanced(`{"sampling":{"source":"profile","params":${params}}}`).sampling.params
		).toBeNull();
	});

	it('round-trips a fully-populated config', () => {
		const cfg: JobModelAdvanced = {
			reasoning: { mode: 'off', effort: 'low' },
			sampling: {
				source: 'custom',
				params: {
					temperature: 0.6,
					top_p: 0.95,
					top_k: 20,
					min_p: 0,
					presence_penalty: 1.5
				}
			},
			discovered: {
				reasoning: {
					supported: true,
					default_enabled: true,
					toggle: 'chat_template_kwargs',
					kwarg: 'enable_thinking'
				},
				sampling: { default: { temperature: 0.7 }, presets: [{ name: 'thinking', top_p: 0.95 }] }
			}
		};
		const json = serializeModelAdvanced(cfg);
		expect(json).not.toBeNull();
		const back = parseModelAdvanced(json);
		expect(back.reasoning).toEqual({ mode: 'off', effort: 'low' });
		expect(back.sampling.source).toBe('custom');
		expect(back.sampling.params).toMatchObject({ temperature: 0.6, presence_penalty: 1.5 });
		expect(back.discovered?.reasoning?.kwarg).toBe('enable_thinking');
		expect(back.discovered?.sampling?.presets[0]).toMatchObject({ name: 'thinking', top_p: 0.95 });
	});
});

describe('serializeModelAdvanced', () => {
	it('stores NULL for an untouched config', () => {
		// An all-defaults job should leave the column empty rather than
		// writing a row of noise to every job in the database.
		expect(serializeModelAdvanced(defaultModelAdvanced())).toBeNull();
	});

	it('drops custom params when the source is not custom', () => {
		const json = serializeModelAdvanced({
			reasoning: { mode: 'inherit', effort: null },
			sampling: { source: 'server', params: { temperature: 0.9 } },
			discovered: null
		});
		expect(JSON.parse(json!).sampling.params).toBeNull();
	});
});

describe('parseSamplingParams', () => {
	it('keeps only finite numbers', () => {
		const p = parseSamplingParams({
			temperature: 0.6,
			top_p: 'high',
			top_k: null,
			min_p: NaN,
			presence_penalty: 0
		});
		expect(p).toEqual({
			temperature: 0.6,
			top_p: undefined,
			top_k: undefined,
			min_p: undefined,
			// Zero is a real value, not an absent one — dropping it would
			// silently re-enable llama.cpp's own default.
			presence_penalty: 0
		});
	});

	it('returns null when nothing numeric survives', () => {
		expect(parseSamplingParams({ temperature: 'warm' })).toBeNull();
		expect(parseSamplingParams({})).toBeNull();
		expect(parseSamplingParams(null)).toBeNull();
	});
});

describe('defaultSourceForCaps', () => {
	it('defers to a server that publishes its own recommendations', () => {
		expect(
			defaultSourceForCaps({
				reasoning: null,
				sampling: { default: { temperature: 0.7 }, presets: [] }
			})
		).toBe('server');
	});

	it('falls back to the tuned profile when the server publishes none', () => {
		expect(defaultSourceForCaps(null)).toBe('profile');
		expect(defaultSourceForCaps({ reasoning: null, sampling: null })).toBe('profile');
	});
});

/**
 * What the "App-tuned profile" option promises the user. The four cases are
 * genuinely different, and an earlier version conflated two of them: it
 * promised "the app's tuned values filling any gaps" for a model the app has
 * no tuned values for. Only llama-toolchest publishes sampling caps, so the
 * no-caps branches are what most users see.
 */
describe('describeSamplingProfile', () => {
	it('promises gap-filling only when there is a family to fill from', () => {
		expect(describeSamplingProfile('qwen3.5', true)).toContain('qwen3.5');
		expect(describeSamplingProfile('qwen3.5', true)).toContain('filling any parameter');
	});

	it('says the server wins outright when the app has no tuning', () => {
		const text = describeSamplingProfile(null, true);
		expect(text).not.toContain('filling any parameter');
		expect(text).toContain('own default applies');
	});

	it('names the family when there are no server caps', () => {
		expect(describeSamplingProfile('qwen-dense-27b', false)).toContain('qwen-dense-27b');
	});

	it('admits the no-op case rather than implying something is sent', () => {
		// The case that matters: with neither source, 'profile' sends nothing,
		// which makes it identical to 'server'. Saying anything else is a lie
		// the user cannot check.
		const text = describeSamplingProfile(null, false);
		expect(text).toContain('nothing is sent');
		expect(text).toContain('Server defaults');
	});
});
