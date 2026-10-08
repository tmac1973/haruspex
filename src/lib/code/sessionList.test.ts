import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '#lib/api.ts';
import { folderName, groupByRoot, turnsBefore, windowStart } from './sessionList';

const s = (id: string, root: string, updated_at: number) => ({
	id,
	title: id,
	root,
	updated_at,
	forked_from: null
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
