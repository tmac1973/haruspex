import { test, expect, useScenario } from './fixtures';

test.use({
	settings: { codeLastRoot: '/e2e/project' },
	// The Code tab is hidden on Windows, and Playwright's desktop Chrome says
	// it is Windows.
	userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome'
});

test('a Code session edits a file and runs a command, shown as cards', async ({ app }) => {
	await useScenario('code-tab');
	await app.getByRole('tab', { name: 'Code' }).click();

	// The new-session dialog starts from the last folder used.
	await app.getByRole('button', { name: 'New session' }).first().click();
	await expect(app.getByText('/e2e/project')).toBeVisible();
	await app.getByRole('button', { name: 'Start session' }).click();
	await expect(app.getByRole('tab', { name: /project · new session/ })).toBeVisible();

	const input = app.getByRole('textbox', { name: 'Message' });
	await input.fill('fix the readme typo');
	await input.press('Enter');

	const transcript = app.getByTestId('code-transcript');
	await expect(transcript.getByText('Fixed the typo in README.md.')).toBeVisible({
		timeout: 15_000
	});
	const diff = transcript.getByTestId('diff-card');
	await expect(diff).toContainText('README.md');
	await expect(diff).toContainText('# Hello');
	const command = transcript.getByTestId('command-card');
	await expect(command).toContainText('cat README.md');
	await expect(command).toContainText('exit 0');

	// The model names the session after its first turn; the sidebar row shows
	// the folder underneath, and the tab takes the name too.
	const sidebar = app.getByRole('complementary', { name: 'Code sessions' });
	const row = sidebar.getByRole('button', { name: 'Fix README typo' });
	await expect(row).toBeVisible();
	await expect(row).toContainText(/project · /);
	await expect(app.getByRole('tab', { name: /Fix README typo/ })).toBeVisible();

	// Open in Shell types the command into a new Shell tab, and shows it.
	await command.getByRole('button', { name: 'Open in Shell' }).click();
	await expect(app.getByRole('tab', { name: 'Shell', exact: true })).toHaveAttribute(
		'aria-selected',
		'true'
	);
	// Typed at the prompt as a bracketed paste, with no Enter after it.
	await expect
		.poll(() =>
			app.evaluate(() =>
				window.__e2e!.calls.filter((c) => c.cmd === 'shell_write').map((c) => c.args?.data)
			)
		)
		.toContain('\x1b[200~cat README.md\x1b[201~');
});

test('forking from a message opens a new session as a sub-tab', async ({ app }) => {
	await useScenario('code-tab');
	await app.getByRole('tab', { name: 'Code' }).click();
	await app.getByRole('button', { name: 'New session' }).first().click();
	await app.getByRole('button', { name: 'Start session' }).click();

	const input = app.getByRole('textbox', { name: 'Message' });
	await input.fill('fix the readme typo');
	await input.press('Enter');
	const transcript = app.getByTestId('code-transcript');
	await expect(transcript.getByText('Fixed the typo in README.md.')).toBeVisible({
		timeout: 15_000
	});
	await expect(app.getByRole('tab', { name: /Fix README typo/ })).toBeVisible();

	// The project is a git repository, so the fork can have its own worktree.
	await expect(app.getByRole('button', { name: /^Branch main/ })).toBeVisible();

	// Forking the question: an empty fork with the question back in its box.
	await transcript.getByRole('button', { name: 'Fork from here' }).first().click();
	await app.getByRole('button', { name: /New worktree/ }).click();
	const forkTab = app.getByRole('tab', { name: /Fix README typo \(fork\)/ });
	await expect(forkTab).toHaveAttribute('aria-selected', 'true');
	const forkInput = app.getByRole('textbox', { name: 'Message' }).locator('visible=true');
	await expect(forkInput).toHaveValue('fix the readme typo');
	await expect(forkInput).toBeFocused();

	// The sidebar marks it as a fork, and says of what.
	const sidebar = app.getByRole('complementary', { name: 'Code sessions' });
	const row = sidebar.getByRole('button', { name: 'Fix README typo (fork)' });
	await expect(row.getByTestId('fork-glyph')).toBeVisible();
	await expect(row).toHaveAttribute('title', /Forked from "Fix README typo"/);

	// It works in a worktree beside the project, on a branch of its own.
	await expect(
		app.getByRole('button', { name: /^Branch fix-readme-typo-fork/ }).locator('visible=true')
	).toBeVisible();
	await expect(row).toHaveAttribute('title', /project-worktrees\/fix-readme-typo-fork/);
	const fork = await app.evaluate(() =>
		window.__e2e!.calls.find((c) => c.cmd === 'code_session_fork')
	);
	expect(fork?.args?.mode).toBe('worktree');
});

