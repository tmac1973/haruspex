import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '#lib/api.ts';
import {
	folderName,
	forkedFromTitle,
	groupByRoot,
	isUnsetTitle,
	lastActive,
	sessionLabel,
	sidebarEntries,
	turnsBefore,
	windowStart
} from './sessionList';

const s = (id: string, root: string, updated_at: number, forked_from: string | null = null) => ({
	id,
	title: id,
	root,
	updated_at,
	forked_from,
	read_only: false,
	worktree: null
});

describe('groupByRoot', () => {
	it('groups by folder, the folder with the newest session first, newest first inside', () => {
		const groups = groupByRoot([
			s('a1', '/p/alpha', 1),
			s('b1', '/p/blog', 5),
			s('a2', '/p/alpha', 3),
			s('a3', '/p/alpha', 7)
		]);
		expect(groups.map((g) => g.name)).toEqual(['alpha', 'blog']);
		expect(groups[0].sessions.map((x) => x.id)).toEqual(['a3', 'a2', 'a1']);
		expect(groups[0].root).toBe('/p/alpha');
	});

	it('names a folder by its last component', () => {
		expect(folderName('/home/me/blog/')).toBe('blog');
		expect(folderName('C:\\code\\site')).toBe('site');
	});
});

describe('sidebarEntries', () => {
	it('lists sessions flat, newest first, while each folder has one', () => {
		const entries = sidebarEntries([s('a', '/p/alpha', 1), s('b', '/p/blog', 5)]);
		expect(entries.map((e) => (e.kind === 'session' ? e.session.id : e.name))).toEqual(['b', 'a']);
	});

	it('groups a folder with two or more, placed by its newest session', () => {
		const entries = sidebarEntries([
			s('a1', '/p/alpha', 1),
			s('b1', '/p/blog', 5),
			s('a2', '/p/alpha', 3, 'a1'),
			s('c1', '/p/cli', 9)
		]);
		expect(entries.map((e) => e.kind)).toEqual(['session', 'session', 'folder']);
		const folder = entries[2];
		expect(folder.kind === 'folder' && folder.root).toBe('/p/alpha');
		expect(folder.kind === 'folder' && folder.sessions.map((x) => x.id)).toEqual(['a2', 'a1']);

		// A newer session moves the whole folder up.
		const again = sidebarEntries([
			s('a1', '/p/alpha', 1),
			s('a2', '/p/alpha', 10),
			s('c1', '/p/cli', 9)
		]);
		expect(again.map((e) => e.kind)).toEqual(['folder', 'session']);
	});
});

describe('session titles', () => {
	it('counts an empty title or a slash command as no title', () => {
		expect(isUnsetTitle('')).toBe(true);
		expect(isUnsetTitle('/init')).toBe(true);
		expect(isUnsetTitle('Fix the build')).toBe(false);
	});

	it('labels an unnamed session by its folder', () => {
		expect(sessionLabel({ title: '', root: '/p/blog' })).toBe('blog · new session');
		expect(sessionLabel({ title: '/init', root: '/p/blog' })).toBe('blog · new session');
		expect(sessionLabel({ title: 'New post', root: '/p/blog' })).toBe('New post');
	});

	it('says when a session was last active', () => {
		const now = 1_000_000_000_000;
		expect(lastActive(now - 10_000, now)).toBe('just now');
		expect(lastActive(now - 5 * 60_000, now)).toBe('5m ago');
		expect(lastActive(now - 3 * 3_600_000, now)).toBe('3h ago');
		expect(lastActive(now - 2 * 86_400_000, now)).toBe('2d ago');
	});
});

describe('the render window', () => {
	const thread: ChatMessage[] = [];
	for (let t = 0; t < 5; t++) {
		thread.push({ role: 'user', content: `q${t}` });
		thread.push({ role: 'assistant', content: `a${t}` });
	}

	it('starts at the user message that opens the last N turns', () => {
		expect(windowStart(thread, 2)).toBe(6);
		expect(turnsBefore(thread, 6)).toBe(3);
	});

	it('shows everything when the thread is shorter than the window', () => {
		expect(windowStart(thread, 20)).toBe(0);
		expect(turnsBefore(thread, 0)).toBe(0);
	});
});

describe('forkedFromTitle', () => {
	it('names the source, or says it was deleted', () => {
		const list = [s('a', '/p/app', 1), { ...s('', '/p/app', 2), id: 'b' }];
		expect(forkedFromTitle({ forked_from: 'a' }, list)).toBe('Forked from "a"');
		expect(forkedFromTitle({ forked_from: 'b' }, list)).toBe('Forked from "app · new session"');
		expect(forkedFromTitle({ forked_from: 'gone' }, list)).toBe('Forked from a deleted session');
		expect(forkedFromTitle({ forked_from: null }, list)).toBe('');
	});
});
