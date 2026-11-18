/**
 * Another computer's prompts, answered in this app's own dialogs
 * (plan/instance-sync/): a turn there waiting on the owner (Run this
 * command?, a question, an MCP tool, a skill write…) opens the modal for its
 * kind here, labelled with the computer, and the answer goes back as
 * `prompts.answer`, the shape the web page sends. Answered there first (or
 * its turn stopped), the modal here goes away and nothing is sent.
 *
 * Runs in the main window only: every window hears each computer's events,
 * and a prompt should open one modal and notify once.
 *
 * Grants stay with the computer that asked: an "allow for this session" or
 * MCP "always" is kept there, never in this computer's approval lists.
 */
import { untrack } from 'svelte';

import type { Prompt, PromptAnswer } from '#lib/engine/types.ts';
import type { McpToolAnnotations } from '#lib/ipc/gen/McpToolAnnotations.ts';
import type { CaptureTarget } from '#lib/ipc/gen/CaptureTarget.ts';
import type { MemoryCategory } from '#lib/agent/tools/memory.ts';
import { notify as desktopNotify } from '#lib/notify.ts';
import { onPeerGone, peerViews, type PeerView } from '#lib/peers/store.svelte.ts';
import type { PromptOrigin } from '#lib/stores/approvalQueue.svelte.ts';
import { askCommandApproval } from '#lib/stores/codeCommandApproval.svelte.ts';
import { askFileConflict } from '#lib/stores/fileConflict.svelte.ts';
import { askMcpApproval } from '#lib/stores/mcpApproval.svelte.ts';
import { askMemoryApproval } from '#lib/stores/memoryApproval.svelte.ts';
import { askRepoTrust, type RepoTrustChange } from '#lib/stores/repoTrust.svelte.ts';
import { askApproval, type SandboxApprovalMode } from '#lib/stores/sandboxApproval.svelte.ts';
import { askScreenCapture } from '#lib/stores/screenCaptureApproval.svelte.ts';
import { askSkillApproval } from '#lib/stores/skillApproval.svelte.ts';
import { askUserQuestion, type UserQuestionOption } from '#lib/stores/userQuestion.svelte.ts';
import { errMessage } from '#lib/utils/error.ts';

export interface BridgeDeps {
	notify: (title: string, body: string) => void;
	/** Whether the owner is looking at this window. */
	focused: () => boolean;
}

const defaults: BridgeDeps = {
	notify: (title, body) => void desktopNotify(title, body),
	focused: () => typeof document !== 'undefined' && document.hasFocus()
};

/** Prompts with a modal open (or waiting its turn), by `<peer>:<prompt>`. */
const asking: Record<string, AbortController> = {};
/** Prompts already notified about, so a reconnect doesn't notify again. */
const notified: Record<string, true> = {};
/** Each computer's client, once hooked, with its unhook. */
const hooked = new WeakMap<PeerView['client'], () => void>();

const keyOf = (peerId: string, promptId: string) => `${peerId}:${promptId}`;

/** What a prompt is about, for its notification: the session or chat that asked. */
function subject(view: PeerView, p: Prompt): string {
	const session = p.sessionId
		? view.client.sessions.find((s) => s.id === p.sessionId)?.title
		: undefined;
	const chat = p.chatId ? view.client.chats.find((c) => c.id === p.chatId)?.title : undefined;
	return session || chat || 'A turn is waiting for you.';
}

/** Send the answer there, unless the ask was withdrawn meanwhile. */
async function answer(
	view: PeerView,
	p: Prompt,
	signal: AbortSignal,
	reply: PromptAnswer
): Promise<void> {
	if (signal.aborted) return;
	await view.client.op({ type: 'prompts.answer', promptId: p.promptId, answer: reply });
}

/** What each kind's handler gets: the prompt, where it came from, and how to reply. */
interface Ask {
	view: PeerView;
	p: Prompt;
	d: Record<string, unknown>;
	signal: AbortSignal;
	origin: PromptOrigin;
	reply: (answer: PromptAnswer) => Promise<void>;
}

const str = (v: unknown) => String(v ?? '');

