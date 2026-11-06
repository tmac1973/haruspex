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
 * The rest of the module is the real one. Any other export can be stubbed
 * too, and a stubbed function may answer with only the fields the code under
 * test reads (`startableMcpServers: () => [{ id: 'srv', enabled: true }]`).
 * When a stub needs the real module, pass a function of it instead:
 *
 *   mockSettingsModule(importOriginal, (real) => ({
 *     getLiveSettings: () => ({ ...real.getLiveSettings(), leanMode: true })
 *   }))
 */
import type * as SettingsModule from '#lib/stores/settings.ts';

type Values = Record<string, unknown>;
type Module = typeof SettingsModule;

/** `T` with every field optional, all the way down. Functions stay whole. */
export type DeepPartial<T> = T extends (...args: never[]) => unknown
	? T
	: T extends readonly (infer E)[]
		? DeepPartial<E>[]
		: T extends object
			? { [K in keyof T]?: DeepPartial<T[K]> }
			: T;

/** A stand-in for one export: a function may answer with a partial of what
 *  the real one returns (or resolves to). */
type Stub<F> = F extends (...args: infer A) => infer R
	? (...args: A) => R extends Promise<infer U> ? Promise<DeepPartial<U>> : DeepPartial<R>
	: F;

export type SettingsStubs = { [K in keyof Module]?: Stub<Module[K]> };

export type SettingsMock = SettingsStubs & {
	/** What `getSettings` returns, read on every call so a test can change it.
	 *  Left out, `getSettings` is the real one, or the stub passed for it. */
	settings?: Values | (() => Values);
	/** Laid over the real defaults instead of standing alone. */
	overDefaults?: boolean;
	/** `getApiKeyValue`'s answers by key id; any other id has no value. */
	apiKeys?: Record<string, string>;
};

export async function mockSettingsModule(
	importOriginal: <T>() => Promise<T>,
	mock: SettingsMock | ((real: Module) => SettingsMock)
): Promise<Module> {
	const real = await importOriginal<Module>();
	const {
		settings,
		overDefaults = false,
		apiKeys,
		...stubs
	} = typeof mock === 'function' ? mock(real) : mock;
	const values = () => (typeof settings === 'function' ? settings() : (settings ?? {}));
	return {
		...real,
		...(settings !== undefined && {
			getSettings: (overDefaults
				? () => ({ ...real.getSettings(), ...values() })
				: values) as Module['getSettings']
		}),
		...(apiKeys && {
			getApiKeyValue: (id: string | null | undefined) => (id ? apiKeys[id] : undefined)
		}),
		...(stubs as Partial<Module>)
	};
}
