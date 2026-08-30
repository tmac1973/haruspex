import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('$lib/debug-log', () => ({ logDebug: vi.fn() }));

/**
 * The module keeps its reconciliation state at module scope, so every test
 * gets a fresh copy rather than inheriting the previous test's `applied`.
 */
async function freshModule() {
	vi.resetModules();
	return import('./keepAwake');
}

/** Names of the power commands invoked, in order. */
function powerCalls(): string[] {
	return mocks.invoke.mock.calls.map((c) => c[0] as string).filter((c) => c.startsWith('power_'));
}

beforeEach(() => {
	mocks.invoke.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('setKeepAwake', () => {
	it('acquires when a run starts and releases when the last one finishes', async () => {
		const { setKeepAwake } = await freshModule();

		setKeepAwake(true);
		await vi.waitFor(() => expect(powerCalls()).toEqual(['power_inhibit_acquire']));

		setKeepAwake(false);
		await vi.waitFor(() =>
			expect(powerCalls()).toEqual(['power_inhibit_acquire', 'power_inhibit_release'])
		);
	});

	it('does not touch the OS when the desired state is unchanged', async () => {
		const { setKeepAwake } = await freshModule();

		setKeepAwake(false);
		setKeepAwake(false);
		await Promise.resolve();
		expect(powerCalls()).toEqual([]);

		setKeepAwake(true);
		await vi.waitFor(() => expect(powerCalls()).toEqual(['power_inhibit_acquire']));
		setKeepAwake(true);
		setKeepAwake(true);
		await Promise.resolve();
		expect(powerCalls()).toEqual(['power_inhibit_acquire']);
	});

	it('serialises overlapping transitions and settles on the last one', async () => {
		// Hold the first acquire open so the release and re-acquire below land
		// while it is still in flight — the finish-then-drain-next case.
		let releaseFirst: () => void = () => {};
		const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
		mocks.invoke.mockImplementationOnce(async () => gate);

		const { setKeepAwake } = await freshModule();

		setKeepAwake(true);
		setKeepAwake(false);
		setKeepAwake(true);
		expect(powerCalls()).toEqual(['power_inhibit_acquire']);

		releaseFirst();
		await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
		// Desired is back to true and already applied, so nothing more is sent —
		// no stray release can arrive after the next run's acquire.
		expect(powerCalls()).toEqual(['power_inhibit_acquire']);
	});

	it('applies a transition requested while an invoke was in flight', async () => {
		let releaseFirst: () => void = () => {};
		const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
		mocks.invoke.mockImplementationOnce(async () => gate);

		const { setKeepAwake } = await freshModule();

		setKeepAwake(true);
		setKeepAwake(false);
		releaseFirst();

		await vi.waitFor(() =>
			expect(powerCalls()).toEqual(['power_inhibit_acquire', 'power_inhibit_release'])
		);
	});

	it('swallows an unavailable inhibitor, warns once, and retries next time', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		mocks.invoke.mockRejectedValue(new Error('no session bus'));

		const { setKeepAwake } = await freshModule();

		setKeepAwake(true);
		await vi.waitFor(() => expect(powerCalls()).toEqual(['power_inhibit_acquire']));
		expect(warn).toHaveBeenCalledTimes(1);

		// The failed acquire left nothing applied, so switching back off is a
		// no-op rather than a release of an inhibit that was never taken.
		setKeepAwake(false);
		await Promise.resolve();
		expect(powerCalls()).toEqual(['power_inhibit_acquire']);

		// The next run tries again — and still only warns the once.
		setKeepAwake(true);
		await vi.waitFor(() =>
			expect(powerCalls()).toEqual(['power_inhibit_acquire', 'power_inhibit_acquire'])
		);
		expect(warn).toHaveBeenCalledTimes(1);
	});
});

describe('releaseStaleInhibit', () => {
	it('releases unconditionally, so a reload cannot strand an inhibit', async () => {
		const { releaseStaleInhibit } = await freshModule();

		await releaseStaleInhibit();
		expect(powerCalls()).toEqual(['power_inhibit_release']);
	});

	it('is quiet when the command is unavailable (browser dev mode)', async () => {
		mocks.invoke.mockRejectedValue(new Error('not a tauri window'));
		const { releaseStaleInhibit } = await freshModule();

		await expect(releaseStaleInhibit()).resolves.toBeUndefined();
	});
});
