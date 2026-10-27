/**
 * Checking on and stopping the background tasks this conversation or Code
 * session started (renders, uploads, later generation jobs). Offered only
 * when the turn's owner has one (`registry.ts`, the `tasks` category); a
 * task's end arrives as a notice turn, so these are for when the user asks.
 */
import { invoke } from '@tauri-apps/api/core';
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolError, toolResult, type ToolContext } from '#lib/agent/tools/types.ts';
import { taskOwner } from '#lib/tasks/notices.ts';
import { noticeFor } from '#lib/tasks/noticeText.ts';
import { getTasks } from '#lib/tasks/store.svelte.ts';
import { hasEnded, type BackgroundTask } from '#lib/tasks/types.ts';
import { waitOnUser } from '#lib/agent/tools/_helpers.ts';

/** Ended tasks older than this are left out of `task_status`'s list. */
const RECENT_MS = 24 * 60 * 60 * 1000;

function str(v: unknown): string {
	return typeof v === 'string' ? v.trim() : '';
}

/** One line on where a task has got to, or how it ended. */
function describe(t: BackgroundTask): string {
	if (t.state === 'pending') return `${t.id}: ${t.label} — waiting to start.`;
	if (t.state === 'running') {
		const parts = [
			t.percent != null ? `${Math.round(t.percent)}% done` : 'running',
			t.phase,
			t.queuePosition != null ? `${t.queuePosition} ahead of it in the server's queue` : null
		].filter(Boolean);
		return `${t.id}: ${t.label} — ${parts.join(', ')}.`;
	}
	return `${t.id}: ${noticeFor(t).text || `${t.label} ${t.state}.`}`;
}

/** The turn's own tasks: running, or ended in the last day. */
function ownTasks(ctx: ToolContext): BackgroundTask[] {
	const owner = taskOwner(ctx);
	if (!owner) return [];
	const since = Date.now() - RECENT_MS;
	return getTasks(owner).filter((t) => !hasEnded(t.state) || (t.endedMs ?? t.startedMs) >= since);
}

async function status(args: Record<string, unknown>, ctx: ToolContext) {
	const mine = ownTasks(ctx);
	const id = str(args.id);
	if (id) {
		const t = mine.find((x) => x.id === id);
		return t ? toolResult(describe(t)) : toolResult(toolError(`No task ${id} here.`));
	}
	if (mine.length === 0) return toolResult('No background tasks here in the last day.');
	return toolResult(mine.map(describe).join('\n'));
}

async function cancel(args: Record<string, unknown>, ctx: ToolContext) {
	const id = str(args.id);
	if (!id) return toolResult(toolError('task_cancel needs "id".'));
	const t = ownTasks(ctx).find((x) => x.id === id);
	if (!t) return toolResult(toolError(`No task ${id} here.`));
	if (hasEnded(t.state)) return toolResult(`That task has already ended (${t.state}).`);
	if (ctx.askUser) {
		const answer = await waitOnUser(ctx, () =>
			ctx.askUser!(
				{
					question: `Cancel “${t.label}”? What it has done so far is thrown away.`,
					options: [{ label: 'Cancel it' }, { label: 'Keep it going' }]
				},
				ctx.signal
			)
		);
		if (answer.kind !== 'selected' || answer.labels[0] !== 'Cancel it') {
			return toolResult('The user kept the task going.');
		}
	}
	const stopped = await invoke<boolean>('task_cancel', { id }).catch(() => false);
	return toolResult(stopped ? `Cancelled ${t.label}.` : 'That task is not running.');
}

const TASK_ID = { type: 'string', description: 'The task id the tool that started it returned.' };

registerTool({
	category: 'tasks',
	schema: {
		type: 'function',
		function: {
			name: 'task_status',
			description:
				'How far the background tasks started here have got, or how they ended: all of them, or one by id. Only when the user asks; you are told when one ends.',
			parameters: { type: 'object', properties: { id: TASK_ID } }
		}
	},
	displayLabel: () => 'Checking background tasks',
	execute: status
});

registerTool({
	category: 'tasks',
	schema: {
		type: 'function',
		function: {
			name: 'task_cancel',
			description: 'Stop a running background task started here, after the user confirms.',
			parameters: { type: 'object', properties: { id: TASK_ID }, required: ['id'] }
		}
	},
	displayLabel: () => 'Cancelling a background task',
	execute: cancel
});
