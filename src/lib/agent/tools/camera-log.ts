/**
 * `camera_log`: the ambient log the watchers keep (Settings → Cameras → Edit →
 * Log motion and speech), searched by camera, words and time. The model gets
 * what was heard and the caption of what was seen as text (`camera/log.ts`),
 * never the pictures.
 *
 * Same gate as the other camera tools. With no camera named it reads every
 * camera the turn may: Allow cameras, plus the Ask ones once the user says yes
 * to a single prompt naming them all. A job gets the Allow cameras only.
 */

import { invoke } from '@tauri-apps/api/core';
import type { CameraConfig } from '#lib/ipc/gen/CameraConfig.ts';
import type { CameraEvent } from '#lib/ipc/gen/CameraEvent.ts';
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolResult, toolError, type ToolContext } from '#lib/agent/tools/types.ts';
import { ASK_IN_JOB, cameraAccessRefusal, cameraGate } from '#lib/agent/tools/_cameraGate.ts';
import { errorText, refused } from '#lib/agent/tools/camera.ts';
import { askCameraUse } from '#lib/stores/cameraApproval.svelte.ts';
import { getSettings } from '#lib/stores/settings.ts';
import {
	DEFAULT_LOG_LIMIT,
	MAX_LOG_LIMIT,
	logLimit,
	parseLogTime,
	renderCameraLog
} from '#lib/camera/log.ts';

type Picked = { cameras: CameraConfig[]; note: string } | { refusal: string; declined?: boolean };

/** The one camera the model named, through the gate. */
async function namedCamera(ctx: ToolContext, name: unknown): Promise<Picked> {
	const gate = await cameraGate(ctx, name, 'read_log');
	return gate.camera ? { cameras: [gate.camera], note: '' } : gate;
}

interface LogQuery {
	query: string;
	since: number | undefined;
	until: number | undefined;
	limit: number;
}

/**
 * The cameras' entries, newest first. Every camera is one read; a few are one
 * each, merged.
 */
async function readLog(
	cameras: CameraConfig[],
	anyCamera: boolean,
	{ query, ...filter }: LogQuery
): Promise<CameraEvent[]> {
	const read = (cameraId?: string) =>
		query
			? invoke<CameraEvent[]>('camera_events_search', { query, cameraId, ...filter })
			: invoke<CameraEvent[]>('camera_events_list', { cameraId, ...filter });
	if (anyCamera && cameras.length === getSettings().cameras.length) return read();
	const each = await Promise.all(cameras.map((c) => read(c.id)));
	return each
		.flat()
		.sort((a, b) => b.startedAt - a.startedAt || b.id - a.id)
		.slice(0, filter.limit);
}

/** What the model is told when nothing matched. */
function nothingFound(cameras: CameraConfig[], named: boolean, query: string): string {
	const where = named ? `${cameras[0].name}'s log` : 'the camera log';
	const matching = query ? ` matching "${query}"` : '';
	const off = cameras.every((c) => !c.watcher.enabled)
		? ' The ambient log is off; Settings → Cameras turns it on.'
		: '';
	return `No entries in ${where}${matching} for that time.${off}`;
}

/**
 * The cameras whose log this call may read when the model named none: every
 * Allow camera, and the Ask ones too once the user says yes (asked once for
 * all of them). A turn nobody is watching gets the Allow ones only.
 */
async function logCameras(ctx: ToolContext): Promise<Picked> {
	const access = cameraAccessRefusal(ctx);
	if (access) return { refusal: access };
	const all = getSettings().cameras;
	const allowed = all.filter((c) => c.permission === 'allow');
	const asking = all.filter((c) => c.permission !== 'allow');
	if (asking.length === 0) return { cameras: allowed, note: '' };
	const left = `Left out ${asking.map((c) => c.name).join(', ')}`;
	if (!ctx.interactive) {
		if (allowed.length === 0) return { refusal: ASK_IN_JOB };
		return { cameras: allowed, note: `${left}: set to Ask, so jobs can't read them.` };
	}
	ctx.onApprovalWait?.(true);
	const choice = await askCameraUse(
		{
			cameras: asking.map((c) => c.name),
			action: 'read_log',
			chatId: ctx.conversationId ?? null,
			sessionId: ctx.codeSessionId ?? null
		},
		ctx.signal
	).finally(() => ctx.onApprovalWait?.(false));
	if (choice === 'allow') return { cameras: all, note: '' };
	if (allowed.length === 0) {
		return {
			declined: true,
			refusal: 'The user declined. No camera log was read; do not ask again unless they do.'
		};
	}
	return { cameras: allowed, note: `${left}: the user declined.` };
}

registerTool({
	category: 'camera',
	schema: {
		type: 'function',
		function: {
			name: 'camera_log',
			description:
				"Search the log the user's cameras keep while their ambient log is on: one entry per time something moved or someone spoke, with what was said and a one-line description of what was seen. Newest first; no pictures. Use it for questions about the past, like whether anyone came by today.",
			parameters: {
				type: 'object',
				properties: {
					camera: {
						type: 'string',
						description: "One camera's name, as camera_list gives it. Leave out for every camera."
					},
					query: {
						type: 'string',
						description:
							'Words to look for in what was said or seen (every word must match). Leave out for every entry.'
					},
					since: {
						type: 'string',
						description:
							'Earliest time: an ISO time (2026-11-12T14:00), "today", "yesterday" or "last 3 hours".'
					},
					until: {
						type: 'string',
						description: 'Latest time, in the same forms as since.'
					},
					limit: {
						type: 'integer',
						description: `How many entries, 1 to ${MAX_LOG_LIMIT}. Defaults to ${DEFAULT_LOG_LIMIT}.`
					}
				}
			}
		}
	},
	displayLabel: (args) =>
		args.camera ? `Read ${String(args.camera)}'s log` : 'Read the camera log',
	async execute(args, ctx) {
		const since = parseLogTime(args.since, 'since');
		const until = parseLogTime(args.until, 'until');
		if (typeof since === 'object') return toolResult(toolError(since.error));
		if (typeof until === 'object') return toolResult(toolError(until.error));
		const query = typeof args.query === 'string' ? args.query.trim() : '';
		const named = !!String(args.camera ?? '').trim();

		const picked = named ? await namedCamera(ctx, args.camera) : await logCameras(ctx);
		if ('refusal' in picked) return refused(picked);
		const { cameras, note } = picked;

		let events: CameraEvent[];
		try {
			events = await readLog(cameras, !named, { query, since, until, limit: logLimit(args.limit) });
		} catch (e) {
			return toolResult(toolError(`Reading the camera log failed: ${errorText(e)}`));
		}
		const tail = note ? `\n${note}` : '';
		if (events.length === 0) {
			return toolResult(`${nothingFound(cameras, named, query)}${tail}`);
		}
		const header = `${events.length} ${events.length === 1 ? 'entry' : 'entries'}, newest first (local time):`;
		return toolResult(`${header}\n${renderCameraLog(events)}${tail}`);
	}
});
