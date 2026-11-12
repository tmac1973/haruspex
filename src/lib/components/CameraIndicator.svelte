<script lang="ts">
	/**
	 * The header's sign that a camera is in use: shown while any camera tool is
	 * taking a picture or listening (`stores/cameraActivity.svelte.ts`), with
	 * the cameras' names. Clicking it opens Settings → Cameras.
	 */
	import { getLiveSettings } from '#lib/stores/settings.ts';
	import { openSettings } from '#lib/stores/settingsNav.svelte.ts';
	import { activeCameraUses, type CameraActivityKind } from '#lib/stores/cameraActivity.svelte.ts';

	const DOING: Record<CameraActivityKind, string> = {
		look: 'taking a picture',
		listen: 'listening',
		move: 'moving',
		watch: 'watching'
	};

	const uses = $derived(activeCameraUses());
	const nameOf = (id: string) => getLiveSettings().cameras.find((c) => c.id === id)?.name ?? id;
	const names = $derived([...new Set(uses.map((u) => nameOf(u.cameraId)))]);
	const tooltip = $derived(uses.map((u) => `${nameOf(u.cameraId)}: ${DOING[u.kind]}`).join('\n'));
</script>

{#if names.length > 0}
	<button
		class="camera-badge"
		title={tooltip}
		aria-label={`Camera in use: ${names.join(', ')}`}
		onclick={() => openSettings('cameras')}
	>
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"
			></path>
			<circle cx="12" cy="13" r="4"></circle>
		</svg>
		{names.join(', ')}
	</button>
{/if}

<style>
	.camera-badge {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 4px 10px;
		border: 1px solid color-mix(in srgb, var(--error-text) 45%, transparent);
		border-radius: 12px;
		font-family: inherit;
		font-size: 0.8rem;
		font-weight: 500;
		color: var(--error-text);
		background: color-mix(in srgb, var(--error-text) 10%, var(--bg-secondary));
		cursor: pointer;
		white-space: nowrap;
		max-width: 16rem;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.camera-badge:hover {
		background: color-mix(in srgb, var(--error-text) 18%, var(--bg-secondary));
	}
</style>
