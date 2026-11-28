import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { nextTask as settle } from '#lib/testing/flush.ts';
import { flushSync } from 'svelte';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
const peers = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('#lib/peers/store.svelte.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/peers/store.svelte.ts')>()),
	peerViews: () => peers.list
}));

import { EngineClient } from '#lib/engine/client.svelte.ts';
import type { StreamEvent, Transport } from '#lib/engine/transport.ts';
import type { Prompt } from '#lib/engine/types.ts';
import { currentPrompts } from '#lib/engine/prompts.svelte.ts';
import {
	getPendingCommandApproval,
	resolveCommandApproval
} from '#lib/stores/codeCommandApproval.svelte.ts';
import { getPendingConflict, resolveConflict } from '#lib/stores/fileConflict.svelte.ts';
import { getPendingMcpApproval, resolveMcpApproval } from '#lib/stores/mcpApproval.svelte.ts';
import {
	getPendingMemoryApproval,
	resolveMemoryApproval
} from '#lib/stores/memoryApproval.svelte.ts';
import { getPendingRepoTrust, resolveRepoTrust } from '#lib/stores/repoTrust.svelte.ts';
import { getPendingApproval, resolveApproval } from '#lib/stores/sandboxApproval.svelte.ts';
import {
	getPendingScreenCapture,
	resolveScreenCapture
} from '#lib/stores/screenCaptureApproval.svelte.ts';
import { getPendingSkillApproval, resolveSkillApproval } from '#lib/stores/skillApproval.svelte.ts';
import {
	cancelUserQuestion,
	getPendingQuestion,
	resolveUserQuestion
} from '#lib/stores/userQuestion.svelte.ts';
import type { PeerView } from './store.svelte.ts';
import { startPromptBridge, type BridgeDeps } from './promptBridge.svelte.ts';

/** Another computer: records operations, and lets the test push events. */
function fakePeer() {
	const ops: Record<string, unknown>[] = [];
	let push: (e: StreamEvent) => void = () => {};
	const transport: Transport = {
		op: (async (o: Record<string, unknown>) => {
			ops.push(o);
			return null;
		}) as Transport['op'],
		events: (onEvent, onConnection) => {
			push = onEvent;
			onConnection('open');
			return () => {};
		},
		upload: async () => ({ hash: 'h' })
	};
	const client = new EngineClient(transport);
	client.start();
	client.sessions = [
		{
			id: 's1',
			title: 'Fix the build',
			root: '/app',
			wslDistro: null,
			status: 'running',
			window: 'main'
		}
	];
	const view = {
		id: 'desk',
		config: { name: 'desk-pc' },
		client,
		online: true
	} as unknown as PeerView;
	return {
		view,
		answers: () => ops.filter((o) => o.type === 'prompts.answer'),
		ask: (prompt: Prompt) => push({ seq: 1, sessionId: 's1', type: 'prompt', prompt }),
		withdraw: (promptId: string) =>
			push({ seq: 2, sessionId: 's1', type: 'prompt-cleared', promptId })
	};
}

function prompt(
	kind: Prompt['kind'],
	detail: Record<string, unknown>,
	id = `main:${kind}`
): Prompt {
	return { promptId: id, kind, sessionId: 's1', answerable: true, requester: null, detail };
}

const ORIGIN = { peerId: 'desk', name: 'desk-pc' };

let peer: ReturnType<typeof fakePeer>;
let deps: { notify: Mock<BridgeDeps['notify']>; focused: Mock<BridgeDeps['focused']> };
let stop: () => void;

beforeEach(() => {
	peer = fakePeer();
	peers.list = [peer.view];
	deps = {
		notify: vi.fn<BridgeDeps['notify']>(),
		focused: vi.fn<BridgeDeps['focused']>(() => false)
	};
	stop = startPromptBridge(deps);
	flushSync();
});

afterEach(() => stop());

