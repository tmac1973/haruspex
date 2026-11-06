import { describe, expect, it, vi } from 'vitest';
import { getApiKeyValue, getSettings, clampResponseTokens } from '#lib/stores/settings.ts';

const state = vi.hoisted(() => ({ settings: { contextSize: 4096 } as Record<string, unknown> }));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: () => state.settings,
		apiKeys: { k1: 'sekrit' }
	})
);

describe('mockSettingsModule', () => {
	it('answers getSettings from the values, read on every call', () => {
		expect(getSettings()).toEqual({ contextSize: 4096 });
		state.settings = { contextSize: 8192 };
		expect(getSettings()).toEqual({ contextSize: 8192 });
	});

	it('answers getApiKeyValue from the keys given', () => {
		expect(getApiKeyValue('k1')).toBe('sekrit');
		expect(getApiKeyValue('k2')).toBeUndefined();
		expect(getApiKeyValue(null)).toBeUndefined();
	});

	it('keeps the rest of the module real', () => {
		// The real clamp, not a stub: NaN falls back to a default, not to itself.
		expect(clampResponseTokens(NaN)).toBeGreaterThan(0);
	});
});

describe('mockSettingsModule over the defaults', () => {
	it('lays the values over the real settings', async () => {
		const { mockSettingsModule } = await import('./settings');
		const real =
			await vi.importActual<typeof import('#lib/stores/settings.ts')>('#lib/stores/settings.ts');
		const mod = await mockSettingsModule(async <T>() => real as T, {
			settings: { contextSize: 1 },
			overDefaults: true
		});
		expect(mod.getSettings().contextSize).toBe(1);
		expect(mod.getSettings().proxy).toEqual(real.getSettings().proxy);
	});
});

describe('mockSettingsModule stubs', () => {
	const real = () =>
		vi.importActual<typeof import('#lib/stores/settings.ts')>('#lib/stores/settings.ts');

	it('takes a stub that answers with only some of the fields', async () => {
		const { mockSettingsModule } = await import('./settings');
		const actual = await real();
		const mod = await mockSettingsModule(async <T>() => actual as T, {
			settings: {},
			startableMcpServers: () => [{ id: 'srv', enabled: true }]
		});
		expect(mod.startableMcpServers().map((s) => s.id)).toEqual(['srv']);
	});

	it('keeps a getSettings stub when no settings are given', async () => {
		const { mockSettingsModule } = await import('./settings');
		const actual = await real();
		const getSettings = vi.fn(() => ({ contextSize: 2 }));
		const mod = await mockSettingsModule(async <T>() => actual as T, { getSettings });
		expect(mod.getSettings().contextSize).toBe(2);
		expect(getSettings).toHaveBeenCalledOnce();
	});

	it('hands a function of the real module the real module', async () => {
		const { mockSettingsModule } = await import('./settings');
		const actual = await real();
		const mod = await mockSettingsModule(
			async <T>() => actual as T,
			(r) => ({
				getLiveSettings: () => ({ ...r.getLiveSettings(), leanMode: true })
			})
		);
		expect(mod.getLiveSettings().leanMode).toBe(true);
		expect(mod.getLiveSettings().proxy).toEqual(actual.getLiveSettings().proxy);
		expect(mod.getSettings).toBe(actual.getSettings);
	});
});
