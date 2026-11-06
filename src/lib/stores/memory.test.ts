import { invoke } from '@tauri-apps/api/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	updateSettings: vi.fn(),
	settings: { memoryEnabled: false }
}));

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
vi.mock('#lib/debugLog.ts', async (importOriginal) =>
	(await import('#lib/testing/debugLog.ts')).mockDebugLog(importOriginal)
);
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: () => mocks.settings,
		updateSettings: (patch: Record<string, unknown>) => {
			Object.assign(mocks.settings, patch);
			mocks.updateSettings(patch);
		}
	})
);

import {
	__resetMemoryStateForTests,
	disableMemory,
	downloadModel,
	enableMemory,
	fetchModelForDefault,
	getMemoryCount,
	getModelError,
	getModelStatus,
	memoryActive,
	refreshMemoryCount,
	refreshModelStatus
} from './memory.svelte';
import { invokeRouter } from '#lib/testing/invoke.ts';

beforeEach(() => {
	vi.clearAllMocks();
	mocks.settings.memoryEnabled = false;
	__resetMemoryStateForTests();
});

describe('model status', () => {
	it('reads the model off disk', async () => {
		vi.mocked(invoke).mockResolvedValueOnce(true);
		await refreshModelStatus();
		expect(getModelStatus()).toBe('ready');
	});

	it('reports absent rather than failing when the check errors', async () => {
		// The status drives a download button. An unanswerable check should
		// offer the download, not leave the section blank.
		vi.mocked(invoke).mockRejectedValueOnce(new Error('ipc down'));
		await refreshModelStatus();
		expect(getModelStatus()).toBe('absent');
	});

	it('does not let a late status check clobber a running download', async () => {
		// The file check races the download it is checking for: landing while
		// bytes are still arriving, it would flip the card back to "absent"
		// underneath the progress line.
		vi.mocked(invoke).mockImplementation(() => new Promise(() => {}));
		void downloadModel();
		expect(getModelStatus()).toBe('downloading');

		await refreshModelStatus();
		expect(getModelStatus()).toBe('downloading');
	});
});

describe('downloading the model', () => {
	it('goes downloading → ready', async () => {
		vi.mocked(invoke).mockResolvedValueOnce(undefined);
		const ok = await downloadModel();
		expect(ok).toBe(true);
		expect(getModelStatus()).toBe('ready');
	});

	it('surfaces the failure instead of swallowing it', async () => {
		// Most likely cause is no network, and a toggle that silently refuses
		// to move is worse than one that says why.
		vi.mocked(invoke).mockRejectedValueOnce(new Error('network unreachable'));
		const ok = await downloadModel();
		expect(ok).toBe(false);
		expect(getModelStatus()).toBe('error');
		expect(getModelError()).toContain('network unreachable');
	});

	it('does not start a second download over a running one', async () => {
		vi.mocked(invoke).mockImplementation(() => new Promise(() => {}));
		void downloadModel();
		const second = await downloadModel();
		expect(second).toBe(false);
		expect(invoke).toHaveBeenCalledTimes(1);
	});

	it('does not turn memory on by itself', async () => {
		// Having the model on disk and choosing to be remembered are two
		// different decisions.
		vi.mocked(invoke).mockResolvedValueOnce(undefined);
		await downloadModel();
		expect(mocks.updateSettings).not.toHaveBeenCalled();
		expect(mocks.settings.memoryEnabled).toBe(false);
	});
});

