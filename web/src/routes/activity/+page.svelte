<script lang="ts">
	import { activityLog, commanderLog, economy } from "$stores/websocket";

	// Derive top trades from activity log (sell events)
	const topTrades = $derived.by(() => {
		const sells = $activityLog
			.filter(e => e.message.includes("sold") || e.message.includes("Sold"))
			.slice(0, 5);
		return sells;
	});

	// Derive crafting events
	const craftingFeed = $derived.by(() => {
		return $activityLog
			.filter(e => e.message.includes("craft") || e.message.includes("Craft"))
			.slice(0, 5);
	});
</script>

<svelte:head>
	<title>Activity - SpaceMolt Commander</title>
</svelte:head>

<div class="space-y-4">
	<h1 class="text-2xl font-bold text-star-white">Activity Feed</h1>

	<div class="grid grid-cols-1 lg:grid-cols-4 gap-4">
		<!-- Live feed -->
		<div class="card p-4 lg:col-span-3">
			<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
				Live Ticker
			</h2>
			<div class="space-y-1 max-h-[calc(100vh-240px)] overflow-y-auto">
				{#if $activityLog.length === 0}
					<p class="text-sm text-hull-grey py-8 text-center">
						Waiting for activity...
					</p>
				{:else}
					{#each $activityLog as entry}
						<div class="flex items-start gap-2 text-xs py-1.5 border-b border-hull-grey/10 last:border-0">
							<span class="text-hull-grey shrink-0 mono w-16">{entry.timestamp.slice(11, 19)}</span>
							<span
								class="shrink-0 w-10 text-center font-medium rounded px-1 {entry.level === 'error'
									? 'text-claw-red bg-claw-red/10'
									: entry.level === 'warn'
										? 'text-warning-yellow bg-warning-yellow/10'
										: entry.level === 'cmd'
											? 'text-plasma-cyan bg-plasma-cyan/10'
											: 'text-chrome-silver'}"
							>
								{entry.level}
							</span>
							{#if entry.botId}
								<a href="/bots/{entry.botId}" class="text-laser-blue shrink-0 hover:underline">{entry.botId}</a>
							{/if}
							<span class="text-star-white">{entry.message}</span>
						</div>
					{/each}
				{/if}
			</div>
		</div>

		<!-- Stat cards sidebar -->
		<div class="space-y-3">
			<!-- Top Trades -->
			<div class="card p-4">
				<h3 class="text-xs text-chrome-silver uppercase tracking-wider mb-2">Top Trades</h3>
				{#if topTrades.length === 0}
					<p class="text-xs text-hull-grey text-center py-3">No trades yet</p>
				{:else}
					<div class="space-y-1.5">
						{#each topTrades as trade}
							<div class="text-xs">
								<span class="text-hull-grey mono">{trade.timestamp.slice(11, 19)}</span>
								{#if trade.botId}
									<a href="/bots/{trade.botId}" class="text-laser-blue ml-1">{trade.botId}</a>
								{/if}
								<p class="text-chrome-silver truncate">{trade.message}</p>
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Top Items (from economy open orders) -->
			<div class="card p-4">
				<h3 class="text-xs text-chrome-silver uppercase tracking-wider mb-2">Open Orders</h3>
				{#if !$economy?.openOrders?.length}
					<p class="text-xs text-hull-grey text-center py-3">No orders</p>
				{:else}
					<div class="space-y-1.5">
						{#each $economy.openOrders.slice(0, 5) as order}
							<div class="flex items-center justify-between text-xs">
								<span class="text-star-white truncate">{order.itemName}</span>
								<span class="{order.type === 'buy' ? 'text-bio-green' : 'text-shell-orange'} mono">
									{order.type === "buy" ? "B" : "S"} {order.priceEach}
								</span>
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Crafting Feed -->
			<div class="card p-4">
				<h3 class="text-xs text-chrome-silver uppercase tracking-wider mb-2">Crafting Feed</h3>
				{#if craftingFeed.length === 0}
					<p class="text-xs text-hull-grey text-center py-3">No crafting activity</p>
				{:else}
					<div class="space-y-1.5">
						{#each craftingFeed as craft}
							<div class="text-xs">
								<span class="text-hull-grey mono">{craft.timestamp.slice(11, 19)}</span>
								<p class="text-chrome-silver truncate">{craft.message}</p>
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Commander decisions summary -->
			<div class="card p-4">
				<h3 class="text-xs text-chrome-silver uppercase tracking-wider mb-2">Commander</h3>
				{#if $commanderLog.length === 0}
					<p class="text-xs text-hull-grey text-center py-3">No decisions</p>
				{:else}
					<div class="space-y-1.5">
						{#each $commanderLog.slice(0, 3) as decision}
							<div class="text-xs border-l-2 border-plasma-cyan/50 pl-2">
								<p class="text-chrome-silver truncate">{decision.reasoning}</p>
								<p class="text-hull-grey">{decision.assignments.length} assign(s)</p>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</div>
	</div>
</div>
