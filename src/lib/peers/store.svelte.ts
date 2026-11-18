/**
 * The owner's other computers, as this window knows them: one `EngineClient`
 * per trusted computer (Settings → Remote control → Other computers), over
 * Rust (`transport.ts`), and each one's lists as last seen, for while it's
 * offline. The Code and Chat sidebars and the remote views read other
 * computers from here.
 *
 * Nothing runs until `startPeerStore`: then the views follow Settings.
 */
import { untrack } from 'svelte';
import { invoke } from '@tauri-apps/api/core';

import { EngineClient } from '#lib/engine/client.svelte.ts';
import type { ChatListItem, SessionListItem } from '#lib/engine/types.ts';
import type { PeerConfig } from '#lib/ipc/gen/PeerConfig.ts';
import type { PeerLists } from '#lib/ipc/gen/PeerLists.ts';
import type { PeerStatus } from '#lib/ipc/gen/PeerStatus.ts';
import { releasePeerImages } from '#lib/peers/images.ts';
import { peerTransport } from '#lib/peers/transport.ts';
import { getLiveSettings } from '#lib/stores/settings.ts';

/** How long lists settle before they're kept as last seen. */
export const SAVE_LISTS_MS = 2000;

/** What's kept of a session as last seen. */
export interface KeptSession {
	id: string;
	title: string;
	root: string;
	updatedAt: number | null;
}

/** What's kept of a chat as last seen. */
export interface KeptChat {
	id: string;
	title: string;
	updatedAt: number;
}

/** A session in another computer's list: live, or as last seen while it's offline. */
export type ListedSession = KeptSession & {
	status: SessionListItem['status'];
	offline: boolean;
};

export type ListedChat = KeptChat & {
	busy: boolean;
	/** Waiting for the model, or for another turn there. */
	waiting: boolean;
	unread: boolean;
	offline: boolean;
};

export function keepSession(s: SessionListItem): KeptSession {
	return { id: s.id, title: s.title, root: s.root, updatedAt: s.updatedAt ?? null };
}

export function keepChat(c: ChatListItem): KeptChat {
	return { id: c.id, title: c.title, updatedAt: c.updatedAt };
}

export class PeerView {
	readonly client: EngineClient;
	/** Rust's last word on its connection; null until one comes. */
	status = $state<PeerStatus | null>(null);
	/** Its lists as last seen, from the database; null when none were kept. */
	lastKnown = $state<{ sessions: KeptSession[]; chats: KeptChat[]; updatedAt: number } | null>(
		null
	);

	private stopEffects: () => void;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(readonly config: PeerConfig) {
		const id = config.instanceId;
		this.client = new EngineClient(peerTransport(id, (s) => (this.status = s)));
		this.client.start();
		void invoke<PeerLists | null>('peer_lists_get', { peerId: id })
			.then((kept) => {
				if (kept && !this.lastKnown) {
					this.lastKnown = {
						sessions: kept.sessions as KeptSession[],
						chats: kept.chats as KeptChat[],
						updatedAt: kept.updatedAt
					};
				}
			})
			.catch((e: unknown) => console.warn('Other computers: last-known lists', e));
		this.stopEffects = $effect.root(() => {
			$effect(() => {
				if (this.client.connection !== 'open') return;
				const sessions = this.client.sessions.map(keepSession);
				const chats = this.client.chats.map(keepChat);
				untrack(() => this.saveSoon(sessions, chats));
			});
		});
	}

	get id(): string {
		return this.config.instanceId;
	}

	get online(): boolean {
		return this.client.connection === 'open';
	}

	/** Keep the lists as last seen, once they've settled. */
	private saveSoon(sessions: KeptSession[], chats: KeptChat[]): void {
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			this.lastKnown = { sessions, chats, updatedAt: Date.now() };
			void invoke('peer_lists_save', { peerId: this.id, sessions, chats }).catch((e: unknown) =>
				console.warn('Other computers: keeping lists', e)
			);
		}, SAVE_LISTS_MS);
	}

	dispose(): void {
		this.stopEffects();
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.client.stop();
		releasePeerImages(this.id);
	}
}

