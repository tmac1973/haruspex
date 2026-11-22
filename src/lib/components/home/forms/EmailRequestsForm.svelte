<script lang="ts">
	/** Add card → Email requests: a Research by email job's settings and how often it checks. */
	import JobCardForm from '#lib/components/home/forms/JobCardForm.svelte';
	import { emailResearchJobType } from '#lib/agent/jobs/types/email-research/definition.ts';
	import type { CardFormProps } from '#lib/home/cardTypes.ts';

	let props: CardFormProps = $props();
</script>

<JobCardForm {...props} title="Email requests" jobType={emailResearchJobType} />
