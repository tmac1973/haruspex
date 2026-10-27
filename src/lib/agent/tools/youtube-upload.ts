/**
 * `youtube_upload`: propose an upload of an episode's render. The user sees
 * everything that would be sent in a dialog, edits what they like, picks the
 * visibility and answers YouTube's "made for kids", and only their Upload
 * sends anything. The upload then runs in the background like a render, with
 * a follow-up turn when it ends. Same gate as the other video tools; see
 * `video.ts`. Never unattended.
 */
import { invoke } from '@tauri-apps/api/core';
import { errMessage } from '#lib/utils/error.ts';
import { getSettings } from '#lib/stores/settings.ts';
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolError, toolResult, type ToolContext } from '#lib/agent/tools/types.ts';
import { str, videoSettings } from '#lib/video/args.ts';
import { askYoutubeUpload } from '#lib/stores/youtubeUploadApproval.svelte.ts';
import { upsertTask } from '#lib/tasks/store.svelte.ts';
import { taskOwner } from '#lib/tasks/notices.ts';
import { YOUTUBE_UPLOAD } from '#lib/video/youtube.ts';
import type { UploadPlan } from '#lib/ipc/gen/UploadPlan.ts';
import type { VideoMeta } from '#lib/ipc/gen/VideoMeta.ts';
import type { BackgroundTask } from '#lib/tasks/types.ts';
import type { YoutubeAccount } from '#lib/ipc/gen/YoutubeAccount.ts';

/** YouTube's limits on what the model proposes. */
export function checkProposal(title: string, description: string, tags: string[]): string[] {
	const out: string[] = [];
	if (!title.trim() || [...title.trim()].length > 100)
		out.push('title must be 1 to 100 characters.');
	if (/[<>]/.test(title) || /[<>]/.test(description))
		out.push('YouTube allows no < or > in a title or description.');
	const bytes = new TextEncoder().encode(description).length;
	if (bytes > 5000)
		out.push(`description is ${bytes} bytes with the chapters; YouTube allows 5,000.`);
	if (tags.reduce((n, t) => n + [...t].length + 1, 0) > 500)
		out.push('tags are over 500 characters in all.');
	return out;
}

/** The description with the chapters block after a blank line, unless it is in there already. */
export function withChapters(description: string, chapters: string | null): string {
	const block = chapters?.trim();
	if (!block || description.includes(block)) return description;
	return description.trim() ? `${description.trim()}\n\n${block}` : block;
}

/** What the user changed in the dialog, for the model. */
export function changes(
	proposed: { title: string; description: string; tags: string[]; categoryId: string },
	meta: VideoMeta
): string[] {
	const out: string[] = [];
	if (proposed.title.trim() !== meta.title) out.push(`title (now "${meta.title}")`);
	if (proposed.description !== meta.description) out.push('description');
	if (proposed.tags.join(',') !== meta.tags.join(',')) out.push('tags');
	if (proposed.categoryId !== meta.categoryId) out.push('category');
	return out;
}

function episodeArg(args: Record<string, unknown>): string {
	return typeof args.episode === 'string' ? args.episode : '';
}

async function upload(args: Record<string, unknown>, ctx: ToolContext) {
	if (!ctx.interactive) {
		return toolResult(
			toolError('Uploading needs the user here to confirm it; this run is unattended.')
		);
	}
	const title = str(args.title) ?? '';
	const tags = Array.isArray(args.tags)
		? args.tags.filter((t): t is string => typeof t === 'string')
		: [];
	const categoryId = str(args.category_id) ?? '22';
	try {
		const account = await invoke<YoutubeAccount | null>('youtube_account');
		if (!account)
			return toolResult(toolError('Sign in to YouTube in Settings → Video editing first.'));
		const plan = await invoke<UploadPlan>('youtube_upload_plan', {
			workingDir: ctx.workingDir,
			episode: episodeArg(args),
			project: str(args.project),
			render: str(args.render),
			thumbnail: str(args.thumbnail),
			settings: videoSettings()
		});
		const description = withChapters(
			typeof args.description === 'string' ? args.description : '',
			args.chapters === false ? null : plan.chapters
		);
		const problems = checkProposal(title, description, tags);
		if (problems.length) return toolResult(toolError(`Not asked: ${problems.join(' ')}`));
		const proposed = { title, description, tags, categoryId };
		ctx.onApprovalWait?.(true);
		const answer = await askYoutubeUpload(
			{
				render: plan.render,
				durationSecs: plan.durationSecs,
				sizeBytes: plan.sizeBytes,
				thumbnail: plan.thumbnail,
				thumbnailDataUrl: plan.thumbnailDataUrl,
				email: account.email,
				...proposed
			},
			ctx.signal
		).finally(() => ctx.onApprovalWait?.(false));
		if (answer.kind === 'cancelled') return toolResult(answer.reason);
		const task = await invoke<BackgroundTask>('youtube_upload_start', {
			request: {
				workingDir: ctx.workingDir,
				owner: taskOwner(ctx),
				render: plan.render,
				thumbnail: plan.thumbnail,
				meta: answer.meta,
				proxy: getSettings().proxy
			}
		});
		upsertTask(task);
		const changed = changes(proposed, answer.meta);
		return {
			result:
				`The user confirmed: uploading ${plan.render} as ${answer.meta.visibility}` +
				(changed.length ? `, after changing the ${changed.join(', ')}` : '') +
				'. A message will arrive in this conversation when it finishes; do not poll.',
			artifacts: [{ kind: 'task' as const, taskId: task.id, label: task.label }]
		};
	} catch (e) {
		return toolResult(toolError(errMessage(e)));
	}
}

// Hidden until Google verifies the upload scope; see `video/youtube.ts`.
if (YOUTUBE_UPLOAD) {
	registerTool({
		category: 'video',
		schema: {
			type: 'function',
			function: {
				name: 'youtube_upload',
				description:
					"Propose uploading an episode's render to YouTube. The user sees it all in a dialog, may edit it, picks who can see it and confirms; nothing is sent without that. The chapters file and thumbnail go with it when they exist.",
				parameters: {
					type: 'object',
					properties: {
						episode: {
							type: 'string',
							description: 'The episode folder. Empty when the working folder is the episode.'
						},
						project: { type: 'string', description: 'The .kdenlive file, if not the episode’s.' },
						render: {
							type: 'string',
							description: 'The MP4 to upload. Default: the project’s newest render.'
						},
						title: { type: 'string', description: 'Up to 100 characters.' },
						description: { type: 'string', description: 'Without the chapters; they are added.' },
						tags: { type: 'array', items: { type: 'string' } },
						category_id: {
							type: 'string',
							description: 'YouTube category id. Default 22 (People & Blogs); 20 is Gaming.'
						},
						thumbnail: {
							type: 'string',
							description: 'A JPEG. Default: <project>.thumbnail.jpg when there is one.'
						},
						chapters: {
							type: 'boolean',
							description: 'Add the chapters file to the description. Default true.'
						}
					},
					required: ['title', 'description']
				}
			}
		},
		displayLabel: () => 'Preparing a YouTube upload',
		execute: upload
	});
}
