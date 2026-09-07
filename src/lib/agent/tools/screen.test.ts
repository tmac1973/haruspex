import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: mocks.invoke
}));

// Side-effect import registers capture_screen in the shared registry.
import '$lib/agent/tools/screen';
import { normalizeTarget } from '$lib/agent/tools/screen';
import { executeTool, getToolSchemas } from '$lib/agent/tools/registry';
import { updateSettings } from '$lib/stores/settings';
import type { ToolContext } from '$lib/agent/tools/types';

function context(): ToolContext {
	return {
		workingDir: null,
		pendingImages: [],
		deepResearch: false,
		shellMode: false,
		codeMode: false,
		codeAutoApprove: false,
		filesWrittenThisTurn: new Set<string>()
	};
}

const capture = {
	dataUrl: 'data:image/jpeg;base64,AAAA',
	width: 3840,
	height: 2160
};

beforeEach(() => {
	mocks.invoke.mockReset();
	updateSettings({ screenCaptureEnabled: false });
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

describe('capture_screen', () => {
	beforeEach(() => updateSettings({ screenCaptureEnabled: true }));

	it('shows the user the same image it gives the model', async () => {
		// Not two images, one: there is no version of this where something
		// reaches the model that the person did not also get to look at.
		mocks.invoke.mockResolvedValue(capture);
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
