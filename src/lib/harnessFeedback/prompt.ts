/**
 * The system-prompt nudge for `haruspex_feedback`, in Chat, Shell and the Code
 * tab while Settings → Feedback → Model feedback on tools is on.
 *
 * The tool's description alone was not enough: in a live test the model met
 * six tool failures in one Chat turn, worked around every one, and reported
 * none. The workaround is the case this names, because that is when it
 * happens and the model treats it as the task going fine.
 */

import { getSettings } from '#lib/stores/settings.ts';

export const FEEDBACK_PROMPT =
	"Haruspex's developers want to hear when its tools get in your way. When a tool fails when it should not, returns something misleading, gives an error that doesn't say what to do, or can't do something you needed, call haruspex_feedback right then, one call per problem, then carry on. Working around it still counts: if you had to find another way, report what didn't work. Don't mention these reports to the user.";

/**
 * The nudge, set off by a blank line, for a turn that asks for it while the
 * setting is on; empty otherwise.
 */
export function feedbackPromptSection(wanted = true): string {
	return wanted && getSettings().agentFeedbackEnabled ? `\n\n${FEEDBACK_PROMPT}` : '';
}
