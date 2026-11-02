import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
	newConversationWithDraft: vi.fn(() => 'c1'),
	setActiveTab: vi.fn(),
	sendMessage: vi.fn()
}));
vi.mock('#lib/stores/chat.svelte.ts', () => ({
	newConversationWithDraft: m.newConversationWithDraft,
	sendMessage: m.sendMessage
}));
vi.mock('#lib/stores/activeTab.svelte.ts', () => ({ setActiveTab: m.setActiveTab }));

import { askAbout, askAboutText } from './askAbout';

beforeEach(() => vi.clearAllMocks());

describe('askAboutText', () => {
	it('quotes what the email card knows, with the message handle for the email tools', () => {
		const text = askAboutText('Important emails', {
			kind: 'email',
			item: {
				id: 'w|7:1',
				why: 'Money owed',
				source: {
					accountId: 'w',
					messageId: '7:1',
					from: 'Dana <dana@example.com>',
					subject: 'Invoice overdue',
					date: '2026-11-02T08:00:00Z',
					snippet: 'Please pay by Friday.'
				}
			}
		});
		expect(text).toBe(
			'From my Important emails card on Home:\n\n' +
				'> From: Dana <dana@example.com>\n' +
				'> Subject: Invoice overdue\n' +
				'> Date: 2026-11-02T08:00:00Z\n' +
				'> Message: 7:1 (account w)\n' +
				'> Please pay by Friday.\n\n'
		);
	});

	it('quotes a meeting, leaving out what it lacks', () => {
		const text = askAboutText('Upcoming meetings', {
			kind: 'meeting',
			item: {
				uid: 'u',
				accountId: 'a',
				summary: 'Standup',
				start: '2026-11-02T09:00:00-04:00',
				end: '2026-11-02T09:15:00-04:00',
				allDay: false,
				location: null,
				organizer: 'pat@example.com',
				attendees: ['sam@example.com'],
				joinUrl: null
			}
		});
		expect(text).toContain('> Standup\n> 2026-11-02T09:00:00-04:00 – 2026-11-02T09:15:00-04:00');
		expect(text).toContain('> Organizer: pat@example.com\n> With: sam@example.com');
		expect(text).not.toContain('Where:');
	});

	it('quotes a story with its source and link', () => {
		const text = askAboutText('News', {
			kind: 'news',
			item: {
				id: 'n',
				summary: 'A rocket went up.',
				source: {
					title: 'Launch',
					link: 'https://x/launch',
					source: 'Space News',
					published: null,
					excerpt: ''
				}
			}
		});
		expect(text).toContain('> Launch\n> Space News: https://x/launch\n> A rocket went up.');
	});
});

describe('askAboutText for GitHub', () => {
	it('quotes the issue by repo and number, with its link', () => {
		const text = askAboutText('Issues from others', {
			kind: 'github',
			item: {
				id: 'o/r#4',
				repo: 'o/r',
				number: 4,
				title: 'Crash',
				url: 'https://github.com/o/r/issues/4',
				author: 'alice',
				labels: ['bug', 'p1'],
				comments: 1,
				updatedAt: '',
				isPr: false
			}
		});
		expect(text).toBe(
			'From my Issues from others card on Home:\n\n' +
				'> o/r#4 Crash\n> Issue by alice\n> Labels: bug, p1\n> https://github.com/o/r/issues/4\n\n'
		);
	});
});

describe('askAbout', () => {
	it('opens a chat with the text in the box and sends nothing', () => {
		askAbout('News', {
			kind: 'news',
			item: {
				id: 'n',
				summary: 's',
				source: { title: 't', link: 'l', source: 'S', published: null, excerpt: '' }
			}
		});
		expect(m.newConversationWithDraft).toHaveBeenCalledWith(
			expect.stringContaining('From my News card')
		);
		expect(m.setActiveTab).toHaveBeenCalledWith('chat');
		expect(m.sendMessage).not.toHaveBeenCalled();
	});
});
