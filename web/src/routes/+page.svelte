<script lang="ts">
	import { bots, fleetStats, commanderLog, activityLog, connectionState } from "$stores/websocket";
	import CreditsChart from "$lib/components/CreditsChart.svelte";
</script>

<svelte:head>
	<title>Fleet - SpaceMolt Commander</title>
</svelte:head>

<div class="space-y-4">
	<!-- Page header -->
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-star-white">Fleet Overview</h1>
		<div class="flex items-center gap-2 text-sm">
			<span
				class="status-dot"
				class:active={$connectionState === "connected"}
				class:error={$connectionState === "disconnected"}
				class:idle={$connectionState === "connecting"}
			></span>
			<span class="text-chrome-silver capitalize">{$connectionState}</span>
		</div>
	</div>

	<!-- Stats row -->
	<div class="grid grid-cols-2 md:grid-cols-4 gap-3">
		<div class="card p-4">
			<p class="text-xs text-chrome-silver uppercase tracking-wider">Total Credits</p>
			<p class="text-2xl font-bold mono text-star-white mt-1">
				{$fleetStats?.totalCredits?.toLocaleString() ?? "---"}
			</p>
		</div>
		<div class="card p-4">
			<p class="text-xs text-chrome-silver uppercase tracking-wider">Income Rate</p>
			<p class="text-2xl font-bold mono {$fleetStats && $fleetStats.creditsPerHour >= 0 ? 'text-bio-green' : 'text-claw-red'} mt-1">
				{#if $fleetStats}
					{$fleetStats.creditsPerHour >= 0 ? '+' : ''}{$fleetStats.creditsPerHour.toLocaleString()}
				{:else}
					---
				{/if}
				<span class="text-sm text-chrome-silver">cr/hr</span>
			</p>
		</div>
		<div class="card p-4">
			<p class="text-xs text-chrome-silver uppercase tracking-wider">Active Bots</p>
			<p class="text-2xl font-bold mono text-star-white mt-1">
				{$fleetStats ? `${$fleetStats.activeBots}/${$fleetStats.totalBots}` : "---"}
			</p>
		</div>
		<div class="card p-4">
			<p class="text-xs text-chrome-silver uppercase tracking-wider">API Calls Today</p>
			<p class="text-2xl font-bold mono text-star-white mt-1">
				{$fleetStats ? ($fleetStats.apiCallsToday.mutations + $fleetStats.apiCallsToday.queries).toLocaleString() : "---"}
			</p>
		</div>
	</div>

	<div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
		<!-- Credits chart -->
		<div class="card p-4 lg:col-span-2">
			<div class="h-64">
				<CreditsChart />
			</div>
		</div>

		<!-- Commander thoughts -->
		<div class="card p-4">
			<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
				Commander Thoughts
			</h2>
			<div class="space-y-1.5 max-h-64 overflow-y-auto">
				{#if $commanderLog.length === 0}
					<p class="text-sm text-hull-grey">Commander is thinking...</p>
				{:else}
					{@const latest = $commanderLog[0]}
					{#if latest.thoughts && latest.thoughts.length > 0}
						{#each latest.thoughts as thought}
							<p class="text-xs text-chrome-silver leading-relaxed">{thought}</p>
						{/each}
					{:else}
						<p class="text-xs text-chrome-silver">{latest.reasoning}</p>
					{/if}
					<p class="text-hull-grey text-[10px] mt-2 border-t border-hull-grey/20 pt-1">
						{latest.timestamp.slice(11, 19)} &middot; {latest.assignments.length} assignment(s)
					</p>
				{/if}
			</div>
		</div>
	</div>

	<!-- Bot roster table -->
	<div class="card p-4">
		<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
			Bot Roster
		</h2>
		{#if $bots.length === 0}
			<div class="py-12 text-center">
				<p class="text-hull-grey">No bots registered</p>
				<p class="text-sm text-hull-grey mt-1">
					Go to <a href="/bots" class="text-plasma-cyan hover:underline">Bots</a> to add your first bot
				</p>
			</div>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead>
						<tr class="text-left text-xs text-chrome-silver uppercase tracking-wider border-b border-hull-grey/30">
							<th class="pb-2 pr-4">Status</th>
							<th class="pb-2 pr-4">Bot</th>
							<th class="pb-2 pr-4">Ship</th>
							<th class="pb-2 pr-4">Routine</th>
							<th class="pb-2 pr-4">State</th>
							<th class="pb-2 pr-4">Location</th>
							<th class="pb-2 pr-4">Destination</th>
							<th class="pb-2 pr-4 text-right">Credits</th>
							<th class="pb-2 pr-4 text-right">cr/hr</th>
							<th class="pb-2 pr-4 text-right">Fuel</th>
							<th class="pb-2 text-right">Cargo</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-hull-grey/20">
						{#each $bots as bot}
							<tr class="hover:bg-nebula-blue/20 transition-colors">
								<td class="py-2 pr-4">
									<span
										class="status-dot"
										class:active={bot.status === "running"}
										class:idle={bot.status === "idle" || bot.status === "ready"}
										class:error={bot.status === "error"}
										class:offline={bot.status === "stopping"}
									></span>
								</td>
								<td class="py-2 pr-4">
									<a href="/bots/{bot.id}" class="text-star-white hover:text-plasma-cyan font-medium">
										{bot.username}
									</a>
								</td>
								<td class="py-2 pr-4 text-chrome-silver text-xs">
									{bot.shipName ?? bot.shipClass ?? "--"}
								</td>
								<td class="py-2 pr-4">
									{#if bot.routine}
										<span
											class="inline-block px-2 py-0.5 rounded text-xs font-medium"
											style="background: color-mix(in srgb, var(--color-routine-{bot.routine}) 20%, transparent); color: var(--color-routine-{bot.routine})"
										>
											{bot.routine}
										</span>
									{:else}
										<span class="text-hull-grey">--</span>
									{/if}
								</td>
								<td class="py-2 pr-4 text-chrome-silver text-xs max-w-[200px] truncate">
									{bot.routineState || "--"}
								</td>
								<td class="py-2 pr-4 text-chrome-silver text-xs">
									{bot.systemName ?? "Unknown"}{#if bot.poiName}<span class="text-hull-grey"> - </span><span class="text-star-white">{bot.poiName}</span>{/if}
									{#if bot.docked}
										<span class="text-laser-blue ml-1">docked</span>
									{/if}
								</td>
								<td class="py-2 pr-4 text-xs">
									{#if bot.destination}
										<span class="text-plasma-cyan">{bot.destination}</span>
										{#if bot.jumpsRemaining != null}
											<span class="text-hull-grey ml-1">({bot.jumpsRemaining}J)</span>
										{/if}
									{:else}
										<span class="text-hull-grey">--</span>
									{/if}
								</td>
								<td class="py-2 pr-4 text-right mono text-star-white">
									{bot.credits.toLocaleString()}
								</td>
								<td class="py-2 pr-4 text-right mono {bot.creditsPerHour >= 0 ? 'text-bio-green' : 'text-claw-red'}">
									{bot.creditsPerHour >= 0 ? "+" : ""}{bot.creditsPerHour.toLocaleString()}
								</td>
								<td class="py-2 pr-4 text-right mono">
									<span class={bot.fuelPct < 20 ? "text-claw-red" : bot.fuelPct < 50 ? "text-warning-yellow" : "text-star-white"}>
										{Math.round(bot.fuelPct)}%
									</span>
									<span class="text-hull-grey text-[10px] ml-0.5">{Math.round(bot.fuel)}/{Math.round(bot.maxFuel)}</span>
								</td>
								<td class="py-2 text-right mono">
									<span class="text-star-white">{Math.round(bot.cargoPct)}%</span>
									<span class="text-hull-grey text-[10px] ml-0.5">{Math.round(bot.cargoUsed)}/{Math.round(bot.cargoCapacity)}</span>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>

	<!-- Activity log -->
	<div class="card p-4">
		<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
			Recent Activity
		</h2>
		<div class="space-y-1 max-h-48 overflow-y-auto">
			{#if $activityLog.length === 0}
				<p class="text-sm text-hull-grey">No activity yet</p>
			{:else}
				{#each $activityLog.slice(0, 20) as entry}
					<div class="flex items-start gap-2 text-xs py-0.5">
						<span class="text-hull-grey shrink-0 mono">{entry.timestamp.slice(11, 19)}</span>
						<span
							class="shrink-0 {entry.level === 'error'
								? 'text-claw-red'
								: entry.level === 'warn'
									? 'text-warning-yellow'
									: entry.level === 'cmd'
										? 'text-plasma-cyan'
										: 'text-chrome-silver'}"
						>
							[{entry.level}]
						</span>
						{#if entry.botId}
							<a href="/bots/{entry.botId}" class="text-laser-blue shrink-0">{entry.botId}</a>
						{/if}
						<span class="text-star-white">{entry.message}</span>
					</div>
				{/each}
			{/if}
		</div>
	</div>
</div>
