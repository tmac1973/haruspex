/**
 * The owner API (Settings → Remote control, plan/remote-api/): bring the
 * server in line with Settings, and manage the devices that may use it.
 *
 * `syncOwnerApi` is idempotent: Rust leaves a server already running as
 * asked alone, so a settings write about something else drops nobody.
 */
import { invoke } from '@tauri-apps/api/core';

import { logDebug } from '#lib/debugLog.ts';
import type { CreatedOwnerClient } from '#lib/ipc/gen/CreatedOwnerClient.ts';
import type { OwnerApiStatus } from '#lib/ipc/gen/OwnerApiStatus.ts';
import type { OwnerClient } from '#lib/ipc/gen/OwnerClient.ts';
import type { Scope } from '#lib/ipc/gen/Scope.ts';
import type { AccessMode } from '#lib/ipc/gen/AccessMode.ts';
import type { TrustedHost } from '#lib/ipc/gen/TrustedHost.ts';
import { getSettings } from '#lib/stores/settings.ts';
import { errMessage } from '#lib/utils/error.ts';

export type { AccessMode, CreatedOwnerClient, OwnerApiStatus, OwnerClient, Scope, TrustedHost };

/** The host in Settings' link address, which the API also accepts as its own name. */
function linkHost(base: string): string | null {
	try {
		return base.trim() ? new URL(base.trim()).host : null;
	} catch {
		return null;
	}
}

export const ALL_SCOPES: Scope[] = ['read', 'drive', 'approve', 'settings'];

/** What a new device gets unless the owner ticks more: everything but settings. */
export const DEFAULT_SCOPES: Scope[] = ['read', 'drive', 'approve'];

/** Start, restart or stop the server to match Settings. Throws what went wrong. */
export function applyOwnerApi(): Promise<OwnerApiStatus> {
	const s = getSettings();
	return invoke<OwnerApiStatus>('owner_api_apply', {
		config: {
			enabled: s.ownerApiEnabled,
			port: s.ownerApiPort,
			bindAll: s.ownerApiBindAll,
			access: {
				mode: s.ownerApiAccess,
				trustedHosts: s.ownerApiTrustedHosts,
				extraHost: linkHost(s.ownerApiLinkBase),
				trustedSettings: s.ownerApiTrustedSettings
			}
		}
	});
}

/** At startup: like `applyOwnerApi`, but a busy port is logged, not fatal. Never rejects. */
export async function syncOwnerApi(): Promise<void> {
	try {
		await applyOwnerApi();
	} catch (e) {
		logDebug('owner', 'could not start the owner API', { error: errMessage(e) });
	}
}

// The wrappers below reject with what went wrong, like `applyOwnerApi`.

export function ownerApiStatus(): Promise<OwnerApiStatus> {
	return invoke<OwnerApiStatus>('owner_api_status');
}

export function listOwnerClients(): Promise<OwnerClient[]> {
	return invoke<OwnerClient[]>('owner_clients_list');
}

export function createOwnerClient(name: string, scopes: Scope[]): Promise<CreatedOwnerClient> {
	return invoke<CreatedOwnerClient>('owner_client_create', { name, scopes });
}

export function revokeOwnerClient(id: string): Promise<boolean> {
	return invoke<boolean>('owner_client_revoke', { id });
}

/** A new pairing link for a device; it gets a new token, and the old one stops working. */
export function pairOwnerClient(id: string): Promise<CreatedOwnerClient> {
	return invoke<CreatedOwnerClient>('owner_client_pair', { id });
}

/** The trusted computers, and the addresses each was found at (none: not found). */
export function ownerTrustedHosts(): Promise<TrustedHost[]> {
	return invoke<TrustedHost[]>('owner_trusted_hosts');
}

/**
 * The link that pairs a browser: the web client, with the one-time code in
 * the fragment (never sent to a server). `base` is Settings' link address, or
 * the address the API listens on.
 */
export function pairingLink(base: string, code: string): string {
	return `${base.replace(/\/+$/, '')}/app/#pair=${code}`;
}
