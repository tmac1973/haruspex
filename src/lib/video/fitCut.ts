/**
 * How a replacement take fills the gap left by the words it replaces. Close
 * to the gap's length, the take is stretched or squeezed to fit (pitch kept)
 * and nothing else moves. Further off, the picture changes instead: a
 * shorter take cuts the gap's spare tail out, a longer one holds the frame
 * at the gap's end for the extra time. `auto` picks; `fit` and `cut` force.
 */
export type ReplacementPlan =
	| { mode: 'fit'; /** Play the take this many times as fast. */ speed: number }
	| { mode: 'cut'; trimSecs: number }
	| { mode: 'cut'; holdSecs: number };

/** Within these, span ÷ take is close enough to fit by changing the pace. */
export const FIT_RANGE = [0.85, 1.25] as const;

export function planReplacement(
	spanSecs: number,
	takeSecs: number,
	mode: 'auto' | 'fit' | 'cut'
): ReplacementPlan {
	const ratio = spanSecs / takeSecs;
	const fits = ratio >= FIT_RANGE[0] - 1e-9 && ratio <= FIT_RANGE[1] + 1e-9;
	// A gap of no length can't be stretched to: the picture is held instead.
	if (spanSecs > 0 && (mode === 'fit' || (mode === 'auto' && fits))) {
		return { mode: 'fit', speed: takeSecs / spanSecs };
	}
	return takeSecs < spanSecs
		? { mode: 'cut', trimSecs: spanSecs - takeSecs }
		: { mode: 'cut', holdSecs: takeSecs - spanSecs };
}