describe('enabling and disabling', () => {
	it('downloads the model first when it is missing, then flips the setting', async () => {
		vi.mocked(invoke).mockResolvedValueOnce(undefined).mockResolvedValueOnce(0);
		const ok = await enableMemory();
		expect(ok).toBe(true);
		expect(mocks.updateSettings).toHaveBeenCalledWith({ memoryEnabled: true });
	});

	it('leaves the setting off when the download fails', async () => {
		// "Memory on" with no way to embed would silently do nothing, which is
		// the one state the switch must never claim.
		vi.mocked(invoke).mockRejectedValueOnce(new Error('offline'));
		const ok = await enableMemory();
		expect(ok).toBe(false);
		expect(mocks.settings.memoryEnabled).toBe(false);
	});

	it('skips the download when the model is already there', async () => {
		vi.mocked(invoke).mockResolvedValueOnce(true);
		await refreshModelStatus();
		vi.mocked(invoke).mockClear();
		vi.mocked(invoke).mockResolvedValueOnce(3);

		await enableMemory();

		expect(invoke).not.toHaveBeenCalledWith('memory_download_model');
		expect(mocks.settings.memoryEnabled).toBe(true);
	});

	it('releases the ONNX session on disable but keeps the weights', async () => {
		mocks.settings.memoryEnabled = true;
		vi.mocked(invoke).mockResolvedValueOnce(undefined);

		await disableMemory();

		expect(mocks.updateSettings).toHaveBeenCalledWith({ memoryEnabled: false });
		expect(invoke).toHaveBeenCalledWith('memory_unload_model');
	});

	it('still switches off when the unload call fails', async () => {
		// The setting is what stops anything embedding; whether the session
		// was actually released is not worth blocking the user over.
		mocks.settings.memoryEnabled = true;
		vi.mocked(invoke).mockRejectedValueOnce(new Error('no ipc'));
		await disableMemory();
		expect(mocks.settings.memoryEnabled).toBe(false);
	});
});

/**
 * The setting is not a capability. Settings sync onto a fresh machine brings
 * the flag but not the weights, and nothing may auto-download to
 * close the gap — so every caller has to ask about both.
 */
describe('memoryActive', () => {
	it('needs the setting AND the model', async () => {
		vi.mocked(invoke).mockResolvedValueOnce(true);
		await refreshModelStatus();
		expect(memoryActive()).toBe(false); // model ready, setting off

		mocks.settings.memoryEnabled = true;
		expect(memoryActive()).toBe(true);
	});

	it('is false when the setting is on but the model is missing', async () => {
		mocks.settings.memoryEnabled = true;
		vi.mocked(invoke).mockResolvedValueOnce(false);
		await refreshModelStatus();
		expect(memoryActive()).toBe(false);
	});

	it('is false before the model has been checked at all', () => {
		mocks.settings.memoryEnabled = true;
		expect(memoryActive()).toBe(false);
	});
});

describe('memory count', () => {
	it('reads the stored count', async () => {
		vi.mocked(invoke).mockResolvedValueOnce(7);
		await refreshMemoryCount();
		expect(getMemoryCount()).toBe(7);
	});

	it('keeps the last known count when the query fails', async () => {
		vi.mocked(invoke).mockResolvedValueOnce(7);
		await refreshMemoryCount();
		vi.mocked(invoke).mockRejectedValueOnce(new Error('db locked'));
		await refreshMemoryCount();
		expect(getMemoryCount()).toBe(7);
	});
});

describe('fetching the model for the on-by-default setting', () => {
	it('downloads the model when memory is on and the model is missing', async () => {
		mocks.settings.memoryEnabled = true;
		vi.mocked(invoke).mockImplementation(invokeRouter({ memory_model_present: false }, undefined));
		await fetchModelForDefault();
		expect(invoke).toHaveBeenCalledWith('memory_download_model');
		expect(getModelStatus()).toBe('ready');
	});

	it('leaves a model already on disk alone', async () => {
		mocks.settings.memoryEnabled = true;
		vi.mocked(invoke).mockResolvedValue(true);
		await fetchModelForDefault();
		expect(invoke).not.toHaveBeenCalledWith('memory_download_model');
	});

	it('downloads nothing when the user turned memory off', async () => {
		await fetchModelForDefault();
		expect(invoke).not.toHaveBeenCalled();
	});
});
