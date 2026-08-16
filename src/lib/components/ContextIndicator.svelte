<script lang="ts">
	// The app-header context indicator. Reads the global chat/shell usage store
	// by default, but retargets to the live job step while a job run is in view
	// — a job may run against a different model with a different window than
	// Settings has active, and reporting the Settings numbers there was simply
	// wrong (futures.md, open item #1).
	import ContextGauge from '$lib/components/ContextGauge.svelte';
	import { getContextUsage } from '$lib/stores/context.svelte';
	import { getCurrentRun } from '$lib/agent/jobs/runner.svelte';

	interface Props {
		/** True when the Jobs tab is the active view. */
		jobsActive?: boolean;
	}

	const { jobsActive = false }: Props = $props();

	const globalUsage = $derived(getContextUsage());
	const run = $derived(jobsActive ? getCurrentRun() : null);

	// The step the numbers describe: the live one, else the last that reported.
	const jobStep = $derived.by(() => {
		if (!run) return null;
		const live = run.steps[run.currentStepIndex];
		if (live?.usage) return live;
		return [...run.steps].reverse().find((s) => s.usage) ?? null;
	});

	const source = $derived(
		jobStep?.usage
			? {
					promptTokens: jobStep.usage.promptTokens,
					contextSize: run!.contextSize,
					label: run!.jobName
				}
			: {
					promptTokens: globalUsage.promptTokens,
					contextSize: globalUsage.contextSize,
					label: undefined
				}
	);
</script>

<ContextGauge
	promptTokens={source.promptTokens}
	contextSize={source.contextSize}
	label={source.label}
/>
