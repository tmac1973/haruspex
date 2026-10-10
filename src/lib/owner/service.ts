/**
 * The owner API (Settings → Remote control, plan/remote-api/): bring the
 * server in line with Settings, and manage the devices that may use it.
 *
 * `syncOwnerApi` is idempotent: Rust leaves a server already running as
 * asked alone, so a settings write about something else drops nobody.
 */
import { invoke } from '@tauri-apps/api/core';

import { logDebug } from '#lib/debug-log.ts';
import type { CreatedOwnerClient } from '#lib/ipc/gen/CreatedOwnerClient.ts';
import type { OwnerApiStatus } from '#lib/ipc/gen/OwnerApiStatus.ts';
import type { OwnerClient } from '#lib/ipc/gen/OwnerClient.ts';
import type { Scope } from '#lib/ipc/gen/Scope.ts';
import { getSettings } from '#lib/stores/settings.ts';
import { errMessage } from '#lib/utils/error.ts';

export type { CreatedOwnerClient, OwnerApiStatus, OwnerClient, Scope };

export const ALL_SCOPES: Scope[] = ['read', 'drive', 'approve'];

/** Start, restart or stop the server to match Settings. Throws what went wrong. */
export function applyOwnerApi(): Promise<OwnerApiStatus> {
	const s = getSettings();
	return invoke<OwnerApiStatus>('owner_api_apply', {
		config: { enabled: s.ownerApiEnabled, port: s.ownerApiPort, bindAll: s.ownerApiBindAll }
	});
}

/** At startup: like `applyOwnerApi`, but a busy port is logged, not fatal. */
export async function syncOwnerApi(): Promise<OwnerApiStatus | null> {
	try {
		return await applyOwnerApi();
	} catch (e) {
		logDebug('owner', 'could not start the owner API', { error: errMessage(e) });
		return null;
	}
}

export const ownerApiStatus = () => invoke<OwnerApiStatus>('owner_api_status');
export const listOwnerClients = () => invoke<OwnerClient[]>('owner_clients_list');
export const createOwnerClient = (name: string, scopes: Scope[]) =>
	invoke<CreatedOwnerClient>('owner_client_create', { name, scopes });
export const revokeOwnerClient = (id: string) => invoke<boolean>('owner_client_revoke', { id });
