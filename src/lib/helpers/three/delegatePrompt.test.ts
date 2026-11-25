import { describe, expect, it } from 'vitest';
import { SUBTASK_REPORT_CHARS } from '#lib/code/systemPrompt.ts';
import { RIG_RULE } from './moduleRules';
import {
	DELEGATE_3D_REPORT_CHARS,
	delegate3dFiles,
	delegate3dFinalReport,
	delegate3dFirstMessage,
	delegate3dSystemPrompt
} from './delegatePrompt';

describe('delegate3dFiles', () => {
	it('names the module and anim module beside the GLB', () => {
		expect(delegate3dFiles('assets/goblin.glb')).toEqual({
			module: 'assets/goblin.js',
			anim: 'assets/goblin.anim.js',
			glb: 'assets/goblin.glb'
		});
	});

	it('refuses anything but a .glb', () => {
		expect(delegate3dFiles('assets/goblin.png')).toBeNull();
		expect(delegate3dFiles('assets/goblin.js')).toBeNull();
		expect(delegate3dFiles('assets/.glb')).toBeNull();
		expect(delegate3dFiles('')).toBeNull();
	});
});

describe('delegate3dSystemPrompt', () => {
	const prompt = delegate3dSystemPrompt();
	const at = (s: string) => {
		const i = prompt.indexOf(s);
		expect(i, s).toBeGreaterThanOrEqual(0);
		return i;
	};

	it('says, in order, its job, tools, files, rules, loop, questions and report', () => {
		const order = [
			'You make one 3D asset',
			'Tools:',
			'You may write only three files',
			'`export default function build(THREE, kit)`',
			RIG_RULE,
			'`export default function animate(THREE, object, kit)`',
			'Keep clips in the animation module',
			'Run `check_3d` after every change, and look at the sheet',
			'You are done when `check_3d` reports no errors',
			'Nobody will answer questions: decide, and say what you assumed.',
			'At most 4,000 characters'
		].map(at);
		expect(order).toEqual([...order].sort((a, b) => a - b));
	});

	it('offers only the delegate’s tools', () => {
		for (const t of ['fs_read_text', 'code_grep', 'fs_write_text', 'fs_edit_text', 'check_3d']) {
			at(t);
		}
		expect(prompt).not.toContain('run_command');
		expect(prompt).not.toContain('delegate(');
	});
});

describe('delegate3dFirstMessage', () => {
	const base = {
		path: 'assets/goblin.js',
		anim: 'assets/goblin.anim.js',
		glb: 'assets/goblin.glb',
		task: '  A goblin, 1.2 m tall, with Idle and Walk.  ',
		existing: { module: false, anim: false },
		imagePaths: []
	};

	it('gives the task, then the files', () => {
		expect(delegate3dFirstMessage(base)).toBe(
			[
				'A goblin, 1.2 m tall, with Idle and Walk.',
				'',
				'Files:',
				'- Build module: assets/goblin.js',
				'- Animation module: assets/goblin.anim.js',
				'- GLB: assets/goblin.glb'
			].join('\n')
		);
	});

	it('says which modules exist, and lists the reference images', () => {
		const text = delegate3dFirstMessage({
			...base,
			existing: { module: true, anim: true },
			imagePaths: ['refs/goblin.png']
		});
		expect(text).toContain(
			'assets/goblin.js exists: read it and change it rather than starting again.'
		);
		expect(text).toContain(
			'assets/goblin.anim.js exists: read it and change it rather than starting again.'
		);
		expect(text.endsWith('Reference images (attached):\n- refs/goblin.png')).toBe(true);
	});

	it('leaves the anim note out when only the module exists', () => {
		const text = delegate3dFirstMessage({ ...base, existing: { module: true, anim: false } });
		expect(text).toContain('assets/goblin.js exists');
		expect(text).not.toContain('assets/goblin.anim.js exists');
		expect(text).not.toContain('Reference images');
	});
});

it('caps the report as every subtask’s is', () => {
	expect(DELEGATE_3D_REPORT_CHARS).toBe(SUBTASK_REPORT_CHARS);
});

describe('delegate3dFinalReport', () => {
	it('names the cap reached', () => {
		expect(delegate3dFinalReport('rounds')).toBe(
			"You've reached this call's round limit. Stop working and give your report now: what is built, what the last check said, and what is left."
		);
		expect(delegate3dFinalReport('cost')).toContain("this call's cost limit");
	});
});
