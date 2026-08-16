import { describe, it, expect } from 'vitest';
import { buildCommandSuggestions, stacksNamedInPlan } from './commandSuggestions';
import type { PlanFile } from './planParse';

function planFile(name: string, content: string): PlanFile {
	return { name, content };
}

/** A phase file in the guided-planning template's shape. */
function phaseWithCommands(name: string, verify?: string, stepCheck?: string): PlanFile {
	let body = `# Phase 01 — Setup\n\n## Steps\n\n1. Do the thing\n`;
	if (verify) body += `\n## Verification command\n\n\`\`\`\n${verify}\n\`\`\`\n`;
	if (stepCheck) body += `\n## Step check command\n\n\`\`\`\n${stepCheck}\n\`\`\`\n`;
	return planFile(name, body);
}

const base = { planFiles: [], markers: [], packageScripts: [] };

describe('buildCommandSuggestions — tier order', () => {
	it('puts the plan-declared command first', () => {
		// Highest confidence by a distance: it is literally what the run will
		// execute, because the runner parses the same heading at run time.
		const out = buildCommandSuggestions({
			...base,
			field: 'verify',
			planFiles: [phaseWithCommands('phase-01-setup.md', 'npm run test:all')],
			markers: ['package.json', 'Cargo.toml'],
			packageScripts: ['test']
		});
		expect(out[0]).toEqual({
			command: 'npm run test:all',
			source: 'plan',
			note: 'phase-01-setup.md'
		});
	});

	it('offers each phase file that declares one', () => {
		const out = buildCommandSuggestions({
			...base,
			field: 'verify',
			planFiles: [
				phaseWithCommands('phase-01.md', 'cargo test -p core'),
				phaseWithCommands('phase-02.md', 'cargo test --workspace')
			]
		});
		expect(out.filter((s) => s.source === 'plan').map((s) => s.command)).toEqual([
			'cargo test -p core',
			'cargo test --workspace'
		]);
	});

	it('reads the step-check heading for the step-check field', () => {
		const files = [phaseWithCommands('phase-01.md', 'npm test', 'npm run lint')];
		expect(buildCommandSuggestions({ ...base, field: 'verify', planFiles: files })[0].command).toBe(
			'npm test'
		);
		expect(
			buildCommandSuggestions({ ...base, field: 'step-check', planFiles: files })[0].command
		).toBe('npm run lint');
	});

	it('falls to the working dir when the plan declares nothing', () => {
		const out = buildCommandSuggestions({
			...base,
			field: 'verify',
			markers: ['Cargo.toml'],
			planFiles: [planFile('overview.md', 'A Rust project.')]
		});
		expect(out[0]).toEqual({ command: 'cargo test', source: 'project', note: 'Cargo.toml' });
	});

	it('never suggests a package.json command the repo has no script for', () => {
		// Suggesting `npm test` at a package.json with no test script is
		// offering a command that fails.
		const out = buildCommandSuggestions({
			...base,
			field: 'verify',
			markers: ['package.json'],
			packageScripts: ['build', 'dev']
		});
		expect(out.filter((s) => s.source === 'project')).toEqual([]);
	});

	it('offers real package.json scripts, best name first', () => {
		const out = buildCommandSuggestions({
			...base,
			field: 'verify',
			markers: ['package.json'],
			packageScripts: ['dev', 'test:unit', 'test']
		});
		expect(out.filter((s) => s.source === 'project').map((s) => s.command)).toEqual([
			'npm test',
			'npm run test:unit'
		]);
	});
});

describe('buildCommandSuggestions — the greenfield case', () => {
	it('uses the stack the plan names when the repo is empty', () => {
		// The case that motivated the tiering: a brand-new repo has no marker
		// files to detect, but its plan says what is being built.
		const out = buildCommandSuggestions({
			...base,
			field: 'verify',
			planFiles: [
				planFile('overview.md', 'We will build a CLI in Rust, using cargo for the build.')
			]
		});
		expect(out[0]).toEqual({
			command: 'cargo test',
			source: 'catalog',
			note: 'named in your plan'
		});
		// And only that stack — not four languages the user is not using.
		expect(out.every((s) => s.command.startsWith('cargo'))).toBe(true);
	});

	it('falls back to the whole catalog when the plan names no stack', () => {
		const out = buildCommandSuggestions({
			...base,
			field: 'verify',
			planFiles: [planFile('overview.md', 'Build something nice for the user.')]
		});
		const commands = out.map((s) => s.command);
		expect(commands).toContain('npm test');
		expect(commands).toContain('cargo test');
		expect(commands).toContain('pytest');
		expect(out.every((s) => s.note === 'common command')).toBe(true);
	});

	it('still produces suggestions with no plan and no repo at all', () => {
		// The editor may be open before either is configured; an empty
		// dropdown would be worse than a generic one.
		expect(buildCommandSuggestions({ ...base, field: 'verify' }).length).toBeGreaterThan(0);
	});
});

describe('buildCommandSuggestions — hygiene', () => {
	it('deduplicates across tiers, keeping the highest-confidence source', () => {
		const out = buildCommandSuggestions({
			...base,
			field: 'verify',
			planFiles: [phaseWithCommands('phase-01.md', 'cargo test')],
			markers: ['Cargo.toml']
		});
		const cargoTest = out.filter((s) => s.command === 'cargo test');
		expect(cargoTest).toHaveLength(1);
		expect(cargoTest[0].source).toBe('plan');
	});

	it('ignores a plan section with no fenced command', () => {
		// extractDecisionCommand requires the fence: a bare line once fed a
		// leaked `<tool_call>bash` artifact and an English paragraph to a shell.
		const out = buildCommandSuggestions({
			...base,
			field: 'verify',
			planFiles: [planFile('phase-01.md', '## Verification command\n\nRun the test suite.\n')]
		});
		expect(out.some((s) => s.source === 'plan')).toBe(false);
	});
});

describe('stacksNamedInPlan', () => {
	it('matches a stack named anywhere in the plan prose', () => {
		expect(
			stacksNamedInPlan([planFile('a.md', 'A SvelteKit front end.')]).map((s) => s.marker)
		).toEqual(['package.json']);
	});

	it('matches several stacks for a mixed project', () => {
		expect(
			stacksNamedInPlan([planFile('a.md', 'Tauri app: Rust backend, TypeScript front end.')]).map(
				(s) => s.marker
			)
		).toEqual(['package.json', 'Cargo.toml']);
	});

	it('returns nothing when no stack is named', () => {
		expect(stacksNamedInPlan([planFile('a.md', 'Just some prose.')])).toEqual([]);
	});
});
