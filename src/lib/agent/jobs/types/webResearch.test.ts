import { describe, expect, it } from 'vitest';
import {
	interviewResearchRules,
	WEB_RESEARCH_TOOLS,
	withWebResearch,
	writeResearchRules
} from './webResearch';

/** Rules are hard-wrapped; assert against a whitespace-collapsed copy. */
function flat(lines: string[]): string {
	return lines.join('\n').replace(/\s+/g, ' ');
}

describe('withWebResearch', () => {
	it('adds the web tools when on', () => {
		expect(withWebResearch(['fs_read_text'], true)).toEqual([
			'fs_read_text',
			'web_search',
			'research_url'
		]);
	});

	it('leaves the toolset alone when off', () => {
		expect(withWebResearch(['fs_read_text'], false)).toEqual(['fs_read_text']);
	});

	it('never mutates the base list', () => {
		const base = ['fs_read_text'];
		withWebResearch(base, true);
		expect(base).toEqual(['fs_read_text']);
	});

	it('offers no raw page fetch', () => {
		// research_url returns findings for a focus; fetch_url dumps the page
		// into a context the interview is already filling.
		expect(WEB_RESEARCH_TOOLS).not.toContain('fetch_url');
	});
});

/**
 * The rathole guard. A search tool with no brief turns into browsing on a
 * local model, so fact-checking is the default and a wide survey needs the
 * user to have asked for one.
 */
describe('interviewResearchRules', () => {
	const rules = flat(
		interviewResearchRules('the project description or any answer the user gives')
	);

	it('makes checking stale facts the unprompted default', () => {
		expect(rules).toContain('CHECK, without being asked');
		expect(rules).toContain('One or two searches per fact');
		expect(rules).toContain('Do not browse for ideas');
	});

	it('allows a survey only where the user asked for one', () => {
		expect(rules).toContain(
			'SURVEY, only when asked: if the project description or any answer the user gives asks you to research'
		);
	});

	it('hands the choice back to the user', () => {
		expect(rules).toContain('options of ONE `ask_user_question`');
		expect(rules).toContain('do not make it for the user');
	});

	it('carries findings into the file, since later stages never see the conversation', () => {
		expect(rules).toContain('later stages read the files, never this conversation');
	});
});

describe('writeResearchRules', () => {
	const rules = flat(writeResearchRules());

	it('does not reopen decisions already made', () => {
		expect(rules).toContain('do not research alternatives');
	});

	it('still honours an explicit request in the message', () => {
		expect(rules).toContain('explicitly asks you to research something');
	});

	it('never tells a no-questions stage to ask one', () => {
		expect(rules).not.toContain('ask_user_question');
	});
});
