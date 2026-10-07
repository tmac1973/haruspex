import { describe, expect, it } from 'vitest';
import type { SkillDoc } from '#lib/ipc/gen/SkillDoc.ts';
import {
	holdsSkillContent,
	loadedSkillNames,
	renderSkillContent,
	renderSlashMessage,
	skillsWithFiles,
	typedText
} from './content';

const doc = (over: Partial<SkillDoc> = {}): SkillDoc => ({
	name: 'pdf-tools',
	body: '# PDF tools\n\nDo the thing.',
	dir: '/skills/pdf-tools',
	compatibility: null,
	files: [],
	filesTruncated: false,
	...over
});

describe('renderSkillContent', () => {
	it('wraps the body and points at the folder and its files', () => {
		const text = renderSkillContent(
			doc({ files: ['scripts/extract.py'], filesTruncated: true, compatibility: 'Needs poppler' })
		);
		expect(text.startsWith('<skill_content name="pdf-tools">\n# PDF tools')).toBe(true);
		expect(text).toContain('Skill directory: /skills/pdf-tools');
		expect(text).toContain('read_skill_file');
		expect(text).toContain('Requirements: Needs poppler');
		expect(text).toContain('<file>scripts/extract.py</file>');
		expect(text).toContain('(more files not listed)');
		expect(text.endsWith('</skill_content>')).toBe(true);
	});

	it('says nothing about files for a built-in with none', () => {
		const text = renderSkillContent(doc({ dir: null }));
		expect(text).not.toContain('Skill directory');
		expect(text).not.toContain('<skill_resources>');
	});
});

describe('loadedSkillNames', () => {
	it('finds every skill loaded anywhere in the conversation', () => {
		const names = loadedSkillNames([
			{ role: 'user', content: 'hi' },
			{ role: 'tool', content: renderSkillContent(doc()), tool_call_id: 'a' },
			{
				role: 'user',
				content: [{ type: 'text', text: renderSkillContent(doc({ name: 'deploy' })) }]
			}
		]);
		expect([...names].sort()).toEqual(['deploy', 'pdf-tools']);
		expect(holdsSkillContent(renderSkillContent(doc()))).toBe(true);
		expect(holdsSkillContent('<skill_content>')).toBe(false);
	});
});

describe('renderSlashMessage / typedText', () => {
	it('puts the skill ahead of what was typed, and gives back only the typing', () => {
		const text = renderSlashMessage(doc(), '/pdf-tools merge a.pdf b.pdf');
		expect(text.startsWith('<skill_content name="pdf-tools">')).toBe(true);
		expect(text).toContain('take priority over your usual way of answering');
		expect(text.endsWith('/pdf-tools merge a.pdf b.pdf')).toBe(true);
		expect(holdsSkillContent(text)).toBe(true);
		expect(typedText(text)).toBe('/pdf-tools merge a.pdf b.pdf');
	});

	it('gives back the typing from a message stored with the older note', () => {
		const old = `${renderSkillContent(doc())}\n\nThe user ran the "pdf-tools" skill. Follow its instructions above for this message:\n\n/pdf-tools merge`;
		expect(typedText(old)).toBe('/pdf-tools merge');
	});

	it('leaves other text alone, a load_skill result included', () => {
		expect(typedText('hello')).toBe('hello');
		const loaded = renderSkillContent(doc());
		expect(typedText(loaded)).toBe(loaded);
	});
});

describe('skillsWithFiles', () => {
	it('names the loaded skills that came with files', () => {
		const messages = [
			{
				role: 'user' as const,
				content: renderSlashMessage(doc({ files: ['a.md'] }), '/pdf-tools')
			},
			{ role: 'tool' as const, content: renderSkillContent(doc({ name: 'plain' })) }
		];
		expect(skillsWithFiles(messages)).toEqual(new Set(['pdf-tools']));
	});
});
