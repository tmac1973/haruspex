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
		expect(typeof clampResponseTokens).toBe('function');
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
