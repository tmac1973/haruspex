<script lang="ts">
	import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
	import { errMessage } from '#lib/utils/error.ts';
	import { getSettings, updateSettings } from '#lib/stores/settings.ts';
	import { refreshVideoBinaries, videoBinariesStatus } from '#lib/video/binaries.ts';
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
	let preset = $state<VideoPreset>(getSettings().videoPreset);
	let intro = $state(getSettings().videoIntroPath);
	let outro = $state(getSettings().videoOutroPath);

	let status = $state<VideoBinariesStatus | null>(videoBinariesStatus());
	let checking = $state(false);
	let error = $state('');

	const missing = $derived(status ? TOOLS.filter((t) => !status?.[t]) : []);

	async function check() {
		checking = true;
		error = '';
		try {
			status = await refreshVideoBinaries();
		} catch (e) {
			error = errMessage(e);
		} finally {
			checking = false;
		}
	}
	void check();

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
	{:else if status}
		<p class="help">Video tools are on in Chat and the Code tab when a folder is picked.</p>
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