/** Each kind's modal, and the answer it sends there. Camera use is answered on its own computer. */
const HANDLERS: Partial<Record<Prompt['kind'], (a: Ask) => Promise<void>>> = {
	async command({ p, d, signal, origin, reply }) {
		const reasons = ((d.reasons as string[] | undefined) ?? []).map((label) => ({
			label,
			description: ''
		}));
		const choice = await askCommandApproval({
			command: str(d.command),
			reasons,
			requester: p.requester,
			signal,
			origin
		});
		await reply({ kind: 'command', choice });
	},

	async question({ d, signal, origin, reply }) {
		const request = {
			question: str(d.question),
			...(d.body ? { body: str(d.body) } : {}),
			options: (d.options as UserQuestionOption[] | undefined) ?? [],
			allowMultiple: d.allowMultiple === true,
			origin
		};
		// Cancelled here, or answered there: it stays that computer's to answer.
		const answer = await askUserQuestion(request, signal).catch(() => null);
		if (answer) await reply({ kind: 'question', answer });
	},

	async sandbox({ d, signal, origin, reply }) {
		const mode = (d.mode as SandboxApprovalMode) ?? 'every-run';
		const choice = await askApproval({ code: str(d.code), mode, chatId: null, origin }, signal);
		await reply({ kind: 'sandbox', choice });
	},

	async memory({ d, signal, origin, reply }) {
		const category = d.category as MemoryCategory;
		const request = { content: str(d.content), category, chatId: null, origin };
		await reply({ kind: 'memory', choice: await askMemoryApproval(request, signal) });
	},

	async mcp({ view, d, signal, origin, reply }) {
		const request = {
			// Its own server: never the key of an "always" here.
			serverId: `peer:${view.id}:${str(d.server)}`,
			serverLabel: str(d.server),
			toolName: str(d.tool),
			description: (d.description as string | null) ?? null,
			annotations: (d.annotations as McpToolAnnotations | null) ?? null,
			args: (d.args as Record<string, unknown>) ?? {},
			origin
		};
		await reply({ kind: 'mcp', choice: await askMcpApproval(request, signal) });
	},

	async skill({ d, signal, origin, reply }) {
		const original = str(d.text);
		const result = await askSkillApproval(
			{
				kind: d.kind === 'agentsMd' ? 'agentsMd' : 'skill',
				update: d.update === true,
				name: str(d.name),
				dir: str(d.dir),
				project: d.project === true,
				text: original,
				current: (d.current as string | null) ?? null,
				origin,
				// Saved there: a failure shows in the modal, which stays open.
				save: (text) =>
					reply({ kind: 'skill', action: 'save', ...(text !== original ? { text } : {}) })
			},
			signal
		);
		if (result.kind === 'rejected') {
			await reply({ kind: 'skill', action: 'reject', reason: result.reason });
		}
	},

	async 'repo-trust'({ d, signal, origin, reply }) {
		const request = {
			root: str(d.root),
			skills: Number(d.skills ?? 0),
			agentsMd: d.agentsMd === true,
			...(d.change ? { change: d.change as RepoTrustChange } : {}),
			origin
		};
		await reply({ kind: 'repo-trust', trust: await askRepoTrust(request, signal) });
	},

	async 'screen-capture'({ d, signal, origin, reply }) {
		const request = { target: d.target as CaptureTarget, chatId: null, sessionId: null, origin };
		await reply({ kind: 'screen-capture', choice: await askScreenCapture(request, signal) });
	},

	async 'file-conflict'({ d, signal, origin, reply }) {
		const choice = await askFileConflict(str(d.path), null, { signal, origin });
		await reply({ kind: 'file-conflict', choice });
	}
};

/** Open the modal for `p`'s kind and wait for the owner. */
function ask(view: PeerView, p: Prompt, signal: AbortSignal): Promise<void> {
	const handler = HANDLERS[p.kind];
	if (!handler) return Promise.resolve();
	return handler({
		view,
		p,
		d: p.detail as Record<string, unknown>,
		signal,
		origin: { peerId: view.id, name: view.config.name },
		reply: (reply) => answer(view, p, signal, reply)
	});
}

function arrived(view: PeerView, p: Prompt, deps: BridgeDeps): void {
	if (!p.answerable) return;
	const key = keyOf(view.id, p.promptId);
	if (asking[key]) return;
	const controller = new AbortController();
	asking[key] = controller;
	if (!notified[key] && !deps.focused()) {
		notified[key] = true;
		deps.notify(`${view.config.name} needs you`, subject(view, p));
	}
	void ask(view, p, controller.signal)
		.catch((e: unknown) => console.warn(`Other computers: answering ${p.kind}:`, errMessage(e)))
		.finally(() => {
			if (asking[key] === controller) delete asking[key];
		});
}

function gone(peerId: string, promptId: string): void {
	const key = keyOf(peerId, promptId);
	asking[key]?.abort();
	delete asking[key];
}

function hook(view: PeerView, deps: BridgeDeps): void {
	const client = view.client;
	if (hooked.has(client)) return;
	const offs = [
		client.onPrompt((p) => arrived(view, p, deps)),
		client.onPromptGone((id) => gone(view.id, id))
	];
	hooked.set(client, () => offs.forEach((off) => off()));
	// Asked before this window hooked it.
	for (const p of Object.values(client.prompts)) arrived(view, p, deps);
}

let running: (() => void) | null = null;

/** Main window only: answer every trusted computer's prompts here from now on. */
export function startPromptBridge(deps: BridgeDeps = defaults): () => void {
	if (running) return running;
	const stopRoot = $effect.root(() => {
		$effect(() => {
			const views = peerViews();
			untrack(() => views.forEach((v) => hook(v, deps)));
		});
	});
	running = () => {
		stopRoot();
		for (const v of peerViews()) {
			hooked.get(v.client)?.();
			hooked.delete(v.client);
		}
		for (const key of Object.keys(asking)) {
			asking[key].abort();
			delete asking[key];
		}
		running = null;
	};
	return running;
}

// A computer removed or rebuilt: its open asks leave.
onPeerGone((peerId) => {
	for (const key of Object.keys(asking)) {
		if (key.startsWith(`${peerId}:`)) {
			asking[key].abort();
			delete asking[key];
		}
	}
});
