import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import LogViewer from './LogViewer.svelte';

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
	invoke.mockReset().mockImplementation(async (cmd: string) => {
		if (cmd === 'get_search_stats') return stats;
		if (cmd === 'image_engine_logs') return ['sd-server listening'];
		if (cmd === 'comfy_logs')
			return ['GET http://gpu.lan:8188/system_stats → ok in 9 ms, 512 bytes'];
		return [];
	});
});

describe('LogViewer', () => {
	it('shows the bundled engine and the ComfyUI calls under Image', async () => {
		render(LogViewer, { open: true, onclose: vi.fn() });
		await fireEvent.click(screen.getByText('Image'));
		expect(await screen.findByText('sd-server listening')).toBeTruthy();
		const picker = screen.getByLabelText('Image log') as HTMLSelectElement;
		await fireEvent.change(picker, { target: { value: 'comfyui' } });
		expect(await screen.findByText(/system_stats → ok in 9 ms/)).toBeTruthy();
		await fireEvent.click(screen.getByText('Clear'));
		await waitFor(() => expect(invoke).toHaveBeenCalledWith('comfy_clear_logs'));
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
});
