<script lang="ts">
	/** Add card → Important emails: the email digest's settings and how often it checks. */
	import JobCardForm from '#lib/components/home/forms/JobCardForm.svelte';
	import { emailDigestJobType } from '#lib/agent/jobs/types/email-digest/definition.ts';
	import type { CardFormProps } from '#lib/home/cardTypes.ts';

	let props: CardFormProps = $props();
</script>

<JobCardForm {...props} title="Important emails" jobType={emailDigestJobType} />
