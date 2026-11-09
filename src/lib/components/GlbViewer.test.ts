import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore({}, [1, 2, 3])
);
const view = vi.hoisted(() => ({
	stats: {
		meshes: 2,
		triangles: 10,
		size: [1, 2, 1] as [number, number, number],
		animations: 0,
		rig: null as { rig: 'skinned' | 'rigid'; bones: number } | null
	},
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
	view.stats.rig = null;
	view.playClip.mockClear();
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

	it('names the rig in the bar', async () => {
		view.stats.rig = { rig: 'skinned', bones: 42 };
		render(GlbViewer, { workdir: '/proj', relPath: 'imp.glb' });
		expect(await screen.findByText(/· skinned, 42 bones$/)).toBeTruthy();
	});

	it('says rigid without a count when clips move only meshes', async () => {
		view.stats.rig = { rig: 'rigid', bones: 0 };
		render(GlbViewer, { workdir: '/proj', relPath: 'crate.glb' });
		expect(await screen.findByText(/units · rigid$/)).toBeTruthy();
	});

	it('names no rig for a still model', async () => {
		render(GlbViewer, { workdir: '/proj', relPath: 'crate.glb' });
		expect((await screen.findByText(/2 meshes/)).textContent).not.toMatch(/skinned|rigid/);
	});
});
