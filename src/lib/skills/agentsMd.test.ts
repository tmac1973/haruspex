import { describe, expect, it } from 'vitest';
import type { AgentsMd } from '#lib/ipc/gen/AgentsMd.ts';
import { agentsMdPromptSection, describeAgentsMd } from './agentsMd';

const md = (over: Partial<AgentsMd> = {}): AgentsMd => ({
	files: ['AGENTS.md'],
	text: 'From AGENTS.md:\nRun make check.',
	truncated: false,
	totalBytes: 31,
	...over
});

describe('agentsMdPromptSection', () => {
	it("carries the repo's text and says it wins over the fixed rules", () => {
		const section = agentsMdPromptSection(md());
		expect(section).toContain('PROJECT INSTRUCTIONS:');
		expect(section).toContain('they win');
		expect(section).toContain('From AGENTS.md:\nRun make check.');
		expect(section).not.toContain('Cut at');
		expect(agentsMdPromptSection(null)).toBe('');
	});

	it('tells the model when the text was cut, and where the rest is', () => {
		const section = agentsMdPromptSection(
			md({ text: 'x'.repeat(8192), truncated: true, totalBytes: 20_480 })
		);
		expect(section).toContain('[Cut at 8 KB of 20 KB. Read the file itself for the rest.]');
	});
});

describe('describeAgentsMd', () => {
	it('names the files, and the cut when there was one', () => {
		expect(describeAgentsMd(md({ files: ['AGENTS.md', 'app/AGENTS.md'] }))).toBe(
			'Using AGENTS.md, app/AGENTS.md'
		);
		expect(
			describeAgentsMd(md({ text: 'x'.repeat(8192), truncated: true, totalBytes: 20_480 }))
		).toBe('Using AGENTS.md, cut to 8 KB of 20 KB');
	});
});
