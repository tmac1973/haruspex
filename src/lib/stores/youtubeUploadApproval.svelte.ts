/**
 * Approval prompt for `youtube_upload`. Same pattern as skillApproval: the tool
 * calls `askYoutubeUpload`, the dialog in the root layout shows the request,
 * and the user's choice resolves it.
 *
 * Every upload is asked about. Uploading publishes, the visibility is the
 * user's to pick (private preselected), and YouTube makes "made for kids" a
 * question only the channel's owner may answer.
 *
 * Prompts queue (`approvalQueue.svelte.ts`), one shown at a time.
 */
import { createApprovalQueue } from '#lib/stores/approvalQueue.svelte.ts';
import type { VideoMeta } from '#lib/ipc/gen/VideoMeta.ts';

export interface YoutubeUploadRequest {
	/** The render, relative to the working folder. */
	render: string;
	durationSecs: number | null;
	sizeBytes: number | null;
	/** A data URL of the thumbnail, when one goes with it. */
	thumbnailDataUrl: string | null;
	thumbnail: string | null;
	email: string;
	/** What the model proposed. `visibility` and `madeForKids` are the user's. */
	title: string;
	description: string;
	tags: string[];
	categoryId: string;
}

export type YoutubeUploadResult =
	{ kind: 'upload'; meta: VideoMeta } | { kind: 'cancelled'; reason: string };

const queue = createApprovalQueue<YoutubeUploadRequest, YoutubeUploadResult>();

export function askYoutubeUpload(
	request: YoutubeUploadRequest,
	signal?: AbortSignal
): Promise<YoutubeUploadResult> {
	return queue.ask(request, {
		signal,
		abortResult: { kind: 'cancelled', reason: 'The turn was stopped.' }
	});
}

export function getPendingYoutubeUpload(): YoutubeUploadRequest | null {
	return queue.current();
}

export function resolveYoutubeUpload(result: YoutubeUploadResult): void {
	queue.resolve(result);
}

/** YouTube's standard categories, by id. */
export const YOUTUBE_CATEGORIES: { id: string; label: string }[] = [
	{ id: '1', label: 'Film & Animation' },
	{ id: '2', label: 'Autos & Vehicles' },
	{ id: '10', label: 'Music' },
	{ id: '15', label: 'Pets & Animals' },
	{ id: '17', label: 'Sports' },
	{ id: '19', label: 'Travel & Events' },
	{ id: '20', label: 'Gaming' },
	{ id: '22', label: 'People & Blogs' },
	{ id: '23', label: 'Comedy' },
	{ id: '24', label: 'Entertainment' },
	{ id: '25', label: 'News & Politics' },
	{ id: '26', label: 'Howto & Style' },
	{ id: '27', label: 'Education' },
	{ id: '28', label: 'Science & Technology' },
	{ id: '29', label: 'Nonprofits & Activism' }
];
