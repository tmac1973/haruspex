/**
 * Typed wrappers over the remote-chat IPC commands.
 *
 * The server is started and stopped from here rather than from Rust's setup,
 * because the frontend owns settings — including the access token, which is
 * minted with Web Crypto and stored alongside every other preference. Rust
 * never generates it, so rotating it is a settings write and a restart.
 */

import { invoke } from '@tauri-apps/api/core';

export interface RemoteConfig {
	port: number;
	token: string;
	/** Bind `0.0.0.0` so the LAN can reach it. False keeps it on loopback. */
	bindAll: boolean;
}

export interface RemoteStatus {
	running: boolean;
	port: number | null;
	bindAll: boolean;
	sessions: number;
}

export async function startRemoteServer(config: RemoteConfig): Promise<RemoteStatus> {
	return invoke<RemoteStatus>('remote_start', { config });
}

export async function stopRemoteServer(): Promise<RemoteStatus> {
	return invoke<RemoteStatus>('remote_stop');
}

export async function getRemoteStatus(): Promise<RemoteStatus> {
	return invoke<RemoteStatus>('remote_status');
}

export interface RemoteSession {
	sessionId: string;
	/** Live connections. Zero means a closed tab or a sleeping phone. */
	subscribers: number;
	busy: boolean;
}

export async function listRemoteSessions(): Promise<RemoteSession[]> {
	return invoke<RemoteSession[]>('remote_sessions');
}

/** Throw one guest off, cancelling whatever they had running. */
export async function disconnectRemoteSession(sessionId: string): Promise<void> {
	await invoke('remote_disconnect', { sessionId });
}

/**
 * The address to put in the shared link, or null on a machine with no route to
 * a network. Null is a real answer worth showing: `localhost` would look like a
 * working link and reach nobody.
 */
export async function getLanAddress(): Promise<string | null> {
	return invoke<string | null>('remote_lan_address');
}

export interface QrMatrix {
	size: number;
	/** Row-major, `size * size` entries; true is dark. */
	modules: boolean[];
}

export async function getLinkQr(text: string): Promise<QrMatrix> {
	return invoke<QrMatrix>('remote_link_qr', { text });
}

/**
 * An SVG path covering every dark module — one attribute string rather than
 * a thousand elements, and no markup to inject since it is only ever a `d`.
 */
export function qrPath(qr: QrMatrix): string {
	const parts: string[] = [];
	for (let y = 0; y < qr.size; y++) {
		for (let x = 0; x < qr.size; x++) {
			if (qr.modules[y * qr.size + x]) parts.push(`M${x} ${y}h1v1h-1z`);
		}
	}
	return parts.join('');
}

/** The link a guest is given: address, port, and the token that opens it. */
export function remoteLink(address: string, port: number, token: string): string {
	return `http://${address}:${port}/?t=${encodeURIComponent(token)}`;
}

/**
 * A URL-safe token with 160 bits of entropy — enough that guessing it is not a
 * strategy, short enough to survive being retyped from a phone screen if the
 * QR code (phase 04) fails someone.
 */
export function generateRemoteToken(): string {
	const bytes = new Uint8Array(20);
	crypto.getRandomValues(bytes);
	const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
	return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}
