<script lang="ts">
	import { getSettings, updateSettings } from '$lib/stores/settings';

	let shellBinary = $state(getSettings().shellBinary);
	let shellSidebarDefaultOpen = $state(getSettings().shellSidebarDefaultOpen);
	let shellAllowWrite = $state(getSettings().shellAllowWrite);

	function persistBinary() {
		updateSettings({ shellBinary: shellBinary.trim() });
	}

	function persistSidebarDefault() {
		updateSettings({ shellSidebarDefaultOpen });
	}

	function persistAllowWrite() {
		updateSettings({ shellAllowWrite });
	}
</script>

<section class="card">
	<h3>Shell binary</h3>
	<p class="help">
		The Shell tab spawns this program for the interactive terminal. Leave blank to use your
		<code>$SHELL</code>
		(falling back to <code>/bin/bash</code> if unset). Override with an absolute path to launch a
		different shell — e.g. <code>/usr/bin/fish</code> or <code>/usr/bin/nu</code>. Bash and zsh get
		the OSC 133 shell-integration hooks; other shells still work as terminals but lose the
		smart-default capture (use mouse selection instead).
	</p>
	<input
		type="text"
		placeholder="(auto-detect $SHELL)"
		bind:value={shellBinary}
		onblur={persistBinary}
		onkeydown={(e) => e.key === 'Enter' && persistBinary()}
	/>
	<p class="hint">Takes effect the next time you open the Shell tab or restart the app.</p>
</section>

<section class="card danger" class:enabled={shellAllowWrite}>
	<h3>Allow the assistant to write files</h3>
	<label class="row">
		<input type="checkbox" bind:checked={shellAllowWrite} onchange={persistAllowWrite} />
		<span>Enable <code>fs_write_text</code> and <code>fs_edit_text</code> in Shell mode</span>
	</label>
	<p class="help">
		When on, the Shell-tab assistant can write or edit any file the app's user account can write to
		— including system files under <code>/etc</code>, <code>/var</code>, and similar. Off by
		default. The model still won't execute shell commands directly; it just gains the ability to
		modify file contents on its own when it judges that the right fix. Reads are always allowed
		regardless of this setting.
	</p>
</section>

<section class="card">
	<h3>Assistant sidebar</h3>
	<label class="row">
		<input
			type="checkbox"
			bind:checked={shellSidebarDefaultOpen}
			onchange={persistSidebarDefault}
		/>
		<span>Open the assistant sidebar by default when opening the Shell tab</span>
	</label>
	<p class="help">
		When off (default), the sidebar stays collapsed to a thin rail until you click it open or click
		Submit to LLM in the terminal toolbar.
	</p>
</section>

<style>
	.card {
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 16px;
		margin-bottom: 16px;
	}

	.card.danger.enabled {
		border-color: var(--error-text, #c66);
	}

	.card h3 {
		margin: 0 0 8px;
		font-size: 0.95rem;
		font-weight: 600;
	}

	.help {
		color: var(--text-secondary);
		font-size: 0.85rem;
		line-height: 1.45;
		margin: 0 0 12px;
	}

	.hint {
		color: var(--text-secondary);
		font-size: 0.78rem;
		margin: 6px 0 0;
		font-style: italic;
	}

	code {
		background: var(--bg-primary);
		padding: 1px 6px;
		border-radius: 4px;
		font-size: 0.85em;
	}

	input[type='text'] {
		width: 100%;
		padding: 8px 10px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-primary);
		color: var(--text-primary);
		font-family: ui-monospace, Menlo, Monaco, 'Cascadia Mono', 'Courier New', monospace;
		font-size: 0.85rem;
		outline: none;
		box-sizing: border-box;
	}

	input[type='text']:focus {
		border-color: var(--accent);
	}

	.row {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.9rem;
	}
</style>
