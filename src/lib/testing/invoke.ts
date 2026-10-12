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
import type { InvokeArgs } from '@tauri-apps/api/core';
import type { Mock } from 'vitest';

/** What a route sees: the command's named args. Commands that take raw bytes
 *  (`number[]`, `ArrayBuffer`) are routed by value, not inspected. */
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

/** The answer for a command with no route: a value, or a function of the
 *  command (which may throw — "unexpected invoke: x"). */
export type InvokeFallback = ((cmd: string, args: Args) => unknown) | unknown;

/**
 * An `invoke` implementation that answers by command name, typed like Tauri's
 * own so it drops into `vi.mocked(invoke).mockImplementation(...)` without a
 * cast. Commands with no route resolve to `fallback` — null when it is left
 * out, as most Rust commands that return nothing do. Passing `undefined`
 * explicitly answers `undefined`.
 */
export function invokeRouter(
	routes: Record<string, InvokeRoute>,
	...fallback: [InvokeFallback?]
): <T = unknown>(cmd: string, args?: InvokeArgs) => Promise<T> {
	const unrouted = fallback.length > 0 ? fallback[0] : null;
	return async <T>(cmd: string, invokeArgs?: InvokeArgs): Promise<T> => {
		const args = invokeArgs as Args;
		if (!Object.hasOwn(routes, cmd)) {
			return (typeof unrouted === 'function' ? unrouted(cmd, args) : unrouted) as T;
		}
		const route = routes[cmd];
		return (typeof route === 'function' ? route(args) : route) as T;
	};
}

/** For a router's fallback: fail the test on any command it didn't expect. */
export function unexpectedInvoke(cmd: string): never {
	throw new Error(`unexpected invoke: ${cmd}`);
}

/** The args of every call `invoke` received for `cmd`, in order. */
export function invokeCalls(invoke: Mock, cmd: string): Args[] {
	return invoke.mock.calls.filter((c) => c[0] === cmd).map((c) => c[1] as Args);
}
