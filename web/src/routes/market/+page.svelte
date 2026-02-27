<script lang="ts">
	import { economy, marketStations } from "$stores/websocket";
	import PriceHistory from "$lib/components/PriceHistory.svelte";

	let selectedItem = $state("");
	let sortBy = $state<"name" | "spread" | "buy" | "sell" | "buyVol" | "sellVol">("spread");
	let sortDir = $state<"asc" | "desc">("desc");
	let expandedItem = $state<string | null>(null);

	function selectItem(item: string) {
		selectedItem = item;
	}

	// Build structured data: items aggregated across all stations
	interface StationPrice {
		stationId: string;
		stationName: string;
		buyPrice: number;
		sellPrice: number;
		buyVolume: number;
		sellVolume: number;
		fetchedAt: number;
	}

	interface GridItem {
		itemId: string;
		itemName: string;
		stations: StationPrice[];
		bestBuy: number;
		bestBuyStation: string;
		bestSell: number;
		bestSellStation: string;
		totalBuyVolume: number;
		totalSellVolume: number;
		spread: number;
	}

	const gridItems = $derived.by(() => {
		const items = new Map<string, GridItem>();

		for (const st of $marketStations) {
			for (const p of st.prices) {
				let item = items.get(p.itemId);
				if (!item) {
					item = {
						itemId: p.itemId,
						itemName: p.itemName,
						stations: [],
						bestBuy: Infinity,
						bestBuyStation: "",
						bestSell: 0,
						bestSellStation: "",
						totalBuyVolume: 0,
						totalSellVolume: 0,
						spread: 0,
					};
					items.set(p.itemId, item);
				}
				item.stations.push({
					stationId: st.stationId,
					stationName: st.stationName,
					buyPrice: p.buyPrice,
					sellPrice: p.sellPrice,
					buyVolume: p.buyVolume,
					sellVolume: p.sellVolume,
					fetchedAt: st.fetchedAt,
				});
				item.totalBuyVolume += p.buyVolume;
				item.totalSellVolume += p.sellVolume;
				if (p.buyPrice > 0 && p.buyPrice < item.bestBuy) {
					item.bestBuy = p.buyPrice;
					item.bestBuyStation = st.stationName;
				}
				if (p.sellPrice > 0 && p.sellPrice > item.bestSell) {
					item.bestSell = p.sellPrice;
					item.bestSellStation = st.stationName;
				}
			}
		}

		// Compute spread + fix sentinel values
		for (const item of items.values()) {
			if (item.bestBuy < Infinity && item.bestSell > 0) {
				item.spread = item.bestSell - item.bestBuy;
			}
			if (item.bestBuy === Infinity) item.bestBuy = 0;
			// Sort stations by sell price descending (best deals first)
			item.stations.sort((a, b) => b.sellPrice - a.sellPrice);
		}

		return [...items.values()];
	});

	const displayItems = $derived.by(() => {
		const dir = sortDir === "asc" ? 1 : -1;
		return [...gridItems].sort((a, b) => {
			switch (sortBy) {
				case "name": return a.itemName.localeCompare(b.itemName) * dir;
				case "spread": return (a.spread - b.spread) * dir;
				case "buy": return (a.bestBuy - b.bestBuy) * dir;
				case "sell": return (a.bestSell - b.bestSell) * dir;
				case "buyVol": return (a.totalBuyVolume - b.totalBuyVolume) * dir;
				case "sellVol": return (a.totalSellVolume - b.totalSellVolume) * dir;
				default: return 0;
			}
		});
	});

	// Stats
	const trackedItems = $derived(gridItems.length);
	const stationsScanned = $derived($marketStations.length);

	// Arbitrage
	const arbitrageOpps = $derived.by(() => {
		return gridItems
			.filter((item) => item.spread > 0 && item.stations.length >= 2)
			.sort((a, b) => b.spread - a.spread)
			.slice(0, 10)
			.map((item) => ({
				item: item.itemName,
				itemId: item.itemId,
				buyAt: item.bestBuyStation,
				buyPrice: item.bestBuy,
				sellAt: item.bestSellStation,
				sellPrice: item.bestSell,
				profit: item.spread,
			}));
	});

	const bestArbitrage = $derived(arbitrageOpps.length > 0 ? `${arbitrageOpps[0].profit.toLocaleString()} cr` : "---");

	// Max spread for heatmap normalization
	const maxSpread = $derived(Math.max(1, ...gridItems.map((i) => i.spread)));

	function toggleSort(col: typeof sortBy) {
		if (sortBy === col) {
			sortDir = sortDir === "asc" ? "desc" : "asc";
		} else {
			sortBy = col;
			sortDir = col === "name" ? "asc" : "desc";
		}
	}

	function sortIcon(col: typeof sortBy): string {
		if (sortBy !== col) return "";
		return sortDir === "asc" ? " \u25B2" : " \u25BC";
	}

	/** Spread heatmap: green intensity based on profit margin */
	function spreadBg(spread: number): string {
		if (spread <= 0) return "";
		const t = Math.min(spread / maxSpread, 1);
		const alpha = 0.08 + t * 0.25;
		return `background-color: rgba(45,212,191,${alpha.toFixed(2)})`;
	}

	function freshnessLabel(fetchedAt: number): string {
		const ageMin = (Date.now() - fetchedAt) / 60_000;
		if (ageMin < 1) return "just now";
		if (ageMin < 60) return `${Math.round(ageMin)}m ago`;
		return `${Math.round(ageMin / 60)}h ago`;
	}

	function freshnessDot(fetchedAt: number): string {
		const ageMin = (Date.now() - fetchedAt) / 60_000;
		if (ageMin < 10) return "bg-bio-green";
		if (ageMin < 30) return "bg-warning-yellow";
		return "bg-claw-red";
	}

	function toggleExpand(itemId: string) {
		expandedItem = expandedItem === itemId ? null : itemId;
		selectedItem = itemId;
	}
