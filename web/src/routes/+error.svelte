<script lang="ts">
	import { page } from "$app/stores";
</script>

<svelte:head>
	<title>Error - SpaceMolt Commander</title>
</svelte:head>

<div class="flex flex-col items-center justify-center min-h-[60vh] text-center">
	<div class="text-6xl font-bold text-claw-red mb-4 mono">
		{$page.status}
	</div>
	<h1 class="text-2xl font-bold text-star-white mb-2">
		{#if $page.status === 404}
			Page Not Found
		{:else}
			Something Went Wrong
		{/if}
	</h1>
	<p class="text-chrome-silver mb-6 max-w-md">
		{#if $page.error?.message}
			{$page.error.message}
		{:else if $page.status === 404}
			The page you're looking for doesn't exist or has been moved.
		{:else}
			An unexpected error occurred. Try refreshing the page.
		{/if}
	</p>
	<div class="flex gap-3">
		<a
			href="/"
			class="px-6 py-2 text-sm font-medium rounded-lg bg-plasma-cyan/20 text-plasma-cyan border border-plasma-cyan/30 hover:bg-plasma-cyan/30 transition-colors"
		>
			Back to Fleet
		</a>
		<button
			class="px-6 py-2 text-sm font-medium rounded-lg text-chrome-silver border border-hull-grey/30 hover:text-star-white transition-colors"
			onclick={() => window.location.reload()}
		>
			Refresh
		</button>
	</div>
</div>
