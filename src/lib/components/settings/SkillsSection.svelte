<script lang="ts">
	/**
	 * Settings → Skills: what skills exist, which are on, where they come
	 * from, and which repos' instructions the assistant may use.
	 *
	 * The list is read from disk every time the section opens (and after any
	 * change here), so a skill dropped into a folder shows up without a
	 * restart. Project skills aren't listed: they belong to a repo, and show
	 * up in that repo's Code mode turns once it is trusted.
	 */
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { open as openFolderDialog } from '@tauri-apps/plugin-dialog';
	import CodeEditor from '#lib/components/CodeEditor.svelte';
	import type { SkillSummary } from '#lib/ipc/gen/SkillSummary.ts';
	import type { SkillSource } from '#lib/ipc/gen/SkillSource.ts';
	import { listSkills, readSkill } from '#lib/skills/client.ts';
	import { getSettings, updateSkills, type SkillsConfig } from '#lib/stores/settings.ts';
	import { errMessage } from '#lib/utils/error.ts';

	const CLAUDE_SKILLS = '~/.claude/skills';

	const SOURCE_LABEL: Record<SkillSource, string> = {
		builtin: 'Built in',
		extra: 'Added folder',
		shared: '~/.agents/skills',
		user: 'Haruspex',
		project: 'Project'
	};

	let config = $state<SkillsConfig>(structuredClone(getSettings().skills));
	let skills = $state<SkillSummary[]>([]);
	let loadError = $state<string | null>(null);
	let viewing = $state<{ name: string; body: string } | null>(null);

	async function refresh() {
		try {
			skills = await listSkills(null);
			loadError = null;
		} catch (e) {
			loadError = errMessage(e);
		}
	}

	onMount(() => {
		void refresh();
	});

	function save(partial: Partial<SkillsConfig>) {
		updateSkills(partial);
		config = structuredClone(getSettings().skills);
	}

	function setEnabled(name: string, enabled: boolean) {
		const disabled = config.disabled.filter((n) => n !== name);
		save({ disabled: enabled ? disabled : [...disabled, name] });
	}

	async function view(name: string) {
		if (viewing?.name === name) {
			viewing = null;
			return;
		}
		try {
			const doc = await readSkill(name);
			viewing = { name, body: doc.body };
		} catch (e) {
			loadError = errMessage(e);
		}
	}

	async function openFolder(path: string) {
		try {
			await invoke('open_folder', { path });
		} catch (e) {
			loadError = errMessage(e);
		}
	}

	async function openUserFolder() {
		try {
			await openFolder(await invoke<string>('skills_user_dir'));
		} catch (e) {
			loadError = errMessage(e);
		}
	}

	async function remove(name: string) {
		if (!confirm(`Delete the "${name}" skill? Its folder is removed from disk.`)) return;
		try {
			await invoke('skill_delete_user', { name });
			save({ disabled: config.disabled.filter((n) => n !== name) });
			if (viewing?.name === name) viewing = null;
			await refresh();
		} catch (e) {
			loadError = errMessage(e);
		}
	}

	async function addFolder(path?: string) {
		const chosen = path ?? (await openFolderDialog({ directory: true, multiple: false }));
		if (typeof chosen !== 'string' || config.extraDirs.includes(chosen)) return;
		save({ extraDirs: [...config.extraDirs, chosen] });
		await refresh();
	}

	async function removeFolder(path: string) {
		save({ extraDirs: config.extraDirs.filter((d) => d !== path) });
		await refresh();
	}

	function setTrust(root: string, trusted: boolean | null) {
		const trustedRepos = { ...config.trustedRepos };
		if (trusted === null) delete trustedRepos[root];
		else trustedRepos[root] = trusted;
		save({ trustedRepos });
	}

	const repos = $derived(
		Object.entries(config.trustedRepos).sort(([a], [b]) => a.localeCompare(b))
	);
</script>

<section class="settings-section">
	<h2>When the model uses skills</h2>
	<select
		value={config.autonomous}
		onchange={(e) => save({ autonomous: e.currentTarget.value as SkillsConfig['autonomous'] })}
		title="Automatic lets remote and OpenRouter models pick skills by themselves. Small local models follow that poorly, so they don't."
	>
		<option value="auto">Automatic (remote models only)</option>
		<option value="on">Always</option>
		<option value="off">Never</option>
	</select>
	<p class="help">Lets the model see your skills and load one when a request matches.</p>
</section>

