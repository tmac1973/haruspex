import { describe, it, expect } from 'vitest';
import { parseModelSpec } from './parse';
import { renderModelSpec } from './write';
import { validateModelSpec } from './validate';
import { DEFAULT_MODELS_SPEC_PATH, modelDir, modelFiles, REPORT_NAME } from './paths';
import type { ModelEntry, ModelSpec } from './types';

function entry(over: Partial<ModelEntry> = {}): ModelEntry {
	return {
		id: 'fox',
		title: 'Fox',
		description: 'a small orange fox',
		height_m: 0.5,
		parts: ['head', 'tail'],
		clips: [{ name: 'walk', seconds: 1, loop: true, action: 'trots forward' }],
		dir: 'assets/generated/model/fox/',
		...over
	};
}

function spec(over: Partial<ModelSpec> = {}): ModelSpec {
	return {
		version: 1,
		style: 'low-poly, flat colours, warm palette',
		entries: [
			entry(),
			entry({ id: 'crate', title: 'Crate', parts: [], clips: [], dir: modelDir('crate') })
		],
		...over
	};
}

function ok(json: string): ModelSpec {
	const r = parseModelSpec(json);
	if ('errors' in r) throw new Error(r.errors.join('; '));
	return r.spec;
}

/** The problems for a spec holding just this one entry. */
function problemsFor(over: Partial<ModelEntry>): string[] {
	return validateModelSpec(spec({ entries: [entry(over)] }));
}

describe('paths', () => {
	it('names the spec, the report and an entry folder', () => {
		expect(DEFAULT_MODELS_SPEC_PATH).toBe('assets/haruspex-models.json');
		expect(REPORT_NAME).toBe('REPORT-models.md');
		expect(modelDir('fox')).toBe('assets/generated/model/fox/');
	});

	it('puts every file of an entry under its folder', () => {
		const f = modelFiles(entry());
		expect(f.build).toBe('assets/generated/model/fox/fox.js');
		expect(f.anim).toBe('assets/generated/model/fox/fox.anim.js');
		expect(f.glb).toBe('assets/generated/model/fox/fox.glb');
		expect(f.sheet).toBe('assets/generated/model/fox/sheet.png');
		expect(f.clipSheet('Run Fast')).toBe('assets/generated/model/fox/clip-run_fast.png');
	});

	it('adds the slash a hand-written folder left off', () => {
		expect(modelFiles(entry({ dir: 'assets/m' })).glb).toBe('assets/m/fox.glb');
	});
});

describe('parse', () => {
	it('reports malformed JSON rather than throwing', () => {
		const r = parseModelSpec('{ nope');
		expect('errors' in r && r.errors[0]).toMatch(/not valid JSON/);
	});

	it('reports a spec that is not an object', () => {
		const r = parseModelSpec('[]');
		expect('errors' in r && r.errors[0]).toMatch(/JSON object/);
	});

	it('reports a missing entries array', () => {
		const r = parseModelSpec('{"style":"x"}');
		expect('errors' in r && r.errors[0]).toMatch(/no "entries"/);
	});

	it('fills the folder, parts and clips when the file omits them', () => {
		const s = ok('{"style":"s","entries":[{"id":"rock","title":"Rock","height_m":1}]}');
		expect(s.entries[0].dir).toBe('assets/generated/model/rock/');
		expect(s.entries[0].parts).toEqual([]);
		expect(s.entries[0].clips).toEqual([]);
	});

	it('loops locomotion and idle clips by default, and nothing else', () => {
		const s = ok(
			JSON.stringify({
				entries: [
					{
						id: 'bird',
						height_m: 0.3,
						parts: ['wing_l'],
						clips: [
							{ name: 'Idle', seconds: 2 },
							{ name: 'fly_loop', seconds: 1 },
							{ name: 'attack', seconds: 1 },
							{ name: 'swim', seconds: 1, loop: false }
						]
					}
				]
			})
		);
		expect(s.entries[0].clips.map((c) => c.loop)).toEqual([true, true, false, false]);
	});

	it('round-trips through render', () => {
		const once = ok(renderModelSpec(spec()));
		expect(once).toEqual(spec());
		expect(renderModelSpec(ok(renderModelSpec(once)))).toBe(renderModelSpec(spec()));
	});
});

describe('validate', () => {
	it('passes a good spec', () => {
		expect(validateModelSpec(spec())).toEqual([]);
	});

	it('wants between 1 and 24 entries', () => {
		expect(validateModelSpec(spec({ entries: [] }))[0]).toMatch(/no models/);
		const many = Array.from({ length: 25 }, (_, i) =>
			entry({ id: `m_${i}`, dir: modelDir(`m_${i}`) })
		);
		expect(validateModelSpec(spec({ entries: many }))[0]).toMatch(/at most 24/);
	});

	it('wants slug ids, each used once', () => {
		expect(problemsFor({ id: 'Bad Id' })[0]).toMatch(/the id must/);
		expect(validateModelSpec(spec({ entries: [entry(), entry()] }))).toEqual([
			'fox: duplicate id.'
		]);
	});

	it('wants a height between 0.05 and 50 metres', () => {
		expect(problemsFor({ height_m: 0.01 })[0]).toMatch(/height_m/);
		expect(problemsFor({ height_m: 51 })[0]).toMatch(/height_m/);
		expect(problemsFor({ height_m: NaN })[0]).toMatch(/height_m/);
		expect(problemsFor({ height_m: 50 })).toEqual([]);
	});

	it('wants part names an animator can address, each once', () => {
		expect(problemsFor({ parts: ['1leg'] })[0]).toMatch(/part "1leg"/);
		expect(problemsFor({ parts: ['left-leg'] })[0]).toMatch(/part "left-leg"/);
		expect(problemsFor({ parts: ['head', 'head'] })[0]).toMatch(/listed twice/);
	});

	it('wants clip names once each and a length of 0.2 to 10 seconds', () => {
		const walk = { name: 'walk', seconds: 1, loop: true, action: '' };
		expect(problemsFor({ clips: [walk, walk] })[0]).toMatch(/clip "walk" is listed twice/);
		expect(problemsFor({ clips: [{ ...walk, seconds: 0.1 }] })[0]).toMatch(/seconds/);
		expect(problemsFor({ clips: [{ ...walk, seconds: 11 }] })[0]).toMatch(/seconds/);
		expect(problemsFor({ clips: [{ ...walk, name: ' ' }] })[0]).toMatch(/no name/);
	});

	it('wants a part for clips to move', () => {
		expect(problemsFor({ parts: [] })[0]).toMatch(/no parts/);
	});

	it('keeps the folder under assets/', () => {
		expect(problemsFor({ dir: 'src/fox/' })[0]).toMatch(/not under assets/);
		expect(problemsFor({ dir: '/tmp/fox/' })[0]).toMatch(/not under assets/);
		expect(problemsFor({ dir: 'assets/../src/' })[0]).toMatch(/\.\./);
	});
});
