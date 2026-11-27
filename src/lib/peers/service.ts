/**
 * Your other computers (Settings → Remote control → Other computers,
 * plan/archive/instance-sync/): which ones this Haruspex trusts, kept in Settings,
 * and Rust brought in line with them. Rust holds the connections; every
 * request to another computer goes through it, pinned to the fingerprint the
 * owner confirmed here.
 *
 * `applyPeers` is idempotent: Rust keeps a stream whose computer didn't
 * change, so a settings write about something else drops nothing.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import { logDebug } from '#lib/debugLog.ts';
import type { FoundPeer } from '#lib/ipc/gen/FoundPeer.ts';
import type { InstanceIdentity } from '#lib/ipc/gen/InstanceIdentity.ts';
import type { PeerConfig } from '#lib/ipc/gen/PeerConfig.ts';
import type { PeerProbe } from '#lib/ipc/gen/PeerProbe.ts';
import type { PeerStatus } from '#lib/ipc/gen/PeerStatus.ts';
import type { PeersConfig } from '#lib/ipc/gen/PeersConfig.ts';
import { deleteSecret, setSecret } from '#lib/stores/secrets.ts';
import { getSettings, updateSettings } from '#lib/stores/settings.ts';
import { errMessage } from '#lib/utils/error.ts';

export type { FoundPeer, PeerConfig, PeerProbe, PeerStatus };

/** The port Remote control answers on unless its owner changed it. */
export const DEFAULT_PEER_PORT = 8788;

/** Where a computer's token is kept: the key Rust reads (`peers::token_key`). */
export function peerTokenKey(instanceId: string): string {
	return `peer:${instanceId}`;
}

/** What Rust is told: the trusted computers, and whether to use them at all. */
export function peersConfig(): PeersConfig {
	const s = getSettings();
	return { enabled: s.peersEnabled, peers: s.peers };
}

/** Bring Rust in line with Settings. Throws what went wrong. */
export function applyPeers(): Promise<void> {
	return invoke<void>('peers_apply', { config: peersConfig() });
}

/** At startup: like `applyPeers`, but a failure is logged. Never rejects. */
export async function syncPeers(): Promise<void> {
	try {
		await applyPeers();
	} catch (e) {
		logDebug('peers', 'could not follow the other computers', { error: errMessage(e) });
	}
}

export function setPeersEnabled(on: boolean): Promise<void> {
	updateSettings({ peersEnabled: on });
	return applyPeers();
}

let ownId: Promise<string> | null = null;

/** This Haruspex's install id, asked for once. */
function thisInstance(): Promise<string> {
	ownId ??= invoke<InstanceIdentity>('instance_identity').then((i) => i.id);
	return ownId;
}

/** What checking a computer found. */
export type CheckResult =
	/** One not trusted yet: ask the owner. */
	| { kind: 'new'; probe: PeerProbe }
	/** One already trusted, at the same fingerprint: its address was updated. */
	| { kind: 'updated'; peer: PeerConfig }
	/** One already trusted whose certificate isn't the pinned one: ask again. */
	| { kind: 'changed'; peer: PeerConfig; probe: PeerProbe };

/**
 * Reach a computer at the first of `addresses` that answers, and say what it
 * is. Throws "That's this computer." for this one, or the last probe's error.
 */
export async function checkPeer(addresses: string[], port: number): Promise<CheckResult> {
	let lastError: unknown = new Error('No address to try.');
	for (const address of addresses) {
		let probe: PeerProbe;
		try {
			probe = await invoke<PeerProbe>('peer_probe', { address, port });
		} catch (e) {
			lastError = e;
			continue;
		}
		if (probe.instanceId === (await thisInstance())) throw new Error("That's this computer.");
		const known = getSettings().peers.find((p) => p.instanceId === probe.instanceId);
		if (!known) return { kind: 'new', probe };
		if (known.fingerprint !== probe.fingerprint) return { kind: 'changed', peer: known, probe };
		const peer = { ...known, name: probe.name, address: probe.address, port: probe.port };
		await savePeers(getSettings().peers.map((p) => (p.instanceId === peer.instanceId ? peer : p)));
		return { kind: 'updated', peer };
	}
	throw lastError;
}

async function savePeers(peers: PeerConfig[], refusedPeers?: string[]): Promise<void> {
	updateSettings(refusedPeers ? { peers, refusedPeers } : { peers });
	await applyPeers();
}

/**
 * Trust what a probe found, pinned to its fingerprint. A computer already in
 * the list keeps its place and how it gets in; only its pin and address change.
 */
export function trustPeer(probe: PeerProbe): Promise<void> {
	const { peers, refusedPeers } = getSettings();
	const known = peers.find((p) => p.instanceId === probe.instanceId);
	const peer: PeerConfig = {
		instanceId: probe.instanceId,
		name: probe.name,
		address: probe.address,
		port: probe.port,
		fingerprint: probe.fingerprint,
		auth: known?.auth ?? 'trusted'
	};
	const next = known
		? peers.map((p) => (p.instanceId === peer.instanceId ? peer : p))
		: [...peers, peer];
	return savePeers(
		next,
		refusedPeers.filter((id) => id !== probe.instanceId)
	);
}

/** Don't offer this computer as found again. Adding it by hand still asks. */
export function refusePeer(instanceId: string): void {
	const { refusedPeers } = getSettings();
	if (!refusedPeers.includes(instanceId)) {
		updateSettings({ refusedPeers: [...refusedPeers, instanceId] });
	}
}

/** Stop following a computer, and forget its token. */
export async function removePeer(instanceId: string): Promise<void> {
	await savePeers(getSettings().peers.filter((p) => p.instanceId !== instanceId));
	await deleteSecret(peerTokenKey(instanceId));
}

/** Get in on a computer with a script token from it, instead of being trusted. */
export async function setPeerToken(instanceId: string, token: string): Promise<void> {
	await setSecret(peerTokenKey(instanceId), token.trim());
	await savePeers(
		getSettings().peers.map((p) =>
			p.instanceId === instanceId ? { ...p, auth: 'token' as const } : p
		)
	);
}

/**
 * Follow what Rust reports: computers found on the network and each trusted
 * one's connection, starting with what it already knows. Returns the stop.
 */
export async function watchPeers(handlers: {
	found: (found: FoundPeer[]) => void;
	status: (status: PeerStatus) => void;
}): Promise<UnlistenFn> {
	const stops = await Promise.all([
		listen<FoundPeer[]>('peer://found', (e) => handlers.found(e.payload)),
		listen<PeerStatus>('peer://status', (e) => handlers.status(e.payload))
	]);
	const [found, statuses] = await Promise.all([
		invoke<FoundPeer[] | null>('peers_found'),
		invoke<PeerStatus[] | null>('peers_status')
	]);
	handlers.found(found ?? []);
	for (const status of statuses ?? []) handlers.status(status);
	return () => stops.forEach((stop) => stop());
}

/** A fingerprint as the trust dialog shows it: four bytes to a group. */
export function groupFingerprint(fingerprint: string): string[] {
	const bytes = fingerprint.split(':');
	const groups: string[] = [];
	for (let i = 0; i < bytes.length; i += 4) groups.push(bytes.slice(i, i + 4).join(':'));
	return groups;
}

/** For tests: forget the cached install id. */
export function resetPeersForTest(): void {
	ownId = null;
}
