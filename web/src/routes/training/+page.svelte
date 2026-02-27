<script lang="ts">
	import { onMount } from "svelte";
	import { commanderLog, trainingStats } from "$stores/websocket";
	import type { TrainingStats } from "../../../../src/types/protocol";
	import DecisionDistribution from "$lib/components/DecisionDistribution.svelte";
	import EpisodeOutcomes from "$lib/components/EpisodeOutcomes.svelte";

	// Fetch training stats from REST API
	let loading = $state(true);
	let error = $state<string | null>(null);

	async function fetchStats() {
		try {
			const res = await fetch("/api/training/stats");
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data: TrainingStats = await res.json();
			trainingStats.set(data);
			error = null;
		} catch (e) {
			error = e instanceof Error ? e.message : "Failed to fetch stats";
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		fetchStats();
		// Refresh every 30 seconds
		const interval = setInterval(fetchStats, 30_000);
		return () => clearInterval(interval);
	});

	// Derive decision distribution from commander log (live WS data)
	const decisionDist = $derived.by(() => {
		// Prefer training stats if available (covers full DB history)
		if ($trainingStats?.decisions.byAction) {
			return $trainingStats.decisions.byAction;
		}
		// Fallback to live commander log
		const counts: Record<string, number> = {};
		for (const decision of $commanderLog) {
			for (const a of decision.assignments) {
				counts[a.routine] = (counts[a.routine] ?? 0) + 1;
			}
		}
		return counts;
	});

	const stats = $derived($trainingStats);

	// Export helpers
	function downloadExport(endpoint: string, filename: string) {
		const a = document.createElement("a");
		a.href = `/api/training/export/${endpoint}`;
		a.download = filename;
		a.click();
	}

	// Retention
	let runningRetention = $state(false);
	let retentionResult = $state<Record<string, number> | null>(null);

	async function runRetention() {
		runningRetention = true;
		retentionResult = null;
		try {
			const res = await fetch("/api/training/clear", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ confirm: true, olderThanTick: 0, tables: [] }),
			});
			// Retention runs server-side; this is just a data clear with confirmation
			// The actual retention manager runs periodically on the backend
			if (res.ok) {
				const data = await res.json();
				retentionResult = data.recordsDeleted;
				fetchStats(); // Refresh stats after cleanup
			}
		} finally {
			runningRetention = false;
		}
	}
</script>

<svelte:head>
	<title>Training - SpaceMolt Commander</title>
</svelte:head>