// Each kind: the prompt there, the local store it lands in, the owner's
// answer here, and what goes back.
const KINDS = [
	{
		kind: 'command' as const,
		detail: { command: 'rm -rf build', reasons: ['Deletes files'] },
		pending: getPendingCommandApproval,
		reply: () => resolveCommandApproval('allow_session'),
		sent: { kind: 'command', choice: 'allow_session' }
	},
	{
		kind: 'question' as const,
		detail: { question: 'Which?', body: null, options: [{ label: 'A' }], allowMultiple: false },
		pending: getPendingQuestion,
		reply: () => resolveUserQuestion({ kind: 'selected', labels: ['A'] }),
		sent: { kind: 'question', answer: { kind: 'selected', labels: ['A'] } }
	},
	{
		kind: 'sandbox' as const,
		detail: { code: 'print(1)', mode: 'once-per-chat' },
		pending: getPendingApproval,
		reply: () => resolveApproval('allow_chat'),
		sent: { kind: 'sandbox', choice: 'allow_chat' }
	},
	{
		kind: 'memory' as const,
		detail: { content: 'Likes soup', category: 'preference' },
		pending: getPendingMemoryApproval,
		reply: () => resolveMemoryApproval('deny'),
		sent: { kind: 'memory', choice: 'deny' }
	},
	{
		kind: 'mcp' as const,
		detail: {
			server: 'GitHub',
			tool: 'create_issue',
			description: null,
			annotations: null,
			args: {}
		},
		pending: getPendingMcpApproval,
		reply: () => resolveMcpApproval('allow_always'),
		sent: { kind: 'mcp', choice: 'allow_always' }
	},
	{
		kind: 'repo-trust' as const,
		detail: { root: '/app', skills: 2, agentsMd: true, change: null },
		pending: getPendingRepoTrust,
		reply: () => resolveRepoTrust(true),
		sent: { kind: 'repo-trust', trust: true }
	},
	{
		kind: 'screen-capture' as const,
		detail: { target: { kind: 'screen' } },
		pending: getPendingScreenCapture,
		reply: () => resolveScreenCapture('allow'),
		sent: { kind: 'screen-capture', choice: 'allow' }
	},
	{
		kind: 'file-conflict' as const,
		detail: { path: 'report.pdf', choices: ['overwrite', 'counter', 'cancel'] },
		pending: getPendingConflict,
		reply: () => resolveConflict('counter'),
		sent: { kind: 'file-conflict', choice: 'counter' }
	}
];

describe("another computer's prompts", () => {
	for (const k of KINDS) {
		it(`opens the ${k.kind} dialog, labelled, and sends the answer there`, async () => {
			peer.ask(prompt(k.kind, k.detail));
			await settle();
			const shown = k.pending() as { origin?: unknown } | null;
			expect(shown?.origin).toEqual(ORIGIN);
			// This computer doesn't publish it as its own.
			expect(currentPrompts('main').map((p) => p.kind)).not.toContain(k.kind);
			k.reply();
			await vi.waitFor(() => expect(peer.answers()).toHaveLength(1));
			expect(peer.answers()[0]).toEqual({
				type: 'prompts.answer',
				promptId: `main:${k.kind}`,
				answer: k.sent
			});
		});
	}

	it('saves a skill there, edited, or rejects it with the reason', async () => {
		const detail = {
			kind: 'skill',
			name: 'deploy',
			update: false,
			dir: '/skills',
			project: false,
			text: 'v1',
			current: null
		};
		peer.ask(prompt('skill', detail, 'main:s1'));
		await settle();
		const req = getPendingSkillApproval()!;
		expect(req.origin).toEqual(ORIGIN);
		await req.save('v2');
		resolveSkillApproval({ kind: 'saved', edited: true });
		await settle();
		expect(peer.answers().map((o) => o.answer)).toEqual([
			{ kind: 'skill', action: 'save', text: 'v2' }
		]);

		peer.ask(prompt('skill', detail, 'main:s2'));
		await settle();
		resolveSkillApproval({ kind: 'rejected', reason: 'Not now' });
		await vi.waitFor(() => expect(peer.answers()).toHaveLength(2));
		expect(peer.answers()[1].answer).toEqual({
			kind: 'skill',
			action: 'reject',
			reason: 'Not now'
		});
	});

	it('closes the dialog when the prompt is answered there, and sends nothing', async () => {
		peer.ask(prompt('command', { command: 'make', reasons: [] }));
		await settle();
		expect(getPendingCommandApproval()).not.toBeNull();
		peer.withdraw('main:command');
		await settle();
		expect(getPendingCommandApproval()).toBeNull();
		expect(peer.answers()).toEqual([]);
	});

	it('sends nothing when a question is cancelled here', async () => {
		peer.ask(prompt('question', { question: 'Which?', options: [{ label: 'A' }] }));
		await settle();
		cancelUserQuestion();
		await settle();
		expect(peer.answers()).toEqual([]);
	});

	it('notifies once per prompt, and not while this window is in front', async () => {
		peer.ask(prompt('command', { command: 'make', reasons: [] }, 'main:n1'));
		peer.ask(prompt('command', { command: 'make', reasons: [] }, 'main:n1'));
		await settle();
		expect(deps.notify).toHaveBeenCalledTimes(1);
		expect(deps.notify).toHaveBeenCalledWith('desk-pc needs you', 'Fix the build');
		resolveCommandApproval('deny');
		await settle();

		deps.focused.mockReturnValue(true);
		peer.ask(prompt('memory', { content: 'x', category: 'preference' }, 'main:n2'));
		await settle();
		expect(deps.notify).toHaveBeenCalledTimes(1);
		resolveMemoryApproval('deny');
	});
});
