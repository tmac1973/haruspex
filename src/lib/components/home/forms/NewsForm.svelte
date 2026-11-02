<script lang="ts">
	/** Add card → News: the feeds, the interests, and how often to read them. */
	import JobCardForm from '#lib/components/home/forms/JobCardForm.svelte';
	import { newsDigestJobType } from '#lib/agent/jobs/types/news-digest/definition.ts';
	import type { CardFormProps } from '#lib/home/cardTypes.ts';

	let props: CardFormProps = $props();
</script>

<JobCardForm {...props} title="News" jobType={newsDigestJobType} />
