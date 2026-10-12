import { describe, expect, it, vi } from 'vitest';
import { invokeCalls, invokeRouter } from './invoke';

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
});
