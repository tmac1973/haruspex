/**
 * Who changed a notebook card, and the way back to them. Every card and
 * revision records a source (`NotebookSource`): you, or a chat, Code
 * session, Shell tab or job, with its id and title at the time. The badge
 * on a card says which (`describeSource`); clicking it opens that
 * conversation, session or run (`openSource`).
 */
import type { NotebookSource } from '#lib/notebooks/api.ts';
import type { ToolContext } from '#lib/agent/tools/types.ts';

const KIND_LABEL: Record<NotebookSource['kind'], string> = {
	user: 'You',
	chat: 'Chat',
	notebook_chat: 'Notebook chat',
	shell: 'Shell',
	code: 'Code',
	job: 'Jobs',
	python: 'Python card',
	import: 'Import'
};

/** "From Chat: Speakers", "Edited by you", "From Shell". */
export function describeSource(source: NotebookSource): string {
	if (source.kind === 'user') return source.label ? `Edited from ${source.label}` : 'Edited by you';
	const kind = KIND_LABEL[source.kind] ?? source.kind;
	return source.label ? `From ${kind}: ${source.label}` : `From ${kind}`;
}

/** Whether `openSource` can go anywhere for this source. */
export function canOpenSource(source: NotebookSource): boolean {
	return !!source.ref && ['chat', 'notebook_chat', 'code', 'job', 'python'].includes(source.kind);
}

/**
 * Marks what a container shows when the active tab doesn't say: a job run's
 * output, in the Jobs tab or on a Home card. Its value is `jobSourceAttr`'s.
 */
export const SOURCE_ATTR = 'data-notebook-source';

/** `SOURCE_ATTR`'s value for a job run's output. */
export function jobSourceAttr(jobId: number, runId: number | null, name?: string): string {
	const source: NotebookSource = {
		kind: 'job',
		ref: runId === null ? String(jobId) : `${jobId}:${runId}`,
		label: name || undefined
	};
	return JSON.stringify(source);
}

/** The source the nearest marked container around `el` names, if any. */
export function markedSource(el: Element | null | undefined): NotebookSource | null {
	const raw = el?.closest(`[${SOURCE_ATTR}]`)?.getAttribute(SOURCE_ATTR);
	if (!raw) return null;
	try {
		const v = JSON.parse(raw) as NotebookSource;
		return v && typeof v.kind === 'string' ? v : null;
	} catch {
		return null;
	}
}

/** A job source's ref: `<jobId>:<runId>`. */
export function parseJobRef(ref: string): { jobId: number; runId: number | null } | null {
	const m = /^(\d+)(?::(\d+))?$/.exec(ref);
	return m ? { jobId: Number(m[1]), runId: m[2] ? Number(m[2]) : null } : null;
}

/**
 * Open what made a change: the chat, the Code session, the job run, or (for
 * a notebook's own chat or a Python card) the notebook. Returns false when
 * it's gone.
 */
export async function openSource(source: NotebookSource, notebookId?: string): Promise<boolean> {
	if (!source.ref) return false;
	const { setActiveTab } = await import('#lib/stores/activeTab.svelte.ts');
	switch (source.kind) {
		case 'chat': {
			const chat = await import('#lib/stores/chat.svelte.ts');
			if (!chat.getConversations().some((c) => c.id === source.ref)) return false;
			setActiveTab('chat');
			await chat.setActiveConversation(source.ref);
			return true;
		}
		case 'code': {
			const code = await import('#lib/stores/code.svelte.ts');
			setActiveTab('code');
			return (await code.openSession(source.ref)) !== null;
		}
		case 'job': {
			const ref = parseJobRef(source.ref);
			if (!ref) return false;
			const { selectJob } = await import('#lib/stores/jobsTabSelection.svelte.ts');
			setActiveTab('jobs');
			selectJob(ref.jobId, ref.runId);
			return true;
		}
		case 'notebook_chat':
		case 'python': {
			if (!notebookId) return false;
			const nb = await import('#lib/stores/notebooks.svelte.ts');
			setActiveTab('notebooks');
			return nb.openNotebook(notebookId, source.kind === 'python' ? source.ref : undefined);
		}
		default:
			return false;
	}
}

/** The bit of a tool context a notebook source is read from. */
export type SourceContext = Partial<
	Pick<
		ToolContext,
		| 'conversationId'
		| 'codeMode'
		| 'shellMode'
		| 'codeSessionId'
		| 'jobRunId'
		| 'requester'
		| 'notebookChat'
	>
>;

/** Lookups `sourceFromToolContext` needs, passed in so it stays testable. */
export interface SourceLookups {
	conversationTitle(id: string): string | undefined;
	jobOfRun(runId: number): Promise<{ jobId: number; name: string } | null>;
}

/** Who a tool call's changes come from: the tab and conversation it runs in. */
export async function sourceFromToolContext(
	ctx: SourceContext,
	lookups: SourceLookups
): Promise<NotebookSource> {
	const asked = ctx.requester?.().trim() || undefined;
	if (ctx.notebookChat) {
		return {
			kind: 'notebook_chat',
			ref: ctx.conversationId,
			label: ctx.notebookChat.title
		};
	}
	if (ctx.jobRunId !== undefined) {
		const job = await lookups.jobOfRun(ctx.jobRunId);
		return job
			? { kind: 'job', ref: `${job.jobId}:${ctx.jobRunId}`, label: job.name }
			: { kind: 'job' };
	}
	if (ctx.codeMode && ctx.codeSessionId) {
		return {
			kind: 'code',
			ref: ctx.codeSessionId,
			label: asked?.replace(/^Code · /, '')
		};
	}
	if (ctx.shellMode) return { kind: 'shell', label: asked };
	if (ctx.conversationId) {
		return {
			kind: 'chat',
			ref: ctx.conversationId,
			label: lookups.conversationTitle(ctx.conversationId)
		};
	}
	return { kind: 'chat' };
}

/** The lookups the app uses, over the chat and job stores. */
export async function appLookups(): Promise<SourceLookups> {
	const [chat, runs, jobs] = await Promise.all([
		import('#lib/stores/chat.svelte.ts'),
		import('#lib/stores/jobRuns.svelte.ts'),
		import('#lib/stores/jobs.svelte.ts')
	]);
	return {
		conversationTitle: (id) => chat.getConversations().find((c) => c.id === id)?.title,
		async jobOfRun(runId) {
			const run = await runs.getJobRun(runId);
			if (!run) return null;
			const job = jobs.getJobs().find((j) => j.id === run.job_id);
			return { jobId: run.job_id, name: job?.name ?? 'a job' };
		}
	};
}