test('a read-only fork says so in its header', async ({ app }) => {
	await useScenario('code-tab');
	await app.getByRole('tab', { name: 'Code' }).click();
	await app.getByRole('button', { name: 'New session' }).first().click();
	await app.getByRole('button', { name: 'Start session' }).click();

	const input = app.getByRole('textbox', { name: 'Message' });
	await input.fill('fix the readme typo');
	await input.press('Enter');
	const transcript = app.getByTestId('code-transcript');
	await expect(transcript.getByText('Fixed the typo in README.md.')).toBeVisible({
		timeout: 15_000
	});
	await expect(app.getByTestId('read-only-badge')).toHaveCount(0);

	await transcript.getByRole('button', { name: 'Fork from here' }).last().click();
	await app.getByRole('button', { name: /Same folder, read-only/ }).click();
	await expect(app.getByRole('tab', { name: /Fix README typo \(fork\)/ })).toHaveAttribute(
		'aria-selected',
		'true'
	);
	await expect(app.getByTestId('read-only-badge').locator('visible=true')).toBeVisible();
});

test('the branch control switches branch, and waits while there are changes', async ({ app }) => {
	await app.getByRole('tab', { name: 'Code' }).click();
	await app.getByRole('button', { name: 'New session' }).first().click();
	await app.getByRole('button', { name: 'Start session' }).click();

	await app.getByRole('button', { name: /^Branch main/ }).click();
	const menu = app.getByTestId('branch-menu');
	await menu.getByRole('menuitem', { name: 'feature' }).click();
	await expect(app.getByRole('button', { name: /^Branch feature/ })).toBeVisible();

	// Uncommitted changes: the ● shows, and switching says why it can't.
	await app.evaluate(() =>
		window.__e2e!.mock('code_git_status', {
			repo_root: '/e2e/project',
			branch: 'feature',
			head: 'abc1234',
			changed: 2,
			untracked: 0,
			linked_worktree: false
		})
	);
	await app.getByRole('button', { name: /^Branch feature/ }).click();
	await expect(app.getByTestId('dirty-marker')).toBeVisible();
	await expect(menu).toContainText('commit or stash first');
	await expect(menu.getByRole('menuitem', { name: 'main' })).toBeDisabled();
});

test('a session whose folder is gone says so, and can be pointed at another', async ({ app }) => {
	await useScenario('code-tab');
	await app.getByRole('tab', { name: 'Code' }).click();
	await app.getByRole('button', { name: 'New session' }).first().click();
	await app.getByRole('button', { name: 'Start session' }).click();
	const input = app.getByRole('textbox', { name: 'Message' });
	await expect(input).toBeEnabled();

	// The folder goes while the app is in the background; coming back looks again.
	await app.evaluate(() => {
		window.__e2e!.mock('code_folder_exists', false);
		window.dispatchEvent(new Event('focus'));
	});
	const banner = app.getByRole('alert').filter({ hasText: 'Folder not found' });
	await expect(banner).toContainText('Folder not found: /e2e/project');
	await expect(input).toBeDisabled();
	await expect(input).toHaveAttribute('placeholder', 'Folder not found: /e2e/project');
	await expect(banner.getByRole('button', { name: /create/i })).toHaveCount(0);

	// Choose folder… asks, then the session works in the new one.
	await app.evaluate(() => {
		window.__e2e!.mock('code_folder_exists', true);
		window.__e2e!.mock('plugin:dialog|open', '/e2e/elsewhere');
	});
	await banner.getByRole('button', { name: 'Choose folder…' }).click();
	await expect(app.getByText('Use this folder?')).toBeVisible();
	await app.getByRole('button', { name: 'Use folder' }).click();
	await expect(banner).toHaveCount(0);
	await expect(input).toBeEnabled();
	expect(
		await app.evaluate(
			() => window.__e2e!.calls.find((c) => c.cmd === 'code_session_set_root')?.args
		)
	).toMatchObject({ root: '/e2e/elsewhere' });
});
