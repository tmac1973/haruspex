import { describe, it, expect } from 'vitest';
import {
	parseAssetGenerationConfig,
	resolveSpecPath,
	DEFAULT_TARGET_SIZE,
	MAX_TARGET_SIZE,
	MIN_TARGET_SIZE
} from './config';
import { DEFAULT_SPEC_PATH } from '$lib/assets/spec/paths';

const cfg = (json: string) => parseAssetGenerationConfig(json);

describe('defaults', () => {
	it('is all-null from an empty config, so the pipeline applies its own', () => {
		const c = cfg('{}');
		expect(c.spec_path).toBeNull();
		expect(c.description).toBeNull();
		expect(c.target_size).toBeNull();
		expect(c.max_attempts).toBeNull();
		expect(c.anchor_attempts).toBeNull();
		expect(c.concurrency).toBeNull();
		expect(c.vision_judge).toBeNull();
		expect(c.use_git).toBeNull();
		expect(c.coding_run).toBeNull();
	});

	it('behaves like no config when the JSON is malformed', () => {
		expect(cfg('{ not json').run_mode).toBe('attended');
	});

	it('falls back to the conventional spec path', () => {
		expect(resolveSpecPath(cfg('{}'))).toBe(DEFAULT_SPEC_PATH);
		expect(resolveSpecPath(cfg('{"spec_path":"art/spec.json"}'))).toBe('art/spec.json');
	});
});

describe('run_mode', () => {
	it('round-trips both modes', () => {
		expect(cfg('{"run_mode":"unattended"}').run_mode).toBe('unattended');
		expect(cfg('{"run_mode":"attended"}').run_mode).toBe('attended');
	});

	it('reads anything unrecognised as attended', () => {
		// The safety-relevant case: a malformed config must not silently make a
		// run unattended, which is the rule guided planning follows too.
		for (const raw of ['{"run_mode":"yolo"}', '{"run_mode":true}', '{}']) {
			expect(cfg(raw).run_mode).toBe('attended');
		}
	});
});

describe('target_size', () => {
	it('clamps a hand-edited value to the nearest power of two', () => {
		// The parser clamps so a hand-edited config still runs; the editor
		// rejects, so a user typing 30 is told rather than silently given 32.
		expect(cfg('{"target_size":30}').target_size).toBe(32);
		expect(cfg('{"target_size":100}').target_size).toBe(128);
	});

	it('clamps to the permitted range', () => {
		expect(cfg('{"target_size":1}').target_size).toBe(MIN_TARGET_SIZE);
		expect(cfg('{"target_size":99999}').target_size).toBe(MAX_TARGET_SIZE);
	});

	it('leaves a power of two alone', () => {
		expect(cfg(`{"target_size":${DEFAULT_TARGET_SIZE}}`).target_size).toBe(DEFAULT_TARGET_SIZE);
	});

	it('ignores a non-number', () => {
		expect(cfg('{"target_size":"big"}').target_size).toBeNull();
	});
});

describe('attempt budgets', () => {
	it('are independent of one another', () => {
		// One knob for both would mean raising per-asset retries also raised
		// how many times the approval modal can be re-rolled.
		const c = cfg('{"max_attempts":9}');
		expect(c.max_attempts).toBe(9);
		expect(c.anchor_attempts).toBeNull();
		const d = cfg('{"anchor_attempts":2}');
		expect(d.anchor_attempts).toBe(2);
		expect(d.max_attempts).toBeNull();
	});

	it('clamps both at each end', () => {
		expect(cfg('{"max_attempts":0}').max_attempts).toBe(1);
		expect(cfg('{"max_attempts":50}').max_attempts).toBe(10);
		expect(cfg('{"anchor_attempts":0}').anchor_attempts).toBe(1);
		expect(cfg('{"anchor_attempts":50}').anchor_attempts).toBe(10);
	});
});

describe('concurrency', () => {
	it('clamps to something a single GPU can survive', () => {
		expect(cfg('{"concurrency":0}').concurrency).toBe(1);
		expect(cfg('{"concurrency":99}').concurrency).toBe(8);
	});
});

describe('booleans', () => {
	it('reads a non-boolean as unset rather than as on', () => {
		expect(cfg('{"vision_judge":"yes"}').vision_judge).toBeNull();
		expect(cfg('{"use_git":1}').use_git).toBeNull();
	});

	it('round-trips both values', () => {
		expect(cfg('{"vision_judge":false}').vision_judge).toBe(false);
		expect(cfg('{"use_git":true}').use_git).toBe(true);
	});
});

describe('coding_run', () => {
	it('carries a nested object through', () => {
		expect(cfg('{"coding_run":{"plan_dir":"plan/x/"}}').coding_run).toEqual({
			plan_dir: 'plan/x/'
		});
	});

	it('degrades a malformed value to null rather than throwing', () => {
		for (const raw of ['{"coding_run":"nonsense"}', '{"coding_run":[]}', '{"coding_run":null}']) {
			expect(cfg(raw).coding_run).toBeNull();
		}
	});
});