/** Its sessions: live while it's connected, else as last seen. A lean computer has none. */
export function listedSessions(peer: PeerView): ListedSession[] {
	if (peer.online) {
		if (peer.client.lean) return [];
		return peer.client.sessions.map((s) => ({
			...keepSession(s),
			status: s.status,
			offline: false
		}));
	}
	return (peer.lastKnown?.sessions ?? []).map((s) => ({ ...s, status: null, offline: true }));
}

/** As the local Code list: open ones first, then newest; list order where a time is missing. */
export function sortListedSessions(list: ListedSession[]): ListedSession[] {
	return list
		.map((s, i) => ({ s, i }))
		.sort((a, b) => {
			const open = Number(!!b.s.status) - Number(!!a.s.status);
			if (open) return open;
			if (a.s.updatedAt == null || b.s.updatedAt == null) return a.i - b.i;
			return b.s.updatedAt - a.s.updatedAt || a.i - b.i;
		})
		.map(({ s }) => s);
}

/** The folders its sessions work in, most recent first: a new session's suggestions. */
export function recentRoots(peer: PeerView, max = 10): string[] {
	const ordered = peer.client.sessions
		.map((s, i) => ({ root: s.root, at: s.updatedAt ?? null, i }))
		.sort((a, b) => (a.at == null || b.at == null ? a.i - b.i : b.at - a.at || a.i - b.i));
	const roots = ordered.map((s) => s.root);
	return roots.filter((r, i) => r && roots.indexOf(r) === i).slice(0, max);
}

/** Whether one of its sessions waits on the owner (a prompt there). */
export function sessionWaiting(peer: PeerView, sessionId: string): boolean {
	return Object.values(peer.client.prompts).some((p) => p.sessionId === sessionId);
}

/** Whether one of its chats waits on the owner. */
export function chatWaiting(peer: PeerView, chatId: string): boolean {
	return Object.values(peer.client.prompts).some((p) => p.chatId === chatId);
}

/** Whether the Code list shows a section for it: a lean computer has no Code sessions. */
export function showsCodeSection(peer: PeerView): boolean {
	return listedSessions(peer).length > 0 || (peer.online && !peer.client.lean);
}

/** Its chats: live while it's connected, else as last seen. */
export function listedChats(peer: PeerView): ListedChat[] {
	if (peer.online) {
		return peer.client.chats.map((c) => ({
			...keepChat(c),
			busy: c.busy,
			waiting: c.waiting,
			unread: c.unread,
			offline: false
		}));
	}
	return (peer.lastKnown?.chats ?? []).map((c) => ({
		...c,
		busy: false,
		waiting: false,
		unread: false,
		offline: true
	}));
}

const views = $state<Record<string, PeerView>>({});
const goneHooks: ((peerId: string) => void)[] = [];

/** Hear when a computer's view goes (removed, rebuilt, or the feature off), to close its tabs. */
export function onPeerGone(cb: (peerId: string) => void): void {
	goneHooks.push(cb);
}
let stop: (() => void) | null = null;

/** The trusted computers' views, in Settings' order. */
export function peerViews(): PeerView[] {
	return Object.values(views);
}

export function peerView(id: string): PeerView | undefined {
	return views[id];
}

/** Match the views to `peers`: keep unchanged ones, rebuild changed ones, drop the rest. */
export function reconcilePeerViews(peers: PeerConfig[]): void {
	for (const [id, view] of Object.entries(views)) {
		const config = peers.find((p) => p.instanceId === id);
		if (!config || JSON.stringify(config) !== JSON.stringify(view.config)) {
			view.dispose();
			delete views[id];
			for (const cb of goneHooks) cb(id);
		}
	}
	for (const config of peers) {
		views[config.instanceId] ??= new PeerView(structuredClone(config));
	}
}

/** Follow Settings from now on. Returns the stop, which drops every view. */
export function startPeerStore(): () => void {
	if (stop) return stop;
	const stopRoot = $effect.root(() => {
		$effect(() => {
			const s = getLiveSettings();
			const peers = s.peersEnabled ? s.peers : [];
			untrack(() => reconcilePeerViews(peers));
		});
	});
	stop = () => {
		stopRoot();
		reconcilePeerViews([]);
		stop = null;
	};
	return stop;
}
