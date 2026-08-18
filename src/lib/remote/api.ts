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
