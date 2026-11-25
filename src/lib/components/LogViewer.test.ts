import { invoke } from '@tauri-apps/api/core';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

import LogViewer from './LogViewer.svelte';
import { invokeRouter } from '#lib/testing/invoke.ts';
import { _resetForTests, beginTurn, logDebug } from '#lib/debugLog.ts';
import { copyText } from '#lib/utils/copyText.ts';

vi.mock('#lib/utils/copyText.ts', () => ({ copyText: vi.fn(async () => {}) }));

const stats = {
	session: { engines: [], globals: {} },
	lifetime: { engines: [], globals: {} },
	daily: {
		engines: [
			{
				day: '2026-10-08',
				engine: 'yahoo/browser',
				attempts: 21,
				successes: 15,
				fail_rate_limited: 0,
				fail_empty: 5,
				fail_other: 1
			},
			{
				day: '2026-10-07',
				engine: 'brave_html/browser',
				attempts: 10,
				successes: 3,
				fail_rate_limited: 7,
				fail_empty: 0,
				fail_other: 0
			}
		],
		globals: [{ day: '2026-10-08', key: 'total_queries', value: 9 }]
	}
};

beforeEach(() => {
	_resetForTests();
	vi.mocked(copyText).mockClear();
	vi.mocked(invoke)
		.mockReset()
		.mockImplementation(
			invokeRouter(
				{
					get_search_stats: stats,
					image_engine_logs: ['sd-server listening'],
					whisper_video_logs: ['whisper_init_from_file_with_params_no_state: loading model'],
					comfy_logs: ['GET http://gpu.lan:8188/system_stats → ok in 9 ms, 512 bytes']
				},
				[]
			)
		);
});

describe('LogViewer', () => {
	it('shows the bundled engine and the ComfyUI calls under Image', async () => {
		render(LogViewer, { open: true, onclose: vi.fn() });
		await fireEvent.click(screen.getByText('Image'));
		await screen.findByText('sd-server listening');
		const picker = screen.getByLabelText('Image log') as HTMLSelectElement;
		await fireEvent.change(picker, { target: { value: 'comfyui' } });
		await screen.findByText(/system_stats → ok in 9 ms/);
		await fireEvent.click(screen.getByText('Clear'));
		await waitFor(() => expect(invoke).toHaveBeenCalledWith('comfy_clear_logs'));
	});

	it("gives the video tools' whisper-server its own tab", async () => {
		render(LogViewer, { open: true, onclose: vi.fn() });
		await fireEvent.click(screen.getByText('Video whisper'));
		expect(await screen.findByText(/loading model/)).toBeTruthy();
		await fireEvent.click(screen.getByText('Clear'));
		await waitFor(() => expect(invoke).toHaveBeenCalledWith('whisper_video_clear_logs'));
	});

	it('shows search stats by day, newest first, with working out of tried', async () => {
		render(LogViewer, { open: true, onclose: vi.fn() });
		await fireEvent.click(screen.getByText('Stats'));
		const cell = await screen.findByText('15/21');
		expect(cell.className).toContain('ok-warn');
		expect(cell.getAttribute('title')).toContain('5 empty');
		expect(screen.getByText('3/10').className).toContain('ok-bad');
		const days = screen.getAllByText(/^2026-10-0[78]$/).map((el) => el.textContent);
		expect(days).toEqual(['2026-10-08', '2026-10-07']);
	});

	it("copies one chat's debug lines, and one Pretty entry", async () => {
		beginTurn({ id: 'a', title: 'Trip plan' });
		logDebug('agent', 'a starts', { step: 1 });
		beginTurn({ id: 'b', title: 'Weather' });
		logDebug('agent', 'b starts');
		beginTurn({ id: 'a', title: 'Trip plan' });
		logDebug('agent', 'a again');

		render(LogViewer, { open: true, onclose: vi.fn() });
		await fireEvent.click(screen.getByText('Debug'));
		await screen.findByText(/b starts/);
		const chat = screen.getByDisplayValue('All chats') as HTMLSelectElement;
		await fireEvent.change(chat, { target: { value: 'a' } });
		await fireEvent.click(await screen.findByText('Copy 2'));
		await waitFor(() => expect(copyText).toHaveBeenCalledTimes(1));
		const copied = vi.mocked(copyText).mock.calls[0][0];
		expect(copied).toContain('a starts');
		expect(copied).toContain('a again');
		expect(copied).not.toContain('b starts');

		await fireEvent.click(screen.getByText('Raw'));
		const [first] = await screen.findAllByTitle('Copy this entry as shown');
		await fireEvent.click(first);
		await waitFor(() => expect(copyText).toHaveBeenCalledTimes(2));
		expect(vi.mocked(copyText).mock.calls[1][0]).toMatch(
			/turn \d+ agent a starts\n\{\n {2}"step": 1\n\}$/
		);
	});
});
