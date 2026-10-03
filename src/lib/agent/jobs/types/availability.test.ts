import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JobTypeDefinition } from './types';

beforeEach(() => {
	vi.resetModules();
});

function def(id: string, available?: () => Promise<boolean>): JobTypeDefinition {
	return {
		id: id as JobTypeDefinition['id'],
		label: id,
		description: id,
		hasPlannedSteps: false,
		available,
		Editor: (() => {}) as unknown as JobTypeDefinition['Editor'],
		configDefaults: () => ({}),
		configFromJob: () => ({}),
		configToJson: () => null,
		planSteps: () => [],
		runPipeline: async () => {}
	};
}

async function load() {
	const registry = await import('./registry');
	const availability = await import('./availability.svelte');
	return { ...registry, ...availability };
}

describe('job type availability', () => {
	it('treats an ungated type as available without probing', async () => {
		const m = await load();
		m.registerJobType(def('research'));
		expect(m.isJobTypeAvailable('research')).toBe(true);
	});

	it('reports a gated type unavailable until its probe finishes', async () => {
		// No flash of an option that then disappears.
		const m = await load();
		m.registerJobType(def('coding', async () => true));
		expect(m.isJobTypeAvailable('coding')).toBe(false);
		await m.ensureTypeAvailabilityLoaded();
		expect(m.isJobTypeAvailable('coding')).toBe(true);
	});

	it('treats a probe that throws as unavailable', async () => {
		const m = await load();
		m.registerJobType(
			def('coding', async () => {
				throw new Error('no shell here');
			})
		);
		await m.ensureTypeAvailabilityLoaded();
		expect(m.isJobTypeAvailable('coding')).toBe(false);
	});

	it('probes once per session, however often it is asked', async () => {
		const probe = vi.fn(async () => true);
		const m = await load();
		m.registerJobType(def('coding', probe));
		await m.ensureTypeAvailabilityLoaded();
		await m.ensureTypeAvailabilityLoaded();
		expect(probe).toHaveBeenCalledTimes(1);
	});

	it('re-probes after the answer is invalidated', async () => {
		// The bug this exists for: asset generation is gated on a configured
		// image backend, which is a SETTING. A once-per-session cache answers
		// with what was true at launch, so turning a backend on left the type
		// missing from the picker until the app restarted.
		let configured = false;
		const m = await load();
		m.registerJobType(def('asset_generation', async () => configured));

		await m.ensureTypeAvailabilityLoaded();
		expect(m.isJobTypeAvailable('asset_generation')).toBe(false);

		configured = true;
		await m.ensureTypeAvailabilityLoaded();
		expect(m.isJobTypeAvailable('asset_generation')).toBe(false);

		m.invalidateTypeAvailability();
		await m.ensureTypeAvailabilityLoaded();
		expect(m.isJobTypeAvailable('asset_generation')).toBe(true);
	});

	it('reports a gated type unavailable again between invalidation and the re-probe', async () => {
		// Invalidation clears the answers rather than keeping a stale one, so
		// the picker cannot show a type whose gate has not been re-checked.
		const m = await load();
		m.registerJobType(def('asset_generation', async () => true));
		await m.ensureTypeAvailabilityLoaded();
		expect(m.isJobTypeAvailable('asset_generation')).toBe(true);

		m.invalidateTypeAvailability();
		expect(m.isJobTypeAvailable('asset_generation')).toBe(false);
	});
});
