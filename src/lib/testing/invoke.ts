/**
 * Test helpers for code that calls Tauri's `invoke`. Not shipped: only test
 * files import this.
 *
 *   vi.mock('@tauri-apps/api/core', async () =>
 *     (await import('#lib/testing/invoke.ts')).mockTauriCore({ secret_available: true })
 *   );
 *
 * or, with the mock in a hoisted object the test drives:
 *
 *   const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
 *   vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
 *   tauri.invoke.mockImplementation(
 *     invokeRouter({ secret_available: true, secret_set: () => { throw 'locked'; } })
 *   );
 */
import type { InvokeArgs } from '@tauri-apps/api/core';
import { vi, type Mock } from 'vitest';

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

/**
 * A stand-in for `@tauri-apps/api/core`, for a `vi.mock` factory: `invoke` is
 * a `vi.fn` answering through `invokeRouter(routes, fallback)`, so a command
 * with no route resolves to null, and `isTauri` says yes. A test that drives
 * the mock imports `invoke` and takes `vi.mocked(invoke)`; `mockReset` puts
 * the routes back.
 */
export function mockTauriCore(
	routes: Record<string, InvokeRoute> = {},
	...fallback: [InvokeFallback?]
) {
	return { invoke: vi.fn(invokeRouter(routes, ...fallback)), isTauri: () => true };
}

/** For a router's fallback: fail the test on any command it didn't expect. */
export function unexpectedInvoke(cmd: string): never {
	throw new Error(`unexpected invoke: ${cmd}`);
}

/**
 * The args of every call `invoke` received for `cmd`, in order, read as `A`:
 * the shape the command takes. Tauri types them loosely (`InvokeArgs`, which
 * includes `number[]`), so through `vi.mocked(invoke)` every read would need
 * a cast; the test knows the command, so it names the shape once here.
 */
export function invokeCalls<A = Record<string, unknown>>(invoke: Mock, cmd: string): A[] {
	return invoke.mock.calls.filter((c) => c[0] === cmd).map((c) => c[1] as A);
}

/**
 * The args of one call to `cmd`, read as `A`: the first by default, and `at`
 * counts from the end when negative (-1 is the latest). Throws when there is
 * no such call, so a test fails on the missing call, not on reading its args.
 */
export function invokeArgs<A = Record<string, unknown>>(invoke: Mock, cmd: string, at = 0): A {
	const calls = invokeCalls<A>(invoke, cmd);
	if (at >= calls.length || -at > calls.length) {
		throw new Error(`no invoke of ${cmd} at ${at} (${calls.length} made)`);
	}
	return calls.at(at) as A;
}

/**
 * The args of every call, of any command, in order, read as `A`. For a test
 * that checks the commands' order itself and then reads one call by index.
 */
export function allInvokeArgs<A = Record<string, unknown>>(invoke: Mock): A[] {
	return invoke.mock.calls.map((c) => c[1] as A);
}

/**
 * A route that reads its args as `A`, for `invokeRouter` or `mockTauriCore`:
 *
 *   mockTauriCore({ task_update: withArgs<{ id: string }>((args) => args.id) })
 */
export function withArgs<A>(route: (args: A) => unknown): (args: Args) => unknown {
	return route as (args: Args) => unknown;
}

/**
 * An `invoke` implementation from one function of the command and its args
 * (read as `A`), typed like Tauri's own, for
 * `vi.mocked(invoke).mockImplementation(...)`. It answers through
 * `invokeRouter`, so it is async like the real one.
 */
export function invokeHandler<A = Record<string, unknown>>(
	handle: (cmd: string, args: A) => unknown
): <T = unknown>(cmd: string, args?: InvokeArgs) => Promise<T> {
	return invokeRouter({}, handle as (cmd: string, args: Args) => unknown);
}

/** An HTTP request a backend hands to Rust as `invoke(cmd, { call })`. */
export interface HttpCall {
	method: string;
	path: string;
	body: Record<string, unknown> | null;
}

/** A server's answer to one request: a value, or a function of the call (which
 *  may throw, to stand in for an error status). */
export type HttpAnswer<C extends HttpCall = HttpCall> = unknown | ((call: C) => unknown);

/**
 * An `invokeRouter` route for a command that carries an HTTP call
 * (`toolchest_json`, `lemonade_json`, `ace_json` …), answering by
 * `"METHOD path"` — the query string included:
 *
 *   invokeRouter({ toolchest_json: httpRouter({ 'GET /v1/models': models }) })
 *
 * A request with no answer is refused the way the Rust side reports a 404:
 * `{ kind: 'rejected', status: 404, body: notFoundBody }`.
 */
export function httpRouter<C extends HttpCall = HttpCall>(
	answers: Record<string, HttpAnswer<C>>,
	notFoundBody = '{}'
): (args: Args) => unknown {
	return (args) => {
		const call = (args as { call: C }).call;
		const answer = answers[`${call.method} ${call.path}`];
		if (answer === undefined) throw { kind: 'rejected', status: 404, body: notFoundBody };
		return typeof answer === 'function' ? (answer as (c: C) => unknown)(call) : answer;
	};
}

/** The HTTP calls `invoke` sent through `cmds`, in order. */
export function httpCalls<C extends HttpCall = HttpCall>(invoke: Mock, ...cmds: string[]): C[] {
	return invoke.mock.calls
		.filter((c) => cmds.includes(c[0] as string))
		.map((c) => (c[1] as { call: C }).call);
}
