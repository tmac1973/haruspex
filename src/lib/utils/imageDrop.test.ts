import { beforeEach, describe, expect, it, vi } from 'vitest';

type DragEvent = { payload: Record<string, unknown> };

const m = vi.hoisted(() => ({
	handler: null as ((e: DragEvent) => void) | null,
	unlisten: vi.fn(),
	toast: vi.fn()
}));

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore({
		read_dropped_image: (a) => {
			if (String(a?.path).includes('broken')) throw new Error('not an image');
			return `data:image/png;base64,${String(a?.path)}`;
		}
	})
);
vi.mock('@tauri-apps/api/webview', () => ({
	getCurrentWebview: () => ({
		onDragDropEvent: async (h: (e: DragEvent) => void) => {
			m.handler = h;
			return m.unlisten;
		}
	})
}));
vi.mock('#lib/stores/toasts.svelte.ts', () => ({ showToast: m.toast }));

import { imageDropTarget, type ImageDropOptions } from './imageDrop.ts';

/** A node at x 100–300, y 50–150 in CSS pixels. */
function node(): HTMLElement {
	const el = document.createElement('div');
	el.getBoundingClientRect = () => ({ left: 100, right: 300, top: 50, bottom: 150 }) as DOMRect;
	return el;
}

const inside = { x: 200, y: 100 };
const outside = { x: 20, y: 20 };

function fire(payload: Record<string, unknown>) {
	m.handler!({ payload });
}

async function mount(opts: Partial<ImageDropOptions> = {}) {
	const full: ImageDropOptions = { onImages: vi.fn(), onDragChange: vi.fn(), ...opts };
	const action = imageDropTarget(node(), full);
	await vi.waitFor(() => expect(m.handler).not.toBeNull());
	return { opts: full, action };
}

beforeEach(() => {
	m.handler = null;
	m.unlisten.mockReset();
	m.toast.mockReset();
	window.devicePixelRatio = 1;
});

describe('imageDropTarget', () => {
	it('lights up only while a drag is over its own node', async () => {
		const { opts } = await mount();
		fire({ type: 'over', position: inside });
		fire({ type: 'over', position: outside });
		fire({ type: 'leave' });
		expect(vi.mocked(opts.onDragChange!).mock.calls).toEqual([[true], [false], [false]]);
	});

	it('reads native positions as physical pixels', async () => {
		window.devicePixelRatio = 2;
		const { opts } = await mount();
		// 400,200 physical is 200,100 in CSS pixels: inside.
		fire({ type: 'over', position: { x: 400, y: 200 } });
		expect(opts.onDragChange).toHaveBeenLastCalledWith(true);
	});

	it('attaches the pictures dropped on it, read and resized by Rust', async () => {
		const { opts } = await mount();
		fire({ type: 'drop', position: inside, paths: ['/a/cat.PNG', '/a/notes.txt', '/a/b.webp'] });
		await vi.waitFor(() => expect(opts.onImages).toHaveBeenCalled());
		expect(opts.onImages).toHaveBeenCalledWith([
			'data:image/png;base64,/a/cat.PNG',
			'data:image/png;base64,/a/b.webp'
		]);
		expect(opts.onDragChange).toHaveBeenLastCalledWith(false);
	});

	it('ignores a drop on another composer', async () => {
		const { opts } = await mount();
		fire({ type: 'drop', position: outside, paths: ['/a/cat.png'] });
		await Promise.resolve();
		expect(opts.onImages).not.toHaveBeenCalled();
	});

	it('skips a picture that will not read, and keeps the rest', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { opts } = await mount();
		fire({ type: 'drop', position: inside, paths: ['/home/sam/broken.png', '/a/ok.png'] });
		await vi.waitFor(() => expect(opts.onImages).toHaveBeenCalled());
		expect(opts.onImages).toHaveBeenCalledWith(['data:image/png;base64,/a/ok.png']);
		// The file's name is logged, never its folder.
		expect(error.mock.calls[0]).toContain('broken.png');
		expect(error.mock.calls[0].join(' ')).not.toContain('/home/sam');
		error.mockRestore();
	});

	it('hands audio to a composer that takes it, and says where to drop it otherwise', async () => {
		const onAudio = vi.fn();
		const taker = await mount({ onAudio });
		fire({ type: 'drop', position: inside, paths: ['/a/take.mp3'] });
		await vi.waitFor(() => expect(onAudio).toHaveBeenCalledWith(['/a/take.mp3']));
		expect(taker.opts.onImages).not.toHaveBeenCalled();
		taker.action.destroy();

		m.handler = null;
		await mount();
		fire({ type: 'drop', position: inside, paths: ['/a/take.mp3'] });
		await vi.waitFor(() =>
			expect(m.toast).toHaveBeenCalledWith('Audio can be attached in Chat or the Code tab.')
		);
	});

	it('uses the options it was last given', async () => {
		const { action } = await mount();
		const onImages = vi.fn();
		action.update({ onImages });
		fire({ type: 'drop', position: inside, paths: ['/a/cat.png'] });
		await vi.waitFor(() => expect(onImages).toHaveBeenCalled());
	});

	it('stops listening when destroyed, and ignores a late event', async () => {
		const { opts, action } = await mount();
		action.destroy();
		expect(m.unlisten).toHaveBeenCalled();
		fire({ type: 'drop', position: inside, paths: ['/a/cat.png'] });
		await Promise.resolve();
		expect(opts.onImages).not.toHaveBeenCalled();
		expect(opts.onDragChange).not.toHaveBeenCalled();
	});
});
