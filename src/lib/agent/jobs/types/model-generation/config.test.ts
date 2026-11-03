import { describe, it, expect } from 'vitest';
import {
	parseModelGenerationConfig,
	resolveModelsSpecPath,
	DEFAULT_ROUNDS,
	DEFAULT_STAGE_TURNS,
	MAX_ROUNDS,
	MAX_STAGE_TURNS,
	MIN_ROUNDS,
	MIN_STAGE_TURNS
} from './config';
import { DEFAULT_MODELS_SPEC_PATH } from '#lib/models3d/spec/paths.ts';

const cfg = (json: string | null) => parseModelGenerationConfig(json);

const remote = {
	model_remote_base_url: 'http://argon',
	model_remote_api_key: null,
	model_remote_api_key_id: 'key-argon',
	model_remote_model_id: 'argon-4',
	model_remote_context_size: 131072,
	model_remote_vision_supported: true,
	model_advanced: null
};

describe('parseModelGenerationConfig', () => {
	it('gives the defaults for no config', () => {
		expect(cfg(null)).toEqual({
			spec_path: null,
			description: null,
			run_mode: 'attended',
			create_model: null,
			animate_model: null,
			allow_textures: false,
			create_turns: DEFAULT_STAGE_TURNS,
			animate_turns: DEFAULT_STAGE_TURNS,
			rounds: DEFAULT_ROUNDS,
			use_git: true
		});
	});

	it('behaves like no config when the JSON is malformed', () => {
		expect(cfg('{ not json')).toEqual(cfg(null));
		expect(cfg('[1, 2]')).toEqual(cfg(null));
	});

	it('reads an unrecognised run mode as attended', () => {
		expect(cfg('{"run_mode": "unattended"}').run_mode).toBe('unattended');
		expect(cfg('{"run_mode": "overnight"}').run_mode).toBe('attended');
		expect(cfg('{"run_mode": 1}').run_mode).toBe('attended');
	});

	it('clamps the limits and rounds them to whole numbers', () => {
		const low = cfg('{"create_turns": 1, "animate_turns": -5, "rounds": 0}');
		expect([low.create_turns, low.animate_turns, low.rounds]).toEqual([
			MIN_STAGE_TURNS,
			MIN_STAGE_TURNS,
			MIN_ROUNDS
		]);
		const high = cfg('{"create_turns": 900, "animate_turns": 500, "rounds": 40}');
		expect([high.create_turns, high.animate_turns, high.rounds]).toEqual([
			MAX_STAGE_TURNS,
			MAX_STAGE_TURNS,
			MAX_ROUNDS
		]);
		expect(cfg('{"rounds": 2.6}').rounds).toBe(3);
		expect(cfg('{"rounds": "4"}').rounds).toBe(DEFAULT_ROUNDS);
	});

	it('turns textures on only for an explicit true, and git off only for an explicit false', () => {
		expect(cfg('{"allow_textures": "yes"}').allow_textures).toBe(false);
		expect(cfg('{"allow_textures": true}').allow_textures).toBe(true);
		expect(cfg('{"use_git": 0}').use_git).toBe(true);
		expect(cfg('{"use_git": false}').use_git).toBe(false);
	});

	it('reads each stage model whole, and a half-filled one as the job’s', () => {
		const c = cfg(
			JSON.stringify({
				create_model: remote,
				animate_model: { model_remote_base_url: 'http://x' }
			})
		);
		expect(c.create_model).toEqual(remote);
		expect(c.animate_model).toBeNull();
	});

	it('reads a null URL as the Settings model', () => {
		const c = cfg(JSON.stringify({ animate_model: { model_remote_base_url: null } }));
		expect(c.animate_model?.model_remote_base_url).toBeNull();
		expect(c.animate_model).not.toBeNull();
	});

	it('treats a blank spec path or description as unset', () => {
		const c = cfg('{"spec_path": "  ", "description": " "}');
		expect(c.spec_path).toBeNull();
		expect(c.description).toBeNull();
		expect(resolveModelsSpecPath(c)).toBe(DEFAULT_MODELS_SPEC_PATH);
		expect(resolveModelsSpecPath(cfg('{"spec_path": " plan/x/models.json "}'))).toBe(
			'plan/x/models.json'
		);
	});
});