<div class="space-y-4">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-star-white">Training Data</h1>
		<button
			class="px-3 py-1.5 text-xs font-medium rounded-md text-chrome-silver border border-hull-grey/30 hover:text-star-white transition-colors"
			onclick={fetchStats}
		>
			Refresh
		</button>
	</div>

	{#if error}
		<div class="card p-3 border-claw-red/50 bg-claw-red/10">
			<p class="text-sm text-claw-red">Failed to load training stats: {error}</p>
		</div>
	{/if}

	<!-- Dataset stats -->
	<div class="grid grid-cols-2 md:grid-cols-5 gap-3">
		<div class="card p-4">
			<p class="text-xs text-chrome-silver uppercase tracking-wider">Decisions</p>
			<p class="text-2xl font-bold mono text-star-white mt-1">
				{stats ? stats.decisions.count.toLocaleString() : loading ? "..." : "---"}
			</p>
		</div>
		<div class="card p-4">
			<p class="text-xs text-chrome-silver uppercase tracking-wider">Snapshots</p>
			<p class="text-2xl font-bold mono text-star-white mt-1">
				{stats ? stats.snapshots.count.toLocaleString() : loading ? "..." : "---"}
			</p>
		</div>
		<div class="card p-4">
			<p class="text-xs text-chrome-silver uppercase tracking-wider">Episodes</p>
			<p class="text-2xl font-bold mono text-star-white mt-1">
				{stats ? stats.episodes.count.toLocaleString() : loading ? "..." : "---"}
			</p>
			{#if stats && stats.episodes.successRate > 0}
				<p class="text-xs text-bio-green mt-1">{(stats.episodes.successRate * 100).toFixed(0)}% success</p>
			{/if}
		</div>
		<div class="card p-4">
			<p class="text-xs text-chrome-silver uppercase tracking-wider">Market Records</p>
			<p class="text-2xl font-bold mono text-star-white mt-1">
				{stats ? stats.marketHistory.count.toLocaleString() : loading ? "..." : "---"}
			</p>
			{#if stats && stats.marketHistory.stationsTracked > 0}
				<p class="text-xs text-chrome-silver mt-1">{stats.marketHistory.stationsTracked} stations</p>
			{/if}
		</div>
		<div class="card p-4">
			<p class="text-xs text-chrome-silver uppercase tracking-wider">DB Size</p>
			<p class="text-2xl font-bold mono text-star-white mt-1">
				{stats ? `${stats.database.sizeMB} MB` : loading ? "..." : "---"}
			</p>
			{#if stats && stats.commanderLog.count > 0}
				<p class="text-xs text-chrome-silver mt-1">{stats.commanderLog.count} cmdr logs</p>
			{/if}
		</div>
	</div>

	<!-- Episode details -->
	{#if stats && stats.episodes.count > 0}
		<div class="grid grid-cols-3 gap-3">
			<div class="card p-3">
				<p class="text-xs text-chrome-silver">Avg Episode Duration</p>
				<p class="text-lg font-bold mono text-star-white">{stats.episodes.avgDurationTicks} ticks</p>
			</div>
			<div class="card p-3">
				<p class="text-xs text-chrome-silver">Total Profit</p>
				<p class="text-lg font-bold mono" class:text-bio-green={stats.episodes.totalProfit >= 0} class:text-claw-red={stats.episodes.totalProfit < 0}>
					{stats.episodes.totalProfit.toLocaleString()} cr
				</p>
			</div>
			<div class="card p-3">
				<p class="text-xs text-chrome-silver">Episode Types</p>
				<div class="flex flex-wrap gap-1 mt-1">
					{#each Object.entries(stats.episodes.byType) as [type, count]}
						<span class="text-xs px-1.5 py-0.5 rounded bg-void-purple/20 text-void-purple">{type}: {count}</span>
					{/each}
				</div>
			</div>
		</div>
	{/if}

	<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
		<!-- Decision distribution -->
		<div class="card p-4">
			<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
				Decision Distribution
			</h2>
			<div class="h-64">
				<DecisionDistribution data={decisionDist} />
			</div>
		</div>

		<!-- Episode outcomes -->
		<div class="card p-4">
			<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
				Episode Outcomes
			</h2>
			<div class="h-64">
				<EpisodeOutcomes />
			</div>
		</div>
	</div>

	<!-- Export controls -->
	<div class="card p-4">
		<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
			Data Export
		</h2>
		<div class="flex flex-wrap gap-3">
			<button
				class="px-4 py-2 text-sm font-medium rounded-lg bg-nebula-blue text-chrome-silver border border-hull-grey/30 hover:text-star-white hover:bg-nebula-blue/80 transition-colors"
				onclick={() => downloadExport("decisions?format=json", "decisions.json")}
			>
				Export Decisions (JSON)
			</button>
			<button
				class="px-4 py-2 text-sm font-medium rounded-lg bg-nebula-blue text-chrome-silver border border-hull-grey/30 hover:text-star-white hover:bg-nebula-blue/80 transition-colors"
				onclick={() => downloadExport("snapshots?format=json", "snapshots.json")}
			>
				Export Snapshots (JSON)
			</button>
			<button
				class="px-4 py-2 text-sm font-medium rounded-lg bg-nebula-blue text-chrome-silver border border-hull-grey/30 hover:text-star-white hover:bg-nebula-blue/80 transition-colors"
				onclick={() => downloadExport("episodes?format=json", "episodes.json")}
			>
				Export Episodes (JSON)
			</button>
			<button
				class="px-4 py-2 text-sm font-medium rounded-lg bg-nebula-blue text-chrome-silver border border-hull-grey/30 hover:text-star-white hover:bg-nebula-blue/80 transition-colors"
				onclick={() => downloadExport("market-history?format=csv", "market_history.csv")}
			>
				Export Market History (CSV)
			</button>
			<button
				class="px-4 py-2 text-sm font-medium rounded-lg bg-nebula-blue text-chrome-silver border border-hull-grey/30 hover:text-star-white hover:bg-nebula-blue/80 transition-colors"
				onclick={() => downloadExport("commander-log?format=json", "commander_log.json")}
			>
				Export Commander Log (JSON)
			</button>
		</div>
		<p class="text-xs text-hull-grey mt-2">Exports up to 50,000 records per download</p>
	</div>

	<!-- Recent decisions table -->
	<div class="card p-4">
		<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
			Recent Decisions
		</h2>
		{#if $commanderLog.length === 0}
			<p class="text-sm text-hull-grey text-center py-8">No decisions recorded yet</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead>
						<tr class="text-left text-xs text-chrome-silver uppercase tracking-wider border-b border-hull-grey/30">
							<th class="pb-2 pr-4">Tick</th>
							<th class="pb-2 pr-4">Time</th>
							<th class="pb-2 pr-4">Goal</th>
							<th class="pb-2 pr-4">Assignments</th>
							<th class="pb-2">Reasoning</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-hull-grey/20">
						{#each $commanderLog.slice(0, 50) as decision}
							<tr class="hover:bg-nebula-blue/20 transition-colors">
								<td class="py-2 pr-4 mono text-star-white">{decision.tick}</td>
								<td class="py-2 pr-4 text-chrome-silver text-xs">{decision.timestamp.slice(11, 19)}</td>
								<td class="py-2 pr-4">
									{#if decision.goal}
										<span class="text-xs px-2 py-0.5 rounded bg-plasma-cyan/10 text-plasma-cyan">{decision.goal}</span>
									{:else}
										<span class="text-hull-grey text-xs">none</span>
									{/if}
								</td>
								<td class="py-2 pr-4">
									{#each decision.assignments as a}
										<span class="text-xs mr-1" style="color: var(--color-routine-{a.routine})">{a.botId}:{a.routine}</span>
									{:else}
										<span class="text-hull-grey text-xs">--</span>
									{/each}
								</td>
								<td class="py-2 text-xs text-chrome-silver max-w-[300px] truncate">{decision.reasoning}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>

	<!-- Data management -->
	<div class="card p-4">
		<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
			Data Management
		</h2>
		<p class="text-xs text-chrome-silver mb-3">
			Retention policy: 7 days full resolution, 30 days at 33% sample, 90 days at 10% sample, older data purged.
			Retention runs automatically on the backend.
		</p>
		{#if retentionResult}
			<div class="p-3 bg-bio-green/10 border border-bio-green/30 rounded-lg mb-3">
				<p class="text-sm text-bio-green">
					Cleanup complete:
					{#each Object.entries(retentionResult) as [table, count]}
						<span class="mr-2">{table}: {count}</span>
					{/each}
				</p>
			</div>
		{/if}
	</div>
</div>
