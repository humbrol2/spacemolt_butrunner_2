<script lang="ts">
	import { economy } from "$stores/websocket";
	import ProfitChart from "$lib/components/ProfitChart.svelte";

	type TradeRange = "1h" | "1d" | "1w" | "all";

	let tradeRange = $state<TradeRange>("1d");
	let trades = $state<Array<{
		timestamp: number;
		botId: string;
		action: string;
		itemId: string;
		quantity: number;
		priceEach: number;
		total: number;
		stationId: string | null;
	}>>([]);

	const TRADE_RANGES: { label: string; value: TradeRange }[] = [
		{ label: "1H", value: "1h" },
		{ label: "1D", value: "1d" },
		{ label: "1W", value: "1w" },
		{ label: "ALL", value: "all" },
	];

	async function fetchTrades(r: TradeRange) {
		try {
			const res = await fetch(`/api/economy/trades?range=${r}&limit=200`);
			if (res.ok) {
				trades = await res.json();
			}
		} catch {
			// silent
		}
	}

	$effect(() => {
		fetchTrades(tradeRange);
	});

	// Auto-refresh trades every 15s
	$effect(() => {
		const interval = setInterval(() => fetchTrades(tradeRange), 15_000);
		return () => clearInterval(interval);
	});

	function setTradeRange(r: TradeRange) {
		tradeRange = r;
	}

	function formatItemName(itemId: string): string {
		return itemId.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
	}

	function formatTime(ts: number): string {
		const d = new Date(ts);
		if (tradeRange === "1h" || tradeRange === "1d") {
			return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
		}
		return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	}

	// Calculate trade summary stats
	const tradeSummary = $derived.by(() => {
		let totalRevenue = 0;
		let totalCosts = 0;
		let sellCount = 0;
		let buyCount = 0;
		for (const t of trades) {
			if (t.action === "sell") {
				totalRevenue += t.total;
				sellCount++;
			} else {
				totalCosts += t.total;
				buyCount++;
			}
		}
		return { totalRevenue, totalCosts, netProfit: totalRevenue - totalCosts, sellCount, buyCount };
	});
</script>

<svelte:head>
	<title>Economy - SpaceMolt Commander</title>
</svelte:head>

