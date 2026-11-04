import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';

const listing = vi.hoisted(() => ({ files: [] as string[], truncated: false }));
vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn(async (cmd: string) => (cmd === 'editor_list_glb' ? listing : [1, 2, 3]))
}));
const view = vi.hoisted(() => ({
	stats: { meshes: 2, triangles: 10, size: [1, 2, 1] as [number, number, number], animations: 0 },
	clips: [] as string[],
	playClip: vi.fn(),
	resetCamera: vi.fn(),
	angle: vi.fn(() => [1, 1, 1] as const),
	dispose: vi.fn()
}));
vi.mock('#lib/editor/glbViewer.ts', () => ({ mountGlbView: vi.fn(async () => view) }));

import GlbViewer from './GlbViewer.svelte';

beforeEach(() => {
	view.clips = [];
	view.playClip.mockClear();
	listing.files = [];
});

describe('GlbViewer', () => {
	it('picks which clip plays, starting on the first', async () => {
		view.clips = ['Idle', 'Walk'];
		render(GlbViewer, { workdir: '/proj', relPath: 'imp.glb' });
		const select = (await screen.findByLabelText('Animation')) as HTMLSelectElement;
		expect(select.value).toBe('0');
		expect([...select.options].map((o) => o.text)).toEqual(['Rest pose', 'Idle', 'Walk']);

		await fireEvent.change(select, { target: { value: '1' } });
		expect(view.playClip).toHaveBeenLastCalledWith(1);
		await fireEvent.change(select, { target: { value: '' } });
		expect(view.playClip).toHaveBeenLastCalledWith(null);
	});

	it('shows no picker for a model without clips', async () => {
		render(GlbViewer, { workdir: '/proj', relPath: 'crate.glb' });
		await screen.findByText(/2 meshes/);
		expect(screen.queryByLabelText('Animation')).toBeNull();
	});

	it("lists the folder's models and steps through them with the arrow keys", async () => {
		listing.files = ['a.glb', 'b/attempts/create-01/b.glb', 'b/b.glb'];
		const onpick = vi.fn();
		render(GlbViewer, { workdir: '/proj', relPath: 'b/b.glb', onpick });
		await screen.findByText('2 models');

		await fireEvent.keyDown(window, { key: 'ArrowRight' });
		expect(onpick).toHaveBeenLastCalledWith('a.glb');
		await fireEvent.click(screen.getByText('a.glb'));
		expect(onpick).toHaveBeenLastCalledWith('a.glb');

		await fireEvent.click(screen.getByLabelText('Attempts'));
		await screen.findByText('3 models');
		await fireEvent.keyDown(window, { key: 'ArrowLeft' });
		expect(onpick).toHaveBeenLastCalledWith('b/attempts/create-01/b.glb');
	});

	it('shows no list for a model alone in its folder', async () => {
		listing.files = ['crate.glb'];
		render(GlbViewer, { workdir: '/proj', relPath: 'crate.glb', onpick: vi.fn() });
		await screen.findByText(/2 meshes/);
		expect(screen.queryByLabelText('Models in this folder')).toBeNull();
	});
});
