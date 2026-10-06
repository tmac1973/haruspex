<script lang="ts">
	/**
	 * An interactive Python artifact (plotly, bokeh, altair, folium output),
	 * loaded from the `haruspex-artifact:` scheme rather than `srcdoc`.
	 *
	 * A `srcdoc` document inherits the app window's Content Security Policy,
	 * so the window had to allow every inline and CDN script a plot might
	 * carry. From its own scheme the document arrives with its own policy and
	 * the window's stays strict; see `src-tauri/src/artifact_frame.rs`.
	 * `sandbox="allow-scripts"` without `allow-same-origin` keeps it in an
	 * opaque origin that can reach neither the app nor IPC.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import { artifactUrl } from '#lib/sandbox/artifactUrl.ts';

	let { html }: { html: string } = $props();

	let src = $state<string | null>(null);
	let failed = $state(false);

	$effect(() => {
		const doc = html;
		let stale = false;
		src = null;
		failed = false;
		invoke<string>('artifact_register', { html: doc })
			.then((id) => {
				if (!stale) src = artifactUrl(id);
			})
			.catch(() => {
				if (!stale) failed = true;
			});
		return () => {
			stale = true;
		};
	});
</script>

{#if src}
	<iframe class="artifact-iframe" {src} sandbox="allow-scripts" title="interactive plot"></iframe>
{:else if failed}
	<div class="artifact-failed">The plot could not be displayed.</div>
{/if}

<style>
	.artifact-iframe {
		width: 100%;
		height: 480px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: white;
	}

	.artifact-failed {
		border: 1px solid var(--error-border, #c97);
		border-radius: 6px;
		padding: 10px 12px;
		font-size: 0.82rem;
		color: var(--error-text, #c97);
		background: var(--error-bg, rgba(204, 153, 119, 0.08));
	}
</style>
