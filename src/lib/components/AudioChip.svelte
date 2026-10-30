<script lang="ts">
	/** An audio file attached to a composer's next message, with a remove button. */
	let { name, onRemove }: { name: string; onRemove: () => void } = $props();
</script>

<div class="audio-chip" title="Music tools can use this file as a source.">
	<span class="note" aria-hidden="true">♪</span>
	<span class="name">{name}</span>
	<button class="remove" title="Remove audio" aria-label="Remove {name}" onclick={onRemove}
		>×</button
	>
</div>

<style>
	.audio-chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		max-width: 240px;
		height: 32px;
		padding: 0 4px 0 10px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-secondary);
		font-size: 0.8rem;
	}
	.name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.remove {
		border: none;
		background: none;
		color: var(--text-secondary);
		cursor: pointer;
		font-size: 1rem;
		line-height: 1;
		padding: 2px 4px;
	}
	.remove:hover {
		color: var(--text-primary);
	}
</style>