<div class="space-y-4">
	<h1 class="text-2xl font-bold text-star-white">Economy</h1>

	<!-- P&L Summary -->
	<div class="grid grid-cols-1 md:grid-cols-3 gap-3">
		<div class="card p-4">
			<p class="text-xs text-chrome-silver uppercase tracking-wider">Revenue (24h)</p>
			<p class="text-2xl font-bold mono text-bio-green mt-1">
				{$economy?.totalRevenue24h?.toLocaleString() ?? "---"}
			</p>
		</div>
		<div class="card p-4">
			<p class="text-xs text-chrome-silver uppercase tracking-wider">Costs (24h)</p>
			<p class="text-2xl font-bold mono text-claw-red mt-1">
				{$economy?.totalCosts24h?.toLocaleString() ?? "---"}
			</p>
		</div>
		<div class="card p-4">
			<p class="text-xs text-chrome-silver uppercase tracking-wider">Net Profit (24h)</p>
			<p class="text-2xl font-bold mono mt-1 {($economy?.netProfit24h ?? 0) >= 0 ? 'text-bio-green' : 'text-claw-red'}">
				{$economy?.netProfit24h?.toLocaleString() ?? "---"}
			</p>
		</div>
	</div>

	<!-- Profit Chart -->
	<ProfitChart />

	<!-- Trade Activity -->
	<div class="card p-4">
		<div class="flex items-center justify-between mb-3">
			<div>
				<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider">
					Trade Activity
				</h2>
				{#if trades.length > 0}
					<p class="text-xs text-hull-grey mt-0.5">
						{tradeSummary.sellCount} sells (+{tradeSummary.totalRevenue.toLocaleString()} cr)
						&middot;
						{tradeSummary.buyCount} buys (-{tradeSummary.totalCosts.toLocaleString()} cr)
						&middot;
						Net: <span class="{tradeSummary.netProfit >= 0 ? 'text-bio-green' : 'text-claw-red'}">{tradeSummary.netProfit >= 0 ? "+" : ""}{tradeSummary.netProfit.toLocaleString()} cr</span>
					</p>
				{/if}
			</div>
			<div class="flex gap-1">
				{#each TRADE_RANGES as r}
					<button
						class="px-2 py-0.5 text-xs rounded transition-colors {tradeRange === r.value
							? 'bg-plasma-cyan/20 text-plasma-cyan'
							: 'text-hull-grey hover:text-chrome-silver'}"
						onclick={() => setTradeRange(r.value)}
					>
						{r.label}
					</button>
				{/each}
			</div>
		</div>

		{#if trades.length === 0}
			<p class="text-sm text-hull-grey py-8 text-center">No trade activity recorded</p>
		{:else}
			<div class="overflow-x-auto max-h-96 overflow-y-auto">
				<table class="w-full text-sm">
					<thead class="sticky top-0 bg-deep-space">
						<tr class="text-left text-xs text-chrome-silver uppercase tracking-wider border-b border-hull-grey/30">
							<th class="pb-2 pr-3">Time</th>
							<th class="pb-2 pr-3">Bot</th>
							<th class="pb-2 pr-3">Action</th>
							<th class="pb-2 pr-3">Item</th>
							<th class="pb-2 pr-3 text-right">Qty</th>
							<th class="pb-2 pr-3 text-right">Price</th>
							<th class="pb-2 text-right">Total</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-hull-grey/10">
						{#each trades as trade}
							<tr class="hover:bg-nebula-blue/10 transition-colors">
								<td class="py-1.5 pr-3 text-xs text-hull-grey mono whitespace-nowrap">{formatTime(trade.timestamp)}</td>
								<td class="py-1.5 pr-3 text-xs text-laser-blue">{trade.botId}</td>
								<td class="py-1.5 pr-3">
									<span class="text-xs font-medium px-1.5 py-0.5 rounded {trade.action === 'sell'
										? 'bg-bio-green/20 text-bio-green'
										: 'bg-shell-orange/20 text-shell-orange'}">
										{trade.action.toUpperCase()}
									</span>
								</td>
								<td class="py-1.5 pr-3 text-star-white text-xs">{formatItemName(trade.itemId)}</td>
								<td class="py-1.5 pr-3 text-right mono text-chrome-silver text-xs">{trade.quantity}</td>
								<td class="py-1.5 pr-3 text-right mono text-chrome-silver text-xs">{trade.priceEach.toLocaleString()} cr</td>
								<td class="py-1.5 text-right mono text-xs font-medium {trade.action === 'sell' ? 'text-bio-green' : 'text-claw-red'}">
									{trade.action === 'sell' ? '+' : '-'}{trade.total.toLocaleString()} cr
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>

	<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
		<!-- Supply deficits -->
		<div class="card p-4">
			<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
				Supply Deficits
			</h2>
			{#if !$economy?.deficits?.length}
				<p class="text-sm text-hull-grey py-4 text-center">No deficits - supply chain healthy</p>
			{:else}
				<div class="space-y-2">
					{#each $economy.deficits as deficit}
						<div class="flex items-center justify-between py-2 border-b border-hull-grey/20 last:border-0">
							<div>
								<span class="text-star-white font-medium text-sm">{deficit.itemName}</span>
								<span class="ml-2 text-xs px-1.5 py-0.5 rounded {deficit.priority === 'critical' ? 'bg-claw-red/20 text-claw-red' : deficit.priority === 'normal' ? 'bg-warning-yellow/20 text-warning-yellow' : 'bg-hull-grey/20 text-hull-grey'}">
									{deficit.priority}
								</span>
							</div>
							<div class="text-right text-xs">
								<p class="text-claw-red mono">-{deficit.shortfall}/hr</p>
								<p class="text-hull-grey">{deficit.supplyPerHour}/{deficit.demandPerHour} per hr</p>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Surpluses -->
		<div class="card p-4">
			<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
				Surpluses
			</h2>
			{#if !$economy?.surpluses?.length}
				<p class="text-sm text-hull-grey py-4 text-center">No surpluses tracked</p>
			{:else}
				<div class="space-y-2">
					{#each $economy.surpluses as surplus}
						<div class="flex items-center justify-between py-2 border-b border-hull-grey/20 last:border-0">
							<div>
								<span class="text-star-white font-medium text-sm">{surplus.itemName}</span>
								<span class="text-xs text-hull-grey ml-2">@ {surplus.stationName}</span>
							</div>
							<div class="text-right text-xs">
								<p class="text-bio-green mono">+{surplus.excessPerHour}/hr</p>
								<p class="text-hull-grey">{surplus.currentStock} in stock</p>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>

	<!-- Open orders (grouped by station) -->
	<div class="card p-4">
		<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
			Open Orders
			{#if $economy?.openOrders?.length}
				<span class="text-hull-grey font-normal ml-2">({$economy.openOrders.length})</span>
			{/if}
		</h2>
		{#if !$economy?.openOrders?.length}
			<p class="text-sm text-hull-grey py-8 text-center">No open orders</p>
		{:else}
			{@const grouped = $economy.openOrders.reduce((acc, o) => {
				const key = o.stationName || o.stationId || "Unknown";
				if (!acc.has(key)) acc.set(key, []);
				acc.get(key)!.push(o);
				return acc;
			}, new Map<string, typeof $economy.openOrders>())}
			<div class="space-y-4">
				{#each [...grouped.entries()] as [station, orders]}
					<div>
						<div class="flex items-center gap-2 mb-2">
							<span class="text-xs font-medium text-plasma-cyan">{station}</span>
							<span class="text-xs text-hull-grey">({orders.length} order{orders.length !== 1 ? "s" : ""})</span>
						</div>
						<div class="overflow-x-auto">
							<table class="w-full text-sm">
								<thead>
									<tr class="text-left text-xs text-chrome-silver uppercase tracking-wider border-b border-hull-grey/30">
										<th class="pb-2 pr-3">Type</th>
										<th class="pb-2 pr-3">Item</th>
										<th class="pb-2 pr-3 text-right">Qty</th>
										<th class="pb-2 pr-3 text-right">Price</th>
										<th class="pb-2 pr-3 text-right">Total</th>
										<th class="pb-2 pr-3 text-right">Filled</th>
										<th class="pb-2 pr-3 text-right">Age</th>
										<th class="pb-2">Bot</th>
									</tr>
								</thead>
								<tbody class="divide-y divide-hull-grey/20">
									{#each orders as order}
										{@const age = order.createdAt ? Math.floor((Date.now() - new Date(order.createdAt).getTime()) / 60_000) : -1}
										<tr class="hover:bg-nebula-blue/20 transition-colors">
											<td class="py-1.5 pr-3">
												<span class="text-xs font-medium px-2 py-0.5 rounded {order.type === 'buy' ? 'bg-bio-green/20 text-bio-green' : 'bg-shell-orange/20 text-shell-orange'}">
													{order.type.toUpperCase()}
												</span>
											</td>
											<td class="py-1.5 pr-3 text-star-white">{order.itemName}</td>
											<td class="py-1.5 pr-3 text-right mono text-chrome-silver">{order.quantity}</td>
											<td class="py-1.5 pr-3 text-right mono text-star-white">{order.priceEach.toLocaleString()}cr</td>
											<td class="py-1.5 pr-3 text-right mono text-star-white/70">{(order.priceEach * order.quantity).toLocaleString()}cr</td>
											<td class="py-1.5 pr-3 text-right mono {order.filled > 0 ? 'text-bio-green' : 'text-hull-grey'}">{order.filled}/{order.quantity}</td>
											<td class="py-1.5 pr-3 text-right text-xs {age > 60 ? 'text-shell-orange' : 'text-hull-grey'}">
												{#if age < 0}—{:else if age < 60}{age}m{:else if age < 1440}{Math.floor(age / 60)}h{:else}{Math.floor(age / 1440)}d{/if}
											</td>
											<td class="py-1.5 text-xs text-laser-blue">{order.botId}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>
