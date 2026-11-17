import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
const git = vi.hoisted(() => ({ gitStatus: vi.fn(async (): Promise<unknown> => null) }));
vi.mock('#lib/code/git.ts', () => git);
const store = vi.hoisted(() => ({
	newSession: vi.fn(async (root: string) => ({ root, wslDistro: null }))
}));
vi.mock('#lib/stores/code.svelte.ts', () => store);
const settings = vi.hoisted(() => ({
	values: { codeLastRoot: '/work', codeLastWslDistro: '', codeNewWorktree: false },
	getSettings: vi.fn(() => settings.values),
	updateSettings: vi.fn()
}));
vi.mock('#lib/stores/settings.ts', () => settings);
vi.mock('#lib/code/db.ts', () => ({
	resolveCodeFolder: vi.fn(),
	wslDistros: vi.fn(async () => [])
}));

// Another computer, connected, with two sessions in one folder and one in another.
const peers = vi.hoisted(() => ({
	list: [] as unknown[],
	startRemoteSession: vi.fn(async () => ({}))
}));
vi.mock('#lib/peers/store.svelte.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/peers/store.svelte.ts')>()),
	peerViews: () => peers.list
}));
vi.mock('#lib/peers/remoteCodeSession.svelte.ts', () => ({
	startRemoteSession: peers.startRemoteSession
}));

import NewSessionDialog from './NewSessionDialog.svelte';

function desk() {
	return {
		id: 'desk',
		config: { name: 'desk-pc' },
		online: true,
		client: {
			lean: false,
			sessions: [
				{ id: 's1', root: '/srv/api', updatedAt: 5 },
				{ id: 's2', root: '/srv/web', updatedAt: 9 },
				{ id: 's3', root: '/srv/api', updatedAt: 7 }
			],
			op: vi.fn(async () => ['Ubuntu'])
		}
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	peers.list = [];
	// clearAllMocks keeps the repository a worktree test set up.
	git.gitStatus.mockResolvedValue(null);
	settings.values = { codeLastRoot: '/work', codeLastWslDistro: '', codeNewWorktree: false };
});

describe('NewSessionDialog', () => {
	it('offers no worktree outside a git repository', async () => {
		render(NewSessionDialog, { open: true, onclose: vi.fn() });
		await waitFor(() => expect(git.gitStatus).toHaveBeenCalledWith('/work', null));
		expect(screen.queryByLabelText('Work in a new worktree')).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
		expect(store.newSession).toHaveBeenCalledWith('/work', { wslDistro: null, worktree: false });
		// The remembered choice is left alone when it wasn't offered.
		expect(settings.updateSettings).toHaveBeenCalledWith({
			codeLastRoot: '/work',
			codeLastWslDistro: ''
		});
	});

	it('starts in a worktree when ticked, and remembers the choice and the repository', async () => {
		git.gitStatus.mockResolvedValue({ branch: 'main' });
		store.newSession.mockResolvedValueOnce({
			root: '/work-worktrees/session',
			wslDistro: null
		});
		render(NewSessionDialog, { open: true, onclose: vi.fn() });
		const box = (await screen.findByLabelText('Work in a new worktree')) as HTMLInputElement;
		expect(box.checked).toBe(false);
		await fireEvent.click(box);
		await fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
		expect(store.newSession).toHaveBeenCalledWith('/work', { wslDistro: null, worktree: true });
		expect(settings.updateSettings).toHaveBeenCalledWith({
			codeLastRoot: '/work',
			codeLastWslDistro: '',
			codeNewWorktree: true
		});
	});

	it('starts ticked when the last session used a worktree', async () => {
		git.gitStatus.mockResolvedValue({ branch: 'main' });
		settings.values = { ...settings.values, codeNewWorktree: true };
		render(NewSessionDialog, { open: true, onclose: vi.fn() });
		const box = (await screen.findByLabelText('Work in a new worktree')) as HTMLInputElement;
		expect(box.checked).toBe(true);
	});

	it('offers no Where without another computer to run on', () => {
		render(NewSessionDialog, { open: true, onclose: vi.fn() });
		expect(screen.queryByLabelText('Where')).toBeNull();
	});

	it('starts a session on another computer, from its recent folders', async () => {
		const peer = desk();
		peers.list = [peer];
		const onclose = vi.fn();
		render(NewSessionDialog, { open: true, onclose });
		await fireEvent.change(screen.getByLabelText('Where'), { target: { value: 'desk' } });
		const folder = (await screen.findByLabelText('Folder on desk-pc')) as HTMLInputElement;
		// Its most recent folder first, each once.
		expect(folder.value).toBe('/srv/web');
		const offered = [...document.querySelectorAll('#peer-recent-roots option')].map(
			(o) => (o as HTMLOptionElement).value
		);
		expect(offered).toEqual(['/srv/web', '/srv/api']);
		// Its WSL distros, from it.
		await screen.findByRole('option', { name: 'Ubuntu' });
		expect(peer.client.op).toHaveBeenCalledWith({ type: 'wsl.distros' });

		await fireEvent.input(folder, { target: { value: '/srv/api' } });
		await fireEvent.click(screen.getByLabelText('Work in a new worktree'));
		await fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
		await waitFor(() => expect(onclose).toHaveBeenCalled());
		expect(peers.startRemoteSession).toHaveBeenCalledWith(peer, {
			root: '/srv/api',
			worktree: true,
			wslDistro: null
		});
		expect(store.newSession).not.toHaveBeenCalled();
	});
});
