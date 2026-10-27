/**
 * A stand-in for `#lib/stores/settings.ts`, for code that only reads
 * settings. Not shipped: only test files import this. Load it inside the mock
 * factory, which vitest hoists above every import:
 *
 *   const settings = vi.hoisted(() => ({ imageToolchestBaseUrl: 'http://box:3000' }));
 *   vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
 *     (await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
 *       settings,
 *       apiKeys: { k1: 'sekrit' }
 *     })
 *   );
 *
 * The rest of the module is the real one.
 */
import type * as SettingsModule from '#lib/stores/settings.ts';

type Values = Record<string, unknown>;

export interface SettingsMock extends Partial<typeof SettingsModule> {
	/** What `getSettings` returns, read on every call so a test can change it. */
	settings: Values | (() => Values);
	/** Laid over the real defaults instead of standing alone. */
	overDefaults?: boolean;
	/** `getApiKeyValue`'s answers by key id; any other id has no value. */
	apiKeys?: Record<string, string>;
}

export async function mockSettingsModule(
	importOriginal: <T>() => Promise<T>,
	{ settings, overDefaults = false, apiKeys, ...overrides }: SettingsMock
): Promise<typeof SettingsModule> {
	const real = await importOriginal<typeof SettingsModule>();
	const values = () => (typeof settings === 'function' ? settings() : settings);
	return {
		...real,
		getSettings: (overDefaults
			? () => ({ ...real.getSettings(), ...values() })
			: values) as typeof real.getSettings,
		...(apiKeys && {
			getApiKeyValue: (id: string | null | undefined) => (id ? apiKeys[id] : undefined)
		}),
		...overrides
	};
}
