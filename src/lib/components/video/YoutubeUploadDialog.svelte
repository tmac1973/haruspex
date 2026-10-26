<script lang="ts">
	/**
	 * Asks before `youtube_upload` sends anything. Mounted in the root layout;
	 * see `stores/youtubeUploadApproval.svelte.ts`. The title, description and
	 * tags can be edited; visibility starts at Private, and "made for kids" has
	 * no default, so Upload waits until it is answered.
	 *
	 * Backdrop and Esc don't dismiss: the turn is waiting on the answer.
	 */
	import Modal from '#lib/components/Modal.svelte';
	import ModalButton from '#lib/components/ModalButton.svelte';
	import {
		getPendingYoutubeUpload,
		resolveYoutubeUpload,
		YOUTUBE_CATEGORIES
	} from '#lib/stores/youtubeUploadApproval.svelte.ts';
	import { formatDuration } from '#lib/video/report.ts';
	import type { Visibility } from '#lib/ipc/gen/Visibility.ts';

	const pending = $derived(getPendingYoutubeUpload());

	let videoTitle = $state('');
	let description = $state('');
	let tags = $state('');
	let categoryId = $state('22');
	let visibility = $state<Visibility>('private');
	let madeForKids = $state<boolean | null>(null);
	let loadedFor: unknown = null;

	$effect(() => {
		if (pending && loadedFor !== pending) {
			loadedFor = pending;
			videoTitle = pending.title;
			description = pending.description;
			tags = pending.tags.join(', ');
			categoryId = pending.categoryId || '22';
			visibility = 'private';
			madeForKids = null;
		}
	});

	const size = $derived(
		pending?.sizeBytes != null ? `${Math.round(pending.sizeBytes / 1024 ** 2)} MB` : ''
	);

	function upload() {
		if (!pending || madeForKids === null) return;
		resolveYoutubeUpload({
			kind: 'upload',
			meta: {
				title: videoTitle.trim(),
				description,
				tags: tags
					.split(',')
					.map((t) => t.trim())
					.filter(Boolean),
				categoryId,
				visibility,
				madeForKids
			}
		});
	}
</script>

<Modal open={pending != null} maxWidth={720} labelledBy="youtube-upload-title">
	{#if pending}
		<h2 id="youtube-upload-title">Upload to YouTube?</h2>
		<p>Uploads to {pending.email}'s channel.</p>
		<p class="file">
			{pending.render}{pending.durationSecs != null
				? ` · ${formatDuration(pending.durationSecs)}`
				: ''}{size ? ` · ${size}` : ''}
		</p>
		<div class="body">
			{#if pending.thumbnailDataUrl}
				<img class="thumb" src={pending.thumbnailDataUrl} alt="Thumbnail" />
			{/if}
			<div class="fields">
				<label>
					<span>Title</span>
					<input type="text" bind:value={videoTitle} maxlength="100" />
				</label>
				<label>
					<span>Description</span>
					<textarea rows="6" bind:value={description}></textarea>
				</label>
				<label>
					<span>Tags, separated by commas</span>
					<input type="text" bind:value={tags} />
				</label>
				<label>
					<span>Category</span>
					<select bind:value={categoryId}>
						{#each YOUTUBE_CATEGORIES as c (c.id)}
							<option value={c.id}>{c.label}</option>
						{/each}
					</select>
				</label>
				<fieldset>
					<legend>Visibility</legend>
					{#each [['private', 'Private'], ['unlisted', 'Unlisted'], ['public', 'Public']] as [value, label] (value)}
						<label class="choice">
							<input type="radio" name="yt-visibility" {value} bind:group={visibility} />
							{label}
						</label>
					{/each}
				</fieldset>
				<fieldset>
					<legend title="YouTube asks every uploader this; it limits comments and ads on the video."
						>Made for kids?</legend
					>
					<label class="choice">
						<input type="radio" name="yt-kids" value={true} bind:group={madeForKids} /> Yes
					</label>
					<label class="choice">
						<input type="radio" name="yt-kids" value={false} bind:group={madeForKids} /> No
					</label>
				</fieldset>
			</div>
		</div>
		<div class="button-row">
			<ModalButton onclick={upload} disabled={madeForKids === null || !videoTitle.trim()}>
				{#snippet title()}Upload{/snippet}
				{#snippet subtitle()}{visibility === 'public'
						? 'Everyone can see it'
						: visibility === 'unlisted'
							? 'Anyone with the link'
							: 'Only you, until you change it'}{/snippet}
			</ModalButton>
			<ModalButton
				variant="danger"
				onclick={() =>
					resolveYoutubeUpload({ kind: 'cancelled', reason: 'The user cancelled the upload.' })}
			>
				{#snippet title()}Cancel{/snippet}
				{#snippet subtitle()}Nothing is sent{/snippet}
			</ModalButton>
		</div>
	{/if}
</Modal>

<style>
	.file {
		margin: 0.5rem 0;
		padding: 0.5rem 0.75rem;
		border-left: 3px solid var(--accent);
		background: var(--bg-secondary);
		border-radius: 0 6px 6px 0;
		font-family: monospace;
		font-size: 0.85rem;
		word-break: break-all;
	}

	.body {
		display: flex;
		gap: 16px;
		align-items: flex-start;
		flex-wrap: wrap;
	}

	.thumb {
		width: 240px;
		border-radius: 6px;
		border: 1px solid var(--border);
	}

	.fields {
		flex: 1;
		min-width: 260px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.fields label {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.fields label span {
		font-size: 0.85rem;
		color: var(--text-secondary);
	}

	fieldset {
		border: none;
		padding: 0;
		margin: 0;
		display: flex;
		gap: 12px;
		align-items: center;
		flex-wrap: wrap;
	}

	legend {
		font-size: 0.85rem;
		color: var(--text-secondary);
		margin-right: 8px;
		float: left;
	}

	.fields .choice {
		flex-direction: row;
		align-items: center;
		gap: 4px;
	}
</style>
