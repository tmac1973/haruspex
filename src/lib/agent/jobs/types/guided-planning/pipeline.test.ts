import { describe, expect, it } from 'vitest';
import { phaseFileProblem } from './pipeline';

/** A phase file with everything the write-time gate cares about. */
function goodPhase(extra = ''): string {
	return [
		'# Phase 02 — CSS Styling',
		'',
		'Depends on: 01',
		'Enables: 03',
		'',
		'## Goal',
		'',
		'Style the board so it reads clearly at a glance.',
		'',
		'## Steps',
		'',
		'1. Add the palette custom properties to `:root` — background, surface,',
		'   accent, and the four per-stat border colours used by the score panel.',
		'2. Lay the score panel out as a flex row of four compact stat cards, each',
		'   wrapping to a column on narrow viewports so nothing overflows.',
		'3. Give each card a distinct border colour drawn from the palette above.',
		'4. Style the on-screen keyboard keys, including the :disabled state that',
		'   Phase 05 relies on when a letter has already been guessed.',
		'',
		'## Files touched',
		'',
		'- `styles.css` (new)',
		'',
		'## Build gate',
		'',
		'The page renders with the full palette applied and no unstyled flash.',
		extra
	].join('\n');
}

describe('phaseFileProblem', () => {
	it('accepts a well-formed phase file', () => {
		expect(phaseFileProblem('phase-02.md', goodPhase())).toBeNull();
	});

	it('rejects a file that begins partway through the document', () => {
		// The real-world regression, reproduced at its actual size: a
		// 1,170-byte fragment that started at "### 9. Score panel" with no
		// title and ended mid-property. The old existence-only check waved it
		// through and the verifier then looped on it for 20 minutes. Note it
		// is comfortably over MIN_PHASE_FILE_CHARS — size alone would NOT have
		// caught this, so the heading check is what has to hold.
		const fragment = [
			'### 9. Score panel (`#score-panel` and its children)',
			'',
			'Style the score panel as a horizontal flex row of four compact stat cards',
			'with emoji labels and distinct border colours.',
			'',
			'```css',
			'#score-panel {',
			'  display: flex;',
			'  flex-wrap: wrap;',
			'  justify-content: center;',
			'  gap: var(--space-md);',
			'  padding: var(--space-sm) 0;',
			'}',
			'',
			'#score-panel > div {',
			'  display: flex;',
			'  flex-direction: column;',
			'  align-items: center;',
			'  min-width: 5.5rem;',
			'  padding: var(--space-sm) var(--space-md);',
			'  border: 2px solid var(--surface-border);',
			'  border-radius: var(--radius-md);',
			'  background: var(--surface);',
			'  font-weight: 600;',
			'}',
			'',
			'#score-panel > div:nth-child(1) { border-color: var(--stat-wins); }',
			'#score-panel > div:nth-child(2) { border-color: var(--stat-losses); }',
			'#score-panel > div:nth-child(3) { border-color: var(--stat-streak); }',
			'#score-panel > div:nth-child(4) { border-color: var(--stat-best); }',
			'',
			'#score-panel > div span {',
			'  display: block;',
			'  font-size: 1.35rem;',
			'  line-height: 1.1;',
			'  align-items'
		].join('\n');
		expect(fragment.length).toBeGreaterThan(400);
		const problem = phaseFileProblem('phase-02.md', fragment);
		expect(problem).toContain('### 9. Score panel');
		expect(problem).toContain('heading');
	});

	it('rejects an empty file', () => {
		expect(phaseFileProblem('phase-02.md', '')).toContain('truncated or empty');
	});

	it('rejects a file truncated down to a stub', () => {
		const problem = phaseFileProblem('phase-02.md', '# Phase 02 — CSS Styling\n\nDepends on: 01\n');
		expect(problem).toContain('truncated or empty');
	});

	it('rejects a file with no Depends on line', () => {
		const noDeps = goodPhase().replace('Depends on: 01', 'Follows: 01');
		expect(phaseFileProblem('phase-02.md', noDeps)).toContain('Depends on');
	});

	it('names the file in every problem it reports', () => {
		expect(phaseFileProblem('plan/phase-07.md', '')).toContain('plan/phase-07.md');
	});

	// The gate runs on freshly written files with only three retries behind it,
	// so a false reject hard-fails a run that was never broken. These are the
	// legitimate variations that must not trip it.
	it('accepts heading and Depends-on variations', () => {
		const variations = [
			goodPhase().replace('## Steps', '## Implementation Steps'),
			goodPhase().replace('## Goal', '## Objective'),
			goodPhase().replace('Depends on: 01', 'Depends On: Phase 01'),
			goodPhase().replace('Depends on: 01', '**Depends on:** 01'),
			goodPhase().replace('# Phase 02 — CSS Styling', '# Phase 2: CSS Styling'),
			`\n\n${goodPhase()}`
		];
		for (const v of variations) {
			expect(phaseFileProblem('phase-02.md', v), v.slice(0, 40)).toBeNull();
		}
	});
});
