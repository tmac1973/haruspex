import { describe, it, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

import { codeTabAvailable, probeCodeTab } from './activeTab.svelte.ts';

const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
const LINUX = 'Mozilla/5.0 (X11; Linux x86_64)';

describe('the Code tab gate', () => {
	it('is open off Windows without asking', async () => {
		expect(codeTabAvailable(LINUX)).toBe(true);
		await probeCodeTab(LINUX);
		expect(mocks.invoke).not.toHaveBeenCalled();
	});

	it('opens on Windows once a WSL2 distro is found, and asks only once', async () => {
		expect(codeTabAvailable(WINDOWS)).toBe(false);
		mocks.invoke.mockResolvedValueOnce(['Ubuntu-24.04']);
		await probeCodeTab(WINDOWS);
		expect(mocks.invoke).toHaveBeenCalledWith('code_wsl_distros');
		expect(codeTabAvailable(WINDOWS)).toBe(true);
		await probeCodeTab(WINDOWS);
		expect(mocks.invoke).toHaveBeenCalledTimes(1);
	});
});
