import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';

const spec = {
	version: 1,
	style: { prompt: 'pixel art' },
	anchor: { image: 'a.png', recipe: 'a.json' },
	normalize: { target_size: 32 },
	entries: [
		{
			id: 'player',
			kind: 'sprite',
			prompt: 'a hooded adventurer',
			out: 'assets/generated/sprite/player.png'
		},
		{ id: 'coin', kind: 'sprite', prompt: 'a gold coin', out: 'assets/generated/sprite/coin.png' },
		{ id: 'grass', kind: 'texture', prompt: 'grass', out: 'assets/generated/texture/grass.png' }
	]
};

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	enqueue: vi.fn(async () => 7),
	probe: vi.fn(async () => ({ ok: true, detail: 'Connected.' }))
}));
vi.mock('$lib/image', () => ({ resolveImageBackend: () => ({ probe: mocks.probe }) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('$lib/agent/jobs/runner.svelte', () => ({ enqueue: mocks.enqueue }));

import ReviewAssets from './ReviewAssets.svelte';

beforeEach(() => {
	mocks.enqueue.mockClear();
	mocks.probe.mockReset().mockResolvedValue({ ok: true, detail: 'Connected.' });
	mocks.invoke
		.mockReset()
		.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
			if (cmd === 'fs_read_text_full') return JSON.stringify(spec);
			if (cmd === 'fs_read_bytes') {
				if (String(args?.relPath).includes('grass')) throw new Error('Not a file');
				return [137, 80, 78, 71];
			}
			if (cmd === 'fs_path_exists') return true;
			return undefined;
		});
	URL.createObjectURL = vi.fn(() => 'blob:x');
	URL.revokeObjectURL = vi.fn();
});

function open() {
	return render(ReviewAssets, {
		props: {
			open: true,
			jobId: 18,
			workingDir: '/p',
			specPath: 'plan/assets.json',
			onclose: () => {}
		}
	});
}

describe('ReviewAssets', () => {
	it('shows every asset in the spec, and says which were never made', async () => {
		// The first version re-ran its loader whenever the images arrived and
		// emptied the grid again, so the dialog always showed nothing.
		open();
		await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(2));
		expect(screen.getByAltText('player')).toBeTruthy();
		expect(screen.getByText('not made')).toBeTruthy();
		// Loaded once, not in a loop.
		await new Promise((r) => setTimeout(r, 50));
		expect(mocks.invoke.mock.calls.filter(([c]) => c === 'fs_read_text_full')).toHaveLength(1);
	});

	it('moves the marked file aside, keeps the note, and runs the job', async () => {
		open();
		await waitFor(() => screen.getByAltText('player'));
		await fireEvent.click(screen.getByAltText('player'));
		const note = screen.getByLabelText('Note for player');
		await fireEvent.input(note, { target: { value: 'no coin' } });
		await fireEvent.click(screen.getByRole('button', { name: /Make 1 again/ }));
		await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledWith(18, 'manual'));
		const written = mocks.invoke.mock.calls.find(([c]) => c === 'fs_write_text');
		expect(JSON.parse(String(written?.[1]?.content)).entries[0].prompt).toBe(
			'a hooded adventurer, no coin'
		);
		const moved = mocks.invoke.mock.calls.find(([c]) => c === 'fs_move_in_workdir');
		expect(moved?.[1]).toMatchObject({
			fromRel: 'assets/generated/sprite/player.png',
			toRel: expect.stringMatching(
				/^assets\/generated\/sprite\/\.history\/player-\d{8}-\d{6}\.png$/
			)
		});
	});

	it('says why nothing can be made, and moves nothing, when the backend is not ready', async () => {
		// The first real review ran with no bundled model configured: the run
		// failed at once, after the sprite had already been set aside.
		mocks.probe.mockResolvedValue({
			ok: false,
			detail: 'No model is selected — Settings → Image.'
		});
		open();
		await waitFor(() => screen.getByAltText('player'));
		await waitFor(() => screen.getByText(/Nothing can be made right now: No model is selected/));
		await fireEvent.click(screen.getByAltText('player'));
		const make = screen.getByRole('button', { name: /Make 1 again/ }) as HTMLButtonElement;
		expect(make.disabled).toBe(true);
		await fireEvent.click(make);
		expect(mocks.invoke.mock.calls.some(([c]) => c === 'fs_move_in_workdir')).toBe(false);
		expect(mocks.enqueue).not.toHaveBeenCalled();
	});
});
