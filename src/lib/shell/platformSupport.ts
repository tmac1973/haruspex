/**
 * Whether the Shell tab works on this platform (`shell_platform_supported`),
 * asked once and kept. The tool registry filters synchronously, so it reads
 * the kept answer; a turn that offers a shell tool loads it first.
 */

import { invoke } from '@tauri-apps/api/core';

let supported: boolean | null = null;

/** The kept answer: null until `loadShellPlatformSupported` has one. */
export function shellPlatformSupported(): boolean | null {
	return supported;
}

/** Ask once. A failed ask isn't kept, so the next turn asks again. */
export async function loadShellPlatformSupported(): Promise<boolean | null> {
	if (supported !== null) return supported;
	try {
		const ok = await invoke<boolean>('shell_platform_supported');
		if (typeof ok === 'boolean') supported = ok;
	} catch {
		// Unknown stays unknown.
	}
	return supported;
}

/** Test seam. */
export function resetShellPlatformSupported(): void {
	supported = null;
}
