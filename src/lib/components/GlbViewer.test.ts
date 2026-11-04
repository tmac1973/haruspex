import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => [1, 2, 3]) }));
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
});