</script>

<svelte:head>
	<title>Market - SpaceMolt Commander</title>
</svelte:head>

<div class="space-y-4">
	<h1 class="text-2xl font-bold text-star-white">Market Analysis</h1>

	<!-- Quick stats -->
	<div class="grid grid-cols-3 gap-3">
		<div class="card p-4">
			<p class="text-xs text-chrome-silver uppercase tracking-wider">Tracked Items</p>
			<p class="text-2xl font-bold mono text-star-white mt-1">{trackedItems || "---"}</p>
		</div>
		<div class="card p-4">
			<p class="text-xs text-chrome-silver uppercase tracking-wider">Stations Scanned</p>
			<p class="text-2xl font-bold mono text-star-white mt-1">{stationsScanned || "---"}</p>
		</div>
		<div class="card p-4">
			<p class="text-xs text-chrome-silver uppercase tracking-wider">Best Arbitrage</p>
			<p class="text-2xl font-bold mono text-bio-green mt-1">{bestArbitrage}</p>
		</div>
	</div>

	<!-- Arbitrage opportunities -->
	{#if arbitrageOpps.length > 0}
		<div class="card p-4">
			<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
				Top Arbitrage Routes
			</h2>
			<div class="grid gap-2">
				{#each arbitrageOpps as opp}
					<button
						class="flex items-center gap-3 px-3 py-2 rounded-lg bg-deep-void/50 border border-hull-grey/15 hover:border-plasma-cyan/30 transition-colors w-full text-left"
						onclick={() => selectItem(opp.itemId)}
					>
						<span class="text-star-white font-medium text-sm min-w-[120px]">{opp.item}</span>
						<span class="text-xs text-plasma-cyan truncate">{opp.buyAt}</span>
						<span class="text-hull-grey text-xs mono">@{opp.buyPrice.toLocaleString()}</span>
						<span class="text-hull-grey text-xs">&rarr;</span>
						<span class="text-xs text-shell-orange truncate">{opp.sellAt}</span>
						<span class="text-hull-grey text-xs mono">@{opp.sellPrice.toLocaleString()}</span>
						<span class="ml-auto text-bio-green font-bold mono shrink-0">+{opp.profit.toLocaleString()}</span>
					</button>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Price table -->
	{#if displayItems.length > 0}
		<div class="card p-4">
			<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
				Price Overview
			</h2>

			<div class="overflow-y-auto max-h-[600px]">
				<table class="w-full text-sm border-collapse">
					<thead class="sticky top-0 bg-deep-void z-10">
						<tr class="text-left text-chrome-silver uppercase tracking-wider text-xs border-b border-hull-grey/30">
							<th class="pb-2 pr-3">
								<button class="hover:text-star-white transition-colors" onclick={() => toggleSort("name")}>
									Item{sortIcon("name")}
								</button>
							</th>
							<th class="pb-2 px-3 text-right">
								<button class="hover:text-star-white transition-colors" onclick={() => toggleSort("sell")}>
									Sell{sortIcon("sell")}
								</button>
							</th>
							<th class="pb-2 px-3 text-right">
								<button class="hover:text-star-white transition-colors" onclick={() => toggleSort("sellVol")}>
									Sell Qty{sortIcon("sellVol")}
								</button>
							</th>
							<th class="pb-2 px-3 text-right">
								<button class="hover:text-star-white transition-colors" onclick={() => toggleSort("buy")}>
									Buy{sortIcon("buy")}
								</button>
							</th>
							<th class="pb-2 px-3 text-right">
								<button class="hover:text-star-white transition-colors" onclick={() => toggleSort("buyVol")}>
									Buy Qty{sortIcon("buyVol")}
								</button>
							</th>
							<th class="pb-2 px-3 text-right">
								<button class="hover:text-star-white transition-colors" onclick={() => toggleSort("spread")}>
									Spread{sortIcon("spread")}
								</button>
							</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-hull-grey/10">
						{#each displayItems as item (item.itemId)}
							<tr
								class="hover:bg-nebula-blue/10 transition-colors cursor-pointer {expandedItem === item.itemId ? 'bg-nebula-blue/15' : ''}"
								style={spreadBg(item.spread)}
								onclick={() => toggleExpand(item.itemId)}
							>
								<td class="py-2 pr-3">
									<span class="text-star-white font-medium">{item.itemName}</span>
								</td>
								<td class="py-2 px-3 text-right mono">
									{#if item.bestSell > 0}
										<span class="text-bio-green">{item.bestSell.toLocaleString()}</span>
									{:else}
										<span class="text-hull-grey/40">-</span>
									{/if}
								</td>
								<td class="py-2 px-3 text-right mono text-chrome-silver">
									{item.totalSellVolume > 0 ? item.totalSellVolume.toLocaleString() : "-"}
								</td>
								<td class="py-2 px-3 text-right mono">
									{#if item.bestBuy > 0}
										<span class="text-claw-red">{item.bestBuy.toLocaleString()}</span>
									{:else}
										<span class="text-hull-grey/40">-</span>
									{/if}
								</td>
								<td class="py-2 px-3 text-right mono text-chrome-silver">
									{item.totalBuyVolume > 0 ? item.totalBuyVolume.toLocaleString() : "-"}
								</td>
								<td class="py-2 px-3 text-right mono font-medium {item.spread > 0 ? 'text-bio-green' : 'text-hull-grey/40'}">
									{item.spread > 0 ? `+${item.spread.toLocaleString()}` : "-"}
								</td>
							</tr>

							<!-- Expanded: per-station breakdown -->
							{#if expandedItem === item.itemId}
								<tr>
									<td colspan="6" class="px-4 py-3 bg-nebula-blue/5 border-t border-hull-grey/10">
										<div class="grid gap-1.5">
											<div class="grid grid-cols-[1fr,80px,60px,80px,60px,70px] gap-2 text-[10px] text-hull-grey uppercase tracking-wider pb-1 border-b border-hull-grey/15">
												<span>Station</span>
												<span class="text-right">Sell</span>
												<span class="text-right">Qty</span>
												<span class="text-right">Buy</span>
												<span class="text-right">Qty</span>
												<span class="text-right">Age</span>
											</div>
											{#each item.stations as sp}
												<div class="grid grid-cols-[1fr,80px,60px,80px,60px,70px] gap-2 items-center text-xs">
													<div class="flex items-center gap-1.5">
														<span class="w-1.5 h-1.5 rounded-full shrink-0 {freshnessDot(sp.fetchedAt)}"></span>
														<span class="text-star-white truncate">{sp.stationName}</span>
													</div>
													<span class="text-right mono {sp.sellPrice > 0 && sp.sellPrice === item.bestSell ? 'text-bio-green font-medium' : 'text-chrome-silver'}">
														{sp.sellPrice > 0 ? sp.sellPrice.toLocaleString() : "-"}
													</span>
													<span class="text-right mono text-hull-grey">
														{sp.sellVolume > 0 ? sp.sellVolume : "-"}
													</span>
													<span class="text-right mono {sp.buyPrice > 0 && sp.buyPrice === item.bestBuy ? 'text-claw-red font-medium' : 'text-chrome-silver'}">
														{sp.buyPrice > 0 ? sp.buyPrice.toLocaleString() : "-"}
													</span>
													<span class="text-right mono text-hull-grey">
														{sp.buyVolume > 0 ? sp.buyVolume : "-"}
													</span>
													<span class="text-right mono text-hull-grey text-[10px]">
														{freshnessLabel(sp.fetchedAt)}
													</span>
												</div>
											{/each}
										</div>
									</td>
								</tr>
							{/if}
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{:else}
		<div class="card p-8 text-center text-hull-grey text-sm">
			No market data scanned yet. Bots scan prices automatically when docked.
		</div>
	{/if}

	<!-- Price history -->
	<div class="card p-4">
		<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
			Price History
		</h2>
		<div class="h-64">
			<PriceHistory {selectedItem} onSelectItem={selectItem} />
		</div>
	</div>
</div>
