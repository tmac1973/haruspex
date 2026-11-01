/**
 * What a skill needs set up (`metadata.haruspex-needs`), and whether it is.
 *
 * A skill whose need is off is left out of every turn, the `/` menu and
 * `/name`, so `/write-song` with no music backend is never offered rather
 * than failing at its first tool call. The gates are the ones the tools'
 * own schemas are offered by (`agent/tools/registry.ts`).
 *
 * An image skill also gets a note, when it loads, of what the image backend
 * can do now: the same line Settings → Image shows, so a skill that branches
 * on it ("only the bundled engine and ComfyUI extend") need not spend a tool
 * call finding out.
 */

import type { SkillNeed } from '#lib/ipc/gen/SkillNeed.ts';
import type { ImageBackendKind } from '#lib/image/types.ts';
import { getSettings } from '#lib/stores/settings.ts';
import { imageEntries } from '#lib/image/entries.ts';
import { videoToolsOn } from '#lib/video/binaries.ts';
import { LEAN_CHAT_TOOLS } from '#lib/agent/tools/leanProfile.ts';

/** Why each need is unmet, in the words Settings uses. */
const UNMET: Record<SkillNeed, string> = {
	image: 'Needs an image backend: Settings → Image.',
	music: 'Needs a music backend: Settings → Music.',
	video: 'Needs the video tools on and ffmpeg, ffprobe and melt found: Settings → Video editing.'
};

/** The image backend as Settings → Image names it. */
const BACKEND_NAME: Record<ImageBackendKind, string> = {
	none: 'none',
	local: 'the bundled engine',
	comfyui: 'ComfyUI',
	lemonade: 'Lemonade',
	'llama-toolchest': 'llama-toolchest'
};

function met(need: SkillNeed): boolean {
	const s = getSettings();
	if (need === 'image') return imageEntries().length > 0;
	if (need === 'music') return s.musicBackendKind !== 'none';
	return videoToolsOn();
}

/** Why the skill can't run here, for Settings → Skills; null when it can. */
export function unmetNeed(needs: readonly SkillNeed[]): string | null {
	const missing = needs.find((n) => !met(n));
	return missing ? UNMET[missing] : null;
}

/** Why a skill is out in lean mode, for Settings → Skills. */
export const LEAN_UNMET = 'Off in lean mode: Settings → General → Lean mode.';

/**
 * Lean mode is on and the skill names a tool it doesn't offer
 * (`metadata.haruspex-tools`), such as `write-song`'s `generate_music`. A
 * skill that names none is left in: nothing says it can't run.
 */
export function leanBlocks(tools: readonly string[]): boolean {
	return getSettings().leanMode && tools.some((t) => !LEAN_CHAT_TOOLS.has(t));
}

/**
 * Why a Chat turn can't use the skill, or null when it can: lean mode first,
 * then what it needs set up.
 */
export function unmetFor(skill: {
	needs: readonly SkillNeed[];
	tools: readonly string[];
}): string | null {
	return leanBlocks(skill.tools) ? LEAN_UNMET : unmetNeed(skill.needs);
}

/**
 * Lines to put after a loaded skill's instructions: what the image backend
 * can do now. Empty for a skill that needs no image backend, or when the
 * backend can't say.
 */
export async function needsNotes(needs: readonly SkillNeed[]): Promise<string[]> {
	if (!needs.includes('image') || !met('image')) return [];
	try {
		// Loaded here, not at the top: the skills client is imported by every
		// tab, and the image backends are only wanted when an image skill loads.
		const [{ resolveImageBackend }, { capabilityLine }] = await Promise.all([
			import('#lib/image/index.ts'),
			import('#lib/image/capabilityLine.ts')
		]);
		const backend = resolveImageBackend();
		const line = capabilityLine(await backend.capabilities(), backend.kind);
		const how = line.howTo ? ` ${line.howTo}` : '';
		return [
			`The image backend, ${BACKEND_NAME[backend.kind]} (Settings → Image). ${line.text}${how}`
		];
	} catch (e) {
		console.warn('Could not read the image backend for a skill', e);
		return [];
	}
}
