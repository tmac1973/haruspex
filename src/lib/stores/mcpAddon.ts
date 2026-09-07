/**
 * Installing a companion application's addon into a project the user picks.
 *
 * Shared by the setup wizard and the settings row because it is the one setup
 * action that outlives setup: a Godot addon goes in `<project>/addons/`, so a
 * user who starts a second project six months later needs it again, and both
 * entry points have to behave identically when they do.
 */

import { invoke } from '@tauri-apps/api/core';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { IPC } from '$lib/ipc/commands';
import { getSettings } from '$lib/stores/settings';
import type { McpServerConfig } from '$lib/ipc/gen/McpServerConfig';
import type { SetupStep } from '$lib/ipc/gen/SetupStep';

export interface AddonInstall {
	/** The config with the chosen project recorded. */
	next: McpServerConfig;
	/** Where the addon actually landed, as the backend reports it. */
	installedAt: string;
}

/** The index of an entry's `addon` step, or null if it has none. */
export function addonStepIndex(steps: SetupStep[]): number | null {
	const i = steps.findIndex((s) => s.kind === 'addon');
	return i === -1 ? null : i;
}

/**
 * Record a project directory against the server.
 *
 * De-duplicated because installing into the same project twice is a normal
 * thing to do — it is how a user takes an addon update — and it should not
 * leave the same path listed twice.
 */
function withProject(config: McpServerConfig, dir: string): McpServerConfig {
	const existing = config.addonProjects ?? [];
	return {
		...config,
		addonProjects: existing.includes(dir) ? existing : [...existing, dir]
	};
}

/**
 * Ask for a project directory and install the addon into it.
 *
 * Resolves to `null` when the user dismisses the picker, which is a cancel and
 * not an error. Anything else throws with the backend's message — the useful
 * ones say the folder was not a project or that the download did not match its
 * checksum, and both should reach the user unedited.
 */
export async function pickAndInstallAddon(
	config: McpServerConfig,
	stepIndex: number
): Promise<AddonInstall | null> {
	if (config.source.kind !== 'catalog') {
		throw new Error('only a catalog server installs an addon');
	}
	const picked = await openFileDialog({ multiple: false, directory: true });
	if (typeof picked !== 'string') return null;

	const installedAt = await invoke<string>(IPC.mcp_install_addon, {
		entryId: config.source.entryId,
		stepIndex,
		targetDir: picked,
		// The archive comes from GitHub, so it is our own egress and follows
		// the app's proxy like every other download.
		proxy: getSettings().proxy
	});
	return { next: withProject(config, picked), installedAt };
}
