# Phase 06 — Accessibility pass

**Commit scope:** `fix(a11y)` · **Language:** Svelte/CSS · **Depends on:** phase 05 (MicButton already rerouted its errors; avoids double churn)

Four gaps: no reduced-motion handling anywhere (grep-verified zero hits),
mouse-only mic button, missing live regions, icon buttons named only by
`title`.

---

## 1. Global `prefers-reduced-motion` override

Decision locked: one global rule, not per-component keyframe guards. Add to
the global styles in `+layout.svelte`:

```css
@media (prefers-reduced-motion: reduce) {
	*,
	*::before,
	*::after {
		animation-duration: 0.01ms !important;
		animation-iteration-count: 1 !important;
		transition-duration: 0.01ms !important;
		scroll-behavior: auto !important;
	}
}
```

This freezes: `.spinner` rotations, the `.streaming-caret` blink
(`+layout.svelte:717`), ThinkingIndicator/setup-test dot bounces, the
`pulse-record` mic animation (`MicButton.svelte:130`), status-dot pulses, and
toast enter/exit (phase 03 deliberately used CSS animation so this rule
covers it). Every animated element already conveys state via text or color,
so a frozen first frame is acceptable — verify each visually and add a
static fallback only where a frozen frame is genuinely ambiguous (expected:
none).

## 2. Keyboard-operable mic button

`MicButton.svelte:35-52` uses only `onmousedown`/`onmouseup`/`onmouseleave`.

- `onkeydown` Space/Enter (guard `event.repeat`) → start recording;
  `onkeyup` → stop + transcribe. Esc or blur while recording → cancel
  without transcribing (matches the mouse-leave behavior).
- `aria-pressed={recording}`.
- Tooltip/title becomes: `Hold to talk (or hold F2)` — surfacing the
  existing global hotkey (`+layout.svelte` onGlobalKeydown) on the control
  itself.
- Shares the debounce with F2 via `voiceCapture.svelte.ts`'s existing
  single-flight guards — no new state.

## 3. Live regions for generation state

- `ThinkingIndicator.svelte`: the bare form (`:15`) already has
  `role="status"`; add `role="status" aria-label="Thinking"` to the
  full-size form (`:22-29`) too.
- `ChatView.svelte:370-399`: the `isWaitingForSlot`, `compacting`,
  context-notice, and (from phase 05) `Waiting for the model to start…`
  lines all get `role="status"` on their container div — one wrapper, not
  four.

## 4. Accessible names for header icon buttons

`+layout.svelte:333,349,368` — the logs / help / settings icon buttons rely
on `title` only. Add explicit `aria-label`s: `View logs`,
`Keyboard shortcuts (F1)`, `Settings`. Keep `title` for the hover tooltip.
Sweep the header for any other icon-only buttons while there and apply the
same treatment.

---

## Tests & acceptance

- Component test: MicButton keydown-space starts capture, keyup stops it,
  `event.repeat` ignored, Esc cancels (mock `voiceCapture`).
- Manual: run with `GTK_DEBUG` or a `prefers-reduced-motion: reduce` desktop
  setting → no looping animations anywhere (spot-check chat streaming,
  recording, setup wizard, toasts).
- Manual with Orca (or the WebKit accessibility inspector): status badge and
  thinking indicator announce transitions; header buttons read their labels.
