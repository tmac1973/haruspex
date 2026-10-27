import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	calls: [] as string[]
}));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: mocks.invoke
}));
vi.mock('@tauri-apps/api/window', () => ({
	getCurrentWindow: () => ({
		hide: async () => void mocks.calls.push('hide'),
		show: async () => void mocks.calls.push('show'),
		setFocus: async () => void mocks.calls.push('focus')
	})
}));

// Side-effect import registers capture_screen in the shared registry.
import '#lib/agent/tools/screen.ts';
import { normalizeTarget } from '#lib/agent/tools/screen.ts';
import { executeTool, getToolSchemas } from '#lib/agent/tools/registry.ts';
import { updateSettings } from '#lib/stores/settings.ts';
import {
	getPendingScreenCapture,
	resolveScreenCapture
} from '#lib/stores/screenCaptureApproval.svelte.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';

const context = () => makeToolContext();

const capture = {
	dataUrl: 'data:image/jpeg;base64,AAAA',
	width: 3840,
	height: 2160,
	target: 'screen'
};

beforeEach(() => {
	mocks.invoke.mockReset();
	mocks.invoke.mockImplementation(async () => {
		mocks.calls.push('capture');
		return capture;
	});
	mocks.calls.length = 0;
	updateSettings({ screenCaptureEnabled: false, screenCaptureConfirm: true });
});

describe('the consent gate', () => {
	it('hides the tool while the toggle is off', () => {
		const names = getToolSchemas({ hasWorkingDir: false }).map((s) => s.function.name);
		expect(names).not.toContain('capture_screen');
	});

	it('offers it once the toggle is on', () => {
		updateSettings({ screenCaptureEnabled: true });
		const names = getToolSchemas({ hasWorkingDir: false }).map((s) => s.function.name);
		expect(names).toContain('capture_screen');
	});

	it('refuses execution while the toggle is off, even if the model calls it anyway', async () => {
		// This is the check that matters. executeTool resolves names against
		// the full registry, so schema filtering alone would leave the user's
		// decision enforced only by the model's good behaviour.
		const out = await executeTool('capture_screen', {}, context());
		expect(JSON.parse(out.result).error).toContain('Settings → Screen');
		expect(mocks.invoke).not.toHaveBeenCalled();
	});

	it('is hidden from a backend that cannot see images', () => {
		updateSettings({ screenCaptureEnabled: true });
		const names = getToolSchemas({ hasWorkingDir: false, visionSupported: false }).map(
			(s) => s.function.name
		);
		expect(names).not.toContain('capture_screen');
	});
});

describe('the prompt before each screenshot', () => {
	beforeEach(() => updateSettings({ screenCaptureEnabled: true }));

	/** Run a capture with someone there, and wait for its prompt to show. */
	async function asked(target?: string) {
		const ctx = makeToolContext({ interactive: true });
		const out = executeTool('capture_screen', target ? { target } : {}, ctx);
		await vi.waitFor(() => expect(getPendingScreenCapture()).not.toBeNull());
		return { ctx, out };
	}

	it('captures only after the user says yes', async () => {
		const { ctx, out } = await asked('window');
		expect(getPendingScreenCapture()).toEqual({ target: 'window', chatId: null, sessionId: null });
		expect(mocks.invoke).not.toHaveBeenCalled();

		resolveScreenCapture('allow');
		await out;

		expect(mocks.invoke).toHaveBeenCalledWith('capture_screen', { target: 'window' });
		expect(ctx.pendingImages).toHaveLength(1);
	});

	it('captures nothing when the user says no', async () => {
		const { ctx, out } = await asked();
		resolveScreenCapture('deny');
		const result = await out;

		expect(result.result).toContain('declined');
		expect(mocks.invoke).not.toHaveBeenCalled();
		expect(ctx.pendingImages).toHaveLength(0);
	});

	it('refuses when nobody is there to answer', async () => {
		const out = await executeTool('capture_screen', {}, makeToolContext({ interactive: false }));
		expect(JSON.parse(out.result).error).toContain('Settings → Screen');
		expect(mocks.invoke).not.toHaveBeenCalled();
	});

	it('does not ask once the user turned it off', async () => {
		updateSettings({ screenCaptureConfirm: false });
		await executeTool('capture_screen', {}, makeToolContext({ interactive: true }));
		expect(getPendingScreenCapture()).toBeNull();
		expect(mocks.invoke).toHaveBeenCalledOnce();
	});
});

