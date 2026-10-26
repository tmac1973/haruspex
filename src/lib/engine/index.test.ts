import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	listen: vi.fn(),
	unlisten: vi.fn(),
	watchPrompts: vi.fn(),
	enabled: false
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'code-1' }) }));
vi.mock('#lib/engine/dispatch.ts', () => ({
	dispatch: vi.fn(),
	MAIN_WINDOW: 'main',
	setChatResync: vi.fn(),
	setResync: vi.fn()
}));
vi.mock('#lib/engine/prompts.svelte.ts', () => ({ watchPrompts: mocks.watchPrompts }));
vi.mock('#lib/engine/watch.svelte.ts', () => ({ watchOpenSessions: () => ({ resync: vi.fn() }) }));
vi.mock('#lib/debug-log.ts', () => ({ logDebug: vi.fn() }));

type Handler = (e: { payload: boolean }) => void;

/** `startEngine` fresh, since whether it has started is kept per module. */
async function startEngine() {
	vi.resetModules();
	return (await import('./index')).startEngine();
}

/** Lets the engine's own `.then` run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
	mocks.enabled = false;
	mocks.unlisten.mockReset();
	mocks.watchPrompts.mockReset();
	mocks.invoke.mockReset().mockImplementation(async (cmd: string) => {
		if (cmd === 'engine_enabled') return mocks.enabled;
		return null;
	});
	mocks.listen.mockReset().mockImplementation(async () => mocks.unlisten);
});

describe('startEngine', () => {
	it('starts at once when Rust has it on, and stops listening for the switch', async () => {
		mocks.enabled = true;
		await startEngine();
		expect(mocks.watchPrompts).toHaveBeenCalledTimes(1);
		expect(mocks.unlisten).toHaveBeenCalledTimes(1);
	});

	it('starts when switched on later, then stops listening', async () => {
		let handler: Handler | null = null;
		mocks.listen.mockImplementation(async (event: string, h: Handler) => {
			if (event === 'engine://enabled') handler = h;
			return mocks.unlisten;
		});
		await startEngine();
		expect(mocks.watchPrompts).not.toHaveBeenCalled();
		handler!({ payload: true });
		await settle();
		expect(mocks.watchPrompts).toHaveBeenCalledTimes(1);
		expect(mocks.unlisten).toHaveBeenCalledTimes(1);
	});

	it('handles a switch-on that arrives before listen resolves', async () => {
		// Tauri can deliver the event while `listen` is still on its way back.
		mocks.listen.mockImplementation(async (event: string, h: Handler) => {
			if (event === 'engine://enabled') h({ payload: true });
			return mocks.unlisten;
		});
		await expect(startEngine()).resolves.toBeUndefined();
		await settle();
		expect(mocks.watchPrompts).toHaveBeenCalledTimes(1);
		// Removed once, though both the early start and startEngine reach for it.
		expect(mocks.unlisten).toHaveBeenCalledTimes(1);
		expect(mocks.invoke).not.toHaveBeenCalledWith('engine_enabled');
	});
});
