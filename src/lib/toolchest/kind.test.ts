import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
	settings: {} as Record<string, unknown>,
	updates: [] as Record<string, unknown>[]
}));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: () => state.settings,
		updateSettings: (patch: Record<string, unknown>) => {
			state.updates.push(patch);
			Object.assign(state.settings, patch);
		}
	})
);

import { prefillFromInference, settleJob, withSavedModel } from './kind';
import { ToolchestError } from './client';

const toolchestInference = {
	mode: 'remote',
	remoteBackendKind: 'llama-toolchest',
	remoteBaseUrl: 'http://box:3000',
	remoteApiKeyId: 'k1'
};

describe('withSavedModel', () => {
	const models = [{ name: 'a', label: 'a' }];

	it('is the server’s list when the saved model is on it, or none is saved', () => {
		expect(withSavedModel('a', models)).toBe(models);
		expect(withSavedModel('  ', models)).toBe(models);
	});

	it('puts a saved model the server lacks first, saying why', () => {
		expect(withSavedModel(' b ', models)[0]).toEqual({ name: 'b', label: 'b — not on the server' });
		expect(withSavedModel('b', [])).toEqual([{ name: 'b', label: 'b — probe to check' }]);
	});
});

describe('prefillFromInference', () => {
	beforeEach(() => {
		state.updates = [];
	});

	it('fills an empty section from the inference toolchest', () => {
		state.settings = { inferenceBackend: toolchestInference, videoGenToolchestBaseUrl: '' };
		expect(prefillFromInference('video')).toEqual({ baseUrl: 'http://box:3000', apiKeyId: 'k1' });
		expect(state.updates).toEqual([
			{ videoGenToolchestBaseUrl: 'http://box:3000', videoGenToolchestApiKeyId: 'k1' }
		]);
	});

	it('leaves a section that already has an address', () => {
		state.settings = { inferenceBackend: toolchestInference, musicToolchestBaseUrl: 'http://x' };
		expect(prefillFromInference('music')).toBeNull();
		expect(state.updates).toEqual([]);
	});

	it('does nothing when inference is not a toolchest', () => {
		state.settings = {
			inferenceBackend: { ...toolchestInference, mode: 'local' },
			imageToolchestBaseUrl: ''
		};
		expect(prefillFromInference('image')).toBeNull();
		expect(state.updates).toEqual([]);
	});
});

describe('settleJob', () => {
	it('passes a succeeded job through', () => {
		const job = { id: 'j', status: 'succeeded' as const, error: null };
		expect(settleJob(job)).toBe(job);
	});

	it('throws a cancelled error for a cancelled job', () => {
		expect(() => settleJob({ id: 'j', status: 'cancelled', error: null })).toThrow(
			expect.objectContaining({ kind: 'cancelled' })
		);
	});

	it('throws toolchest’s reason for a failed job', () => {
		let thrown: unknown;
		try {
			settleJob({ id: 'j', status: 'failed', error: 'out of memory' });
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toBeInstanceOf(ToolchestError);
		expect(thrown).toMatchObject({ kind: 'rejected', message: 'llama-toolchest: out of memory' });
	});
});
