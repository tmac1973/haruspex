import { describe, expect, it, vi } from 'vitest';
import {
	httpCalls,
	httpRouter,
	allInvokeArgs,
	invokeArgs,
	invokeCalls,
	invokeHandler,
	invokeRouter,
	unexpectedInvoke,
	withArgs,
	type HttpCall
} from './invoke';

describe('invokeRouter', () => {
	it('returns a routed value', async () => {
		const invoke = invokeRouter({ secret_available: true });
		await expect(invoke('secret_available')).resolves.toBe(true);
	});

	it('calls a routed function with the args', async () => {
		const invoke = invokeRouter({ echo: (args) => args?.value });
		await expect(invoke('echo', { value: 7 })).resolves.toBe(7);
	});

	it('rejects when a routed function throws', async () => {
		const invoke = invokeRouter({
			secret_set: () => {
				throw 'locked';
			}
		});
		await expect(invoke('secret_set')).rejects.toBe('locked');
	});

	it('answers unrouted commands with the fallback', async () => {
		await expect(invokeRouter({})('anything')).resolves.toBeNull();
		await expect(invokeRouter({}, 'x')('anything')).resolves.toBe('x');
	});

	it('answers undefined when undefined is the fallback', async () => {
		await expect(invokeRouter({}, undefined)('anything')).resolves.toBeUndefined();
	});

	it('calls a function fallback with the command, which may throw', async () => {
		await expect(invokeRouter({}, (cmd: string) => `no ${cmd}`)('x')).resolves.toBe('no x');
		await expect(invokeRouter({}, unexpectedInvoke)('shell_kill')).rejects.toThrow(
			'unexpected invoke: shell_kill'
		);
	});

	it('does not route inherited keys', async () => {
		await expect(invokeRouter({})('toString')).resolves.toBeNull();
	});
});

describe('invokeCalls', () => {
	it('lists the args of matching calls only', async () => {
		const invoke = vi.fn(invokeRouter({}));
		await invoke('a', { n: 1 });
		await invoke('b', { n: 2 });
		await invoke('a', { n: 3 });
		expect(invokeCalls(invoke, 'a')).toEqual([{ n: 1 }, { n: 3 }]);
	});

	it('reads the args as the shape the test names', async () => {
		const invoke = vi.fn(invokeRouter({}));
		await invoke('a', { n: 1 });
		const [first] = invokeCalls<{ n: number }>(invoke, 'a');
		expect(first.n + 1).toBe(2);
	});
});

describe('invokeArgs', () => {
	it('picks one call to the command, counting from the end when negative', async () => {
		const invoke = vi.fn(invokeRouter({}));
		await invoke('a', { n: 1 });
		await invoke('b', { n: 2 });
		await invoke('a', { n: 3 });
		expect(invokeArgs<{ n: number }>(invoke, 'a').n).toBe(1);
		expect(invokeArgs(invoke, 'a', 1)).toEqual({ n: 3 });
		expect(invokeArgs(invoke, 'a', -1)).toEqual({ n: 3 });
		expect(invokeArgs(invoke, 'a', -2)).toEqual({ n: 1 });
	});

	it('throws when there is no such call', async () => {
		const invoke = vi.fn(invokeRouter({}));
		await invoke('a', { n: 1 });
		expect(() => invokeArgs(invoke, 'b')).toThrow('no invoke of b at 0 (0 made)');
		expect(() => invokeArgs(invoke, 'a', 1)).toThrow('no invoke of a at 1 (1 made)');
		expect(() => invokeArgs(invoke, 'a', -2)).toThrow('no invoke of a at -2 (1 made)');
	});
});

describe('allInvokeArgs', () => {
	it('lists the args of every call, whatever the command', async () => {
		const invoke = vi.fn(invokeRouter({}));
		await invoke('a', { n: 1 });
		await invoke('b');
		expect(allInvokeArgs<{ n: number }>(invoke)).toEqual([{ n: 1 }, undefined]);
	});
});

describe('withArgs', () => {
	it('hands the route its args as the named shape', async () => {
		const invoke = invokeRouter({ task_update: withArgs<{ id: string }>((args) => `#${args.id}`) });
		await expect(invoke('task_update', { id: 't1' })).resolves.toBe('#t1');
	});
});

describe('invokeHandler', () => {
	it('answers every command through one function of the command and args', async () => {
		const invoke = vi.fn(invokeHandler<{ n: number }>((cmd, args) => `${cmd}:${args.n}`));
		await expect(invoke('a', { n: 1 })).resolves.toBe('a:1');
	});

	it('rejects when the function throws', async () => {
		const invoke = invokeHandler(() => {
			throw 'locked';
		});
		await expect(invoke('secret_set')).rejects.toBe('locked');
	});
});

describe('httpRouter', () => {
	const call = (method: string, path: string, body: Record<string, unknown> | null = null) => ({
		call: { method, path, body }
	});

	it('answers by method and path', () => {
		const route = httpRouter({ 'GET /v1/models': { data: [] }, 'POST /v1/models': 'made' });
		expect(route(call('GET', '/v1/models'))).toEqual({ data: [] });
		expect(route(call('POST', '/v1/models'))).toBe('made');
	});

	it('hands a function answer the call', () => {
		const route = httpRouter({ 'POST /jobs': (c: HttpCall) => c.body?.prompt });
		expect(route(call('POST', '/jobs', { prompt: 'a fox' }))).toBe('a fox');
	});

	it('refuses an unanswered request as a 404', () => {
		const route = httpRouter({ 'GET /a': 1 });
		expect(() => route(call('POST', '/a'))).toThrow(
			expect.objectContaining({ kind: 'rejected', status: 404, body: '{}' })
		);
		expect(() => httpRouter({}, '{"error":"nope"}')(call('GET', '/b'))).toThrow(
			expect.objectContaining({ body: '{"error":"nope"}' })
		);
	});

	it('works as an invokeRouter route, and httpCalls lists what was sent', async () => {
		const invoke = vi.fn(
			invokeRouter({ srv_json: httpRouter({ 'GET /a': 1 }), other: httpRouter({ 'GET /b': 2 }) })
		);
		await invoke('srv_json', call('GET', '/a'));
		await invoke('other', call('GET', '/b'));
		expect(httpCalls(invoke, 'srv_json').map((c) => `${c.method} ${c.path}`)).toEqual(['GET /a']);
		expect(httpCalls(invoke, 'srv_json', 'other')).toHaveLength(2);
	});
});