<section class="settings-section">
	<h2>Skills</h2>
	<p class="help">
		Folders with a <code>SKILL.md</code>, in the
		<span title="The Agent Skills format (agentskills.io), shared with other AI tools."
			>open format</span
		>.
	</p>
	<div class="actions">
		<button class="btn btn-small" onclick={openUserFolder}>Open skills folder</button>
		<button class="btn btn-small" onclick={refresh}>Refresh</button>
	</div>
	{#if loadError}
		<p class="error-text">{loadError}</p>
	{/if}
	{#if skills.length === 0}
		<p class="hint">No skills yet.</p>
	{:else}
		<ul class="skill-list">
			{#each skills as skill (skill.source + ':' + (skill.dir ?? skill.name))}
				{@const enabled = !config.disabled.includes(skill.name)}
				<li class="skill" class:muted={!!skill.error || skill.shadowed}>
					<div class="skill-head">
						<label class="toggle">
							<input
								type="checkbox"
								checked={enabled && !skill.error && !skill.shadowed}
								disabled={!!skill.error || skill.shadowed}
								onchange={(e) => setEnabled(skill.name, e.currentTarget.checked)}
							/>
							<span class="name">{skill.name}</span>
						</label>
						<span class="badge">{SOURCE_LABEL[skill.source]}</span>
						{#if skill.createdByModel}
							<span class="badge">Written by the model</span>
						{/if}
						{#if skill.shadowed}
							<span class="badge" title="Another skill with this name takes precedence."
								>Overridden</span
							>
						{/if}
						<span class="spacer"></span>
						{#if !skill.error && !skill.shadowed}
							<button class="btn btn-small" onclick={() => view(skill.name)}>
								{viewing?.name === skill.name ? 'Hide' : 'View'}
							</button>
						{/if}
						{#if skill.dir}
							<button class="btn btn-small" onclick={() => openFolder(skill.dir!)}>Folder</button>
						{/if}
						{#if skill.source === 'user'}
							<button class="btn btn-danger btn-small" onclick={() => remove(skill.name)}
								>Delete</button
							>
						{/if}
					</div>
					{#if skill.error}
						<p class="error-text">Not usable: {skill.error}.</p>
					{:else}
						<p class="description">{skill.description}</p>
					{/if}
					{#each skill.warnings as warning (warning)}
						<p class="warning">{warning}</p>
					{/each}
					{#if viewing?.name === skill.name}
						<div class="viewer">
							<CodeEditor value={viewing.body} readonly label="{skill.name} instructions" />
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>

<section class="settings-section">
	<h2>Other skill folders</h2>
	<p class="help">Also read skills from these folders.</p>
	{#if config.extraDirs.length > 0}
		<ul class="plain-list">
			{#each config.extraDirs as dir (dir)}
				<li>
					<code>{dir}</code>
					<button class="btn btn-small" onclick={() => removeFolder(dir)}>Remove</button>
				</li>
			{/each}
		</ul>
	{/if}
	<div class="actions">
		<button class="btn btn-small" onclick={() => addFolder()}>Add folder…</button>
		{#if !config.extraDirs.includes(CLAUDE_SKILLS)}
			<button
				class="btn btn-small"
				onclick={() => addFolder(CLAUDE_SKILLS)}
				title="Skills installed for Claude Code. Some may expect Claude Code's own tools."
				>Add {CLAUDE_SKILLS}</button
			>
		{/if}
	</div>
</section>

<section class="settings-section">
	<h2>Repos</h2>
	<p class="help">Whether Code mode uses a repo's own skills.</p>
	{#if repos.length === 0}
		<p class="hint">You'll be asked the first time a repo has any.</p>
	{:else}
		<ul class="plain-list">
			{#each repos as [root, trusted] (root)}
				<li>
					<code>{root}</code>
					<select
						value={trusted ? 'use' : 'ignore'}
						onchange={(e) => setTrust(root, e.currentTarget.value === 'use')}
					>
						<option value="use">Use</option>
						<option value="ignore">Ignore</option>
					</select>
					<button
						class="btn btn-small"
						onclick={() => setTrust(root, null)}
						title="Ask again next time.">Forget</button
					>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.actions {
		display: flex;
		gap: 0.5rem;
		margin: 0.5rem 0;
	}

	.skill-list,
	.plain-list {
		list-style: none;
		margin: 0.5rem 0 0;
		padding: 0;
	}

	.skill {
		padding: 0.6rem 0;
		border-top: 1px solid var(--border);
	}

	.skill.muted .name,
	.skill.muted .description {
		color: var(--text-secondary);
	}

	.skill-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.toggle {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}

	.name {
		font-family: monospace;
		font-weight: 600;
	}

	.badge {
		padding: 1px 6px;
		border-radius: 4px;
		font-size: 0.72rem;
		background: var(--bg-secondary);
		color: var(--text-secondary);
	}

	.spacer {
		flex: 1;
	}

	.description,
	.warning,
	.error-text {
		margin: 0.25rem 0 0 1.6rem;
		font-size: 0.85rem;
	}

	.warning {
		color: var(--text-secondary);
		font-size: 0.78rem;
	}

	.viewer {
		margin: 0.5rem 0 0 1.6rem;
		height: 280px;
	}

	.plain-list li {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.3rem 0;
	}

	.plain-list code {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
