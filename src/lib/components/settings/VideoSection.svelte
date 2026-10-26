<script lang="ts">
	import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
	import { invoke } from '@tauri-apps/api/core';
	import { listen } from '@tauri-apps/api/event';
	import DownloadProgressBar from '#lib/components/settings/DownloadProgressBar.svelte';
	import type { DownloadProgress } from '#lib/ipc/gen/DownloadProgress.ts';
	import type { YoutubeAccount } from '#lib/ipc/gen/YoutubeAccount.ts';
	import { errMessage } from '#lib/utils/error.ts';
	import { getSettings, updateSettings } from '#lib/stores/settings.ts';
	import { refreshVideoBinaries, videoBinariesStatus, videoEncoders } from '#lib/video/binaries.ts';
	import type { EncoderOption } from '#lib/ipc/gen/EncoderOption.ts';
	import { VIDEO_PRESETS, type VideoPreset } from '#lib/video/types.ts';
	import type { VideoBinariesStatus } from '#lib/ipc/gen/VideoBinariesStatus.ts';
	import type { FoundBinary } from '#lib/ipc/gen/FoundBinary.ts';

	type Tool = 'ffmpeg' | 'ffprobe' | 'melt';
	const TOOLS: Tool[] = ['ffmpeg', 'ffprobe', 'melt'];
	const SETTING = {
		ffmpeg: 'videoFfmpegPath',
		ffprobe: 'videoFfprobePath',
		melt: 'videoMeltPath'
	} as const;
	const LOOKED =
		'Looked in the path set here, then PATH, then inside a Kdenlive install (Kdenlive’s bin folder on Windows, kdenlive.app on macOS).';

	let paths = $state<Record<Tool, string>>({
		ffmpeg: getSettings().videoFfmpegPath,
		ffprobe: getSettings().videoFfprobePath,
		melt: getSettings().videoMeltPath
	});
	let enabled = $state(getSettings().videoEnabled);
	let preset = $state<VideoPreset>(getSettings().videoPreset);
	let intro = $state(getSettings().videoIntroPath);
	let outro = $state(getSettings().videoOutroPath);
	let encoder = $state(getSettings().videoEncoder);

	/** Whether this build has Google sign-in, and who is signed in for uploads. */
	let googleAvailable = $state(false);
	let youtube = $state<YoutubeAccount | null>(null);
	let signingIn = $state(false);
	void invoke<boolean>('google_sign_in_available')
		.then((ok) => {
			googleAvailable = ok;
			if (ok) return invoke<YoutubeAccount | null>('youtube_account').then((a) => (youtube = a));
		})
		.catch(() => {});

	async function youtubeSignIn() {
		error = '';
		signingIn = true;
		try {
			youtube = await invoke<YoutubeAccount>('youtube_sign_in', { proxy: getSettings().proxy });
		} catch (e) {
			error = errMessage(e);
		} finally {
			signingIn = false;
		}
	}

	async function youtubeSignOut() {
		error = '';
		try {
			await invoke('youtube_sign_out', { proxy: getSettings().proxy });
			youtube = null;
		} catch (e) {
			error = errMessage(e);
		}
	}

	/** large-v3-turbo's path once downloaded; null while base.en is what transcribes. */
	let turbo = $state<string | null>(null);
	let downloading = $state(false);
	let download = $state<DownloadProgress | null>(null);
	void invoke<string | null>('get_whisper_video_model_path')
		.then((p) => (turbo = p))
		.catch(() => {});

	async function downloadTurbo() {
		error = '';
		downloading = true;
		download = null;
		const unlisten = await listen<DownloadProgress>(
			'download-progress',
			(e) => (download = e.payload)
		);
		try {
			turbo = await invoke<string>('download_whisper_video_model');
		} catch (e) {
			error = errMessage(e);
		} finally {
			unlisten();
			downloading = false;
		}
	}

	async function deleteTurbo() {
		error = '';
		try {
			await invoke('delete_whisper_video_model');
			turbo = null;
		} catch (e) {
			error = errMessage(e);
		}
	}
	let encoderOptions = $state<EncoderOption[]>([]);
	let testingEncoders = $state(false);

	async function loadEncoders(again = false) {
		testingEncoders = true;
		try {
			encoderOptions = await videoEncoders(again);
		} catch (e) {
			error = errMessage(e);
		} finally {
			testingEncoders = false;
		}
	}

	function chooseEncoder(e: Event) {
		encoder = (e.currentTarget as HTMLSelectElement).value;
		updateSettings({ videoEncoder: encoder });
	}

	let status = $state<VideoBinariesStatus | null>(videoBinariesStatus());
	let checking = $state(false);
	let error = $state('');

	const missing = $derived(status ? TOOLS.filter((t) => !status?.[t]) : []);

	async function check() {
		checking = true;
		error = '';
		try {
			status = await refreshVideoBinaries();
			if (status.melt && encoderOptions.length === 0) void loadEncoders();
		} catch (e) {
			error = errMessage(e);
		} finally {
			checking = false;
		}
	}
	void check();

	function toggle() {
		updateSettings({ videoEnabled: enabled });
	}

	function savePath(tool: Tool) {
		updateSettings({ [SETTING[tool]]: paths[tool].trim() });
		void check();
	}

	async function browse(tool: Tool) {
		const chosen = await openFileDialog({ multiple: false, directory: false });
		if (typeof chosen !== 'string') return;
		paths[tool] = chosen;
		savePath(tool);
	}

	function choosePreset(e: Event) {
		preset = (e.currentTarget as HTMLSelectElement).value as VideoPreset;
		updateSettings({ videoPreset: preset });
	}

	async function browseMedia(which: 'intro' | 'outro') {
		const chosen = await openFileDialog({
			multiple: false,
			directory: false,
			filters: [{ name: 'Video', extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v'] }]
		});
		if (typeof chosen !== 'string') return;
		if (which === 'intro') intro = chosen;
		else outro = chosen;
		saveMedia();
	}

	function saveMedia() {
		updateSettings({ videoIntroPath: intro.trim(), videoOutroPath: outro.trim() });
	}

	function describe(found: FoundBinary): string {
		const where =
			found.source === 'override' ? 'set here' : found.source === 'kdenlive' ? 'Kdenlive' : 'PATH';
		return `${found.version} (${where})`;
	}
</script>

<section class="settings-section">
	<h2>Video tools</h2>
	<label class="toggle-row">
		<input type="checkbox" bind:checked={enabled} onchange={toggle} />
		<span>Let the assistant edit videos</span>
	</label>
	<p class="help">In Chat with a folder picked, and in the Code tab.</p>
</section>

<section class="settings-section">
	<h2>Programs</h2>
	<div class="fields">
		{#each TOOLS as tool (tool)}
			<label for="video-{tool}">{tool}:</label>
			<div class="path-row">
				<input
					id="video-{tool}"
					type="text"
					placeholder="Find it"
					bind:value={paths[tool]}
					onblur={() => savePath(tool)}
				/>
				<button class="btn" type="button" onclick={() => void browse(tool)}>Browse…</button>
			</div>
			<span></span>
			{#if status?.[tool]}
				<span class="detail" title={status[tool]?.path}>{describe(status[tool]!)}</span>
			{:else if status}
				<span class="detail bad" title={LOOKED}>Not found</span>
			{:else}
				<span class="detail">{checking ? 'Looking…' : ''}</span>
			{/if}
		{/each}
	</div>
	{#if missing.length > 0}
		<p class="help" title={LOOKED}>Install Kdenlive, or set the paths above.</p>
	{/if}
	{#each status?.hints.filter((h) => !h.startsWith('Not found')) ?? [] as hint (hint)}
		<p class="help bad">{hint}</p>
	{/each}
	{#if error}<p class="help bad">{error}</p>{/if}
	<div class="actions">
		<button class="btn" type="button" onclick={() => void check()} disabled={checking}>
			{checking ? 'Checking…' : 'Check again'}
		</button>
	</div>
</section>

<section class="settings-section">
	<h2>Transcription</h2>
	<div class="fields">
		<span>Model:</span>
		<div class="path-row">
			<span
				class="detail"
				title="Transcribes footage for cutting by speech, chapters and captions. Voice input keeps its own model."
			>
				{turbo ? 'whisper large-v3-turbo' : 'whisper base.en (voice input’s)'}
			</span>
			{#if turbo}
				<button class="btn" type="button" onclick={() => void deleteTurbo()}>Delete</button>
			{:else if !downloading}
				<button class="btn" type="button" onclick={() => void downloadTurbo()}>
					Download large-v3-turbo (1.6 GB)
				</button>
			{/if}
		</div>
	</div>
	{#if downloading}
		<DownloadProgressBar progress={download} oncancel={() => void invoke('cancel_download')} />
	{/if}
	<p class="help">large-v3-turbo is more accurate and knows more languages.</p>
</section>

{#if googleAvailable}
	<section class="settings-section">
		<h2>YouTube</h2>
		<div class="path-row">
			{#if youtube}
				<span class="detail">Signed in as {youtube.email}</span>
				<button class="btn" type="button" onclick={() => void youtubeSignOut()}>Sign out</button>
			{:else}
				<button
					class="btn"
					type="button"
					disabled={signingIn}
					onclick={() => void youtubeSignIn()}
					title="Asks Google only for uploading videos: not reading, changing or deleting them."
				>
					{signingIn ? 'Waiting for Google…' : 'Sign in to YouTube'}
				</button>
			{/if}
		</div>
		<p class="help">Every upload asks you first.</p>
	</section>
{/if}

<section class="settings-section">
	<h2>New videos</h2>
	<div class="fields">
		<label for="video-preset">Format:</label>
		<select
			id="video-preset"
			value={preset}
			onchange={choosePreset}
			title="New projects are made in this format. The assistant can pick another for one video."
		>
			{#each VIDEO_PRESETS as p (p.id)}
				<option value={p.id}>{p.label}</option>
			{/each}
		</select>

		<label for="video-encoder">Encoder:</label>
		<div class="path-row">
			<select
				id="video-encoder"
				value={encoder}
				onchange={chooseEncoder}
				title="Hardware encoders are listed only when a test encode with them works."
			>
				{#if !encoderOptions.some((o) => o.id === encoder)}
					<option value={encoder}>{encoder}</option>
				{/if}
				{#each encoderOptions as o (o.id)}
					<option value={o.id}>{o.label}</option>
				{/each}
			</select>
			<button
				class="btn"
				type="button"
				disabled={testingEncoders || !status?.melt}
				onclick={() => void loadEncoders(true)}
			>
				{testingEncoders ? 'Testing…' : 'Retest'}
			</button>
		</div>

		<label for="video-intro">Intro:</label>
		<div class="path-row">
			<input
				id="video-intro"
				type="text"
				placeholder="None"
				bind:value={intro}
				onblur={saveMedia}
			/>
			<button class="btn" type="button" onclick={() => void browseMedia('intro')}>Browse…</button>
		</div>

		<label for="video-outro">Outro:</label>
		<div class="path-row">
			<input
				id="video-outro"
				type="text"
				placeholder="None"
				bind:value={outro}
				onblur={saveMedia}
			/>
			<button class="btn" type="button" onclick={() => void browseMedia('outro')}>Browse…</button>
		</div>
	</div>
	<p class="help" title="The only files outside the working folder the video tools may read.">
		Put on every video when you ask for them.
	</p>
</section>

<style>
	/* Label, then its control, one per line, as in Settings → Music. */
	.fields {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		align-items: center;
		gap: 8px 12px;
		margin-top: 8px;
	}

	.fields input,
	.fields select {
		width: 100%;
		min-width: 0;
	}

	.path-row {
		display: flex;
		gap: 8px;
		min-width: 0;
	}

	.actions {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: 6px;
	}

	.detail {
		font-size: 0.85em;
		color: var(--text-muted, #888);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.bad {
		color: var(--error, #c33);
	}
</style>
