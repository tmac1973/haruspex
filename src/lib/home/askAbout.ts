/**
 * Ask about this: a new chat with a Home card's item in the input box, as a
 * quoted block of what the card knows about it, for the user to add a
 * question to and send. Nothing is sent for them.
 */
import type { ImportantEmail } from '#lib/agent/jobs/types/email-digest/pipeline.ts';
import type { NewsItem } from '#lib/agent/jobs/types/news-digest/pipeline.ts';
import type { Meeting } from '#lib/home/meetings.ts';
import { newConversationWithDraft } from '#lib/stores/chat.svelte.ts';
import { setActiveTab } from '#lib/stores/activeTab.svelte.ts';

export type AskItem =
	| { kind: 'email'; item: ImportantEmail }
	| { kind: 'meeting'; item: Meeting }
	| { kind: 'news'; item: NewsItem };

function lines(a: AskItem): string[] {
	switch (a.kind) {
		case 'email': {
			const s = a.item.source;
			return [
				`From: ${s.from}`,
				`Subject: ${s.subject || '(no subject)'}`,
				`Date: ${s.date}`,
				// The full message isn't fetched; the chat can read it with the email tools.
				`Message: ${s.messageId} (account ${s.accountId})`,
				s.snippet
			];
		}
		case 'meeting': {
			const m = a.item;
			return [
				m.summary || '(no title)',
				m.allDay ? `All day, ${m.start.slice(0, 10)}` : `${m.start} – ${m.end}`,
				...(m.location ? [`Where: ${m.location}`] : []),
				...(m.organizer ? [`Organizer: ${m.organizer}`] : []),
				...(m.attendees.length ? [`With: ${m.attendees.join(', ')}`] : [])
			];
		}
		case 'news': {
			const s = a.item.source;
			return [s.title, `${s.source}: ${s.link}`, a.item.summary];
		}
	}
}

/** The text that goes in the chat's input box. */
export function askAboutText(cardTitle: string, a: AskItem): string {
	const quoted = lines(a)
		.filter((l) => l.trim())
		.map((l) => `> ${l}`)
		.join('\n');
	return `From my ${cardTitle} card on Home:\n\n${quoted}\n\n`;
}

/** Open a new chat with the item ready to ask about. */
export function askAbout(cardTitle: string, a: AskItem): void {
	newConversationWithDraft(askAboutText(cardTitle, a));
	setActiveTab('chat');
}