describe('capture_screen', () => {
	beforeEach(() => updateSettings({ screenCaptureEnabled: true, screenCaptureConfirm: false }));

	it('hides Haruspex while it captures, like the camera button', async () => {
		await executeTool('capture_screen', {}, context());
		expect(mocks.calls).toEqual(['hide', 'capture', 'show', 'focus']);
	});

	it('says so when a window was asked for and the whole screen came back', async () => {
		const out = await executeTool('capture_screen', { target: 'window' }, context());
		expect(out.result).toContain('Captured the screen');
		expect(out.result).toContain('whole screen');
	});

	it('shows the user the same image it gives the model', async () => {
		// Not two images, one: there is no version of this where something
		// reaches the model that the person did not also get to look at.
		const ctx = context();

		const out = await executeTool('capture_screen', {}, ctx);

		expect(mocks.invoke).toHaveBeenCalledWith('capture_screen', { target: 'screen' });
		expect(ctx.pendingImages).toHaveLength(1);
		expect(ctx.pendingImages[0].dataUrl).toBe(capture.dataUrl);
		expect(out.thumbDataUrl).toBe(capture.dataUrl);
	});

	it('tells the model the display size it captured', async () => {
		mocks.invoke.mockResolvedValue(capture);
		const out = await executeTool('capture_screen', {}, context());
		expect(out.result).toContain('3840x2160');
	});

	it('passes the window target through', async () => {
		mocks.invoke.mockResolvedValue(capture);
		await executeTool('capture_screen', { target: 'window' }, context());
		expect(mocks.invoke).toHaveBeenCalledWith('capture_screen', { target: 'window' });
	});

	it('relays the backend message rather than flattening it', async () => {
		// "The screenshot was cancelled" and "grant Screen Recording" are the
		// two things a user needs to read; "capture failed" is neither.
		mocks.invoke.mockRejectedValue('The screenshot was cancelled.');
		const out = await executeTool('capture_screen', {}, context());
		expect(JSON.parse(out.result).error).toContain('cancelled');
	});

	it('refuses to pile on more images than the context can hold', async () => {
		const ctx = context();
		ctx.pendingImages = Array.from({ length: 6 }, (_, i) => ({
			path: `${i}`,
			dataUrl: 'data:image/jpeg;base64,AA'
		}));

		const out = await executeTool('capture_screen', {}, ctx);

		expect(JSON.parse(out.result).error).toContain('Too many images');
		expect(mocks.invoke).not.toHaveBeenCalled();
	});
});

describe('normalizeTarget', () => {
	it('accepts the words the schema lists', () => {
		expect(normalizeTarget('screen')).toBe('screen');
		expect(normalizeTarget('window')).toBe('window');
	});

	it('accepts the words a model actually writes', () => {
		// Spending a turn correcting a model's spelling of "active window" is
		// a worse outcome than understanding it.
		expect(normalizeTarget('active window')).toBe('window');
		expect(normalizeTarget('The Current Window')).toBe('window');
		expect(normalizeTarget('fullscreen')).toBe('screen');
	});

	it('falls back to the whole screen when nothing was said', () => {
		expect(normalizeTarget(undefined)).toBe('screen');
		expect(normalizeTarget('')).toBe('screen');
		expect(normalizeTarget('nonsense')).toBe('screen');
	});
});
