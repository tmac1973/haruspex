import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { DownloadProgress } from '$lib/ipc/gen/DownloadProgress';

/**
 * Download `modelId`, forwarding each `download-progress` event to `onProgress`
 * and tearing the event listener down whether the download resolves or throws.
 * Returns the saved model path. Callers own their own progress-UI state —
 * seeding it, clearing it, and any post-download follow-up — so the Settings
 * catalog and the first-run wizard can keep their distinct success/error flows
 * while sharing the listener lifecycle that's easy to leak.
 */
export async function downloadModelWithProgress(
	modelId: string,
	onProgress: (p: DownloadProgress) => void
): Promise<string> {
	const unlisten = await listen<DownloadProgress>('download-progress', (e) =>
		onProgress(e.payload)
	);
	try {
		return await invoke<string>('download_model', { modelId });
	} finally {
		unlisten();
	}
}
