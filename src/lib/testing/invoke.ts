/**
 * Test helpers for code that calls Tauri's `invoke`. Not shipped: only test
 * files import this.
 *
 *   const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
 *   vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
 *   tauri.invoke.mockImplementation(
 *     invokeRouter({ secret_available: true, secret_set: () => { throw 'locked'; } })
 *   );
 */
import type { Mock } from 'vitest';

type Args = Record<string, unknown> | undefined;

/** A route's answer: a function of the args (which may throw, to stand in for
 *  a failing command), or any other value, returned as is. */
export type InvokeRoute =
	| ((args: Args) => unknown)
	| string
	| number
	| boolean
	| null
	| undefined
	| readonly unknown[]
	| Record<string, unknown>;

/**
 * An `invoke` implementation that answers by command name. Commands with no
 * route resolve to `fallback` (null by default), as most Rust commands that
 * return nothing do.
 */
export function invokeRouter(
	routes: Record<string, InvokeRoute>,
	fallback: unknown = null
): (cmd: string, args?: Args) => Promise<unknown> {
	return async (cmd, args) => {
		if (!Object.hasOwn(routes, cmd)) return fallback;
		const route = routes[cmd];
		return typeof route === 'function' ? route(args) : route;
	};
}

/** The args of every call `invoke` received for `cmd`, in order. */
export function invokeCalls(invoke: Mock, cmd: string): Args[] {
	return invoke.mock.calls.filter((c) => c[0] === cmd).map((c) => c[1] as Args);
}
