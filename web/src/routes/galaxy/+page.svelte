<script lang="ts">
	import { bots, galaxySystems } from "$stores/websocket";
	import GalaxyMap from "$lib/components/GalaxyMap.svelte";
	import type { GalaxySystemSummary } from "../../../../src/types/protocol";

	let activeFilters = $state<Set<string>>(new Set(["bots", "factions", "supply-flows", "market"]));

	const filterOptions = [
		{ id: "bots", label: "Bot Positions", color: "var(--color-plasma-cyan)" },
		{ id: "factions", label: "Faction Territory", color: "var(--color-void-purple)" },
		{ id: "trade-routes", label: "Trade Routes", color: "var(--color-bio-green)" },
		{ id: "supply-flows", label: "Supply Flows", color: "var(--color-shell-orange)" },
		{ id: "threats", label: "Threat Map", color: "var(--color-claw-red)" },
		{ id: "resources", label: "Resources", color: "var(--color-warning-yellow)" },
		{ id: "market", label: "Market Activity", color: "var(--color-bio-green)" },
		{ id: "skills", label: "Skill Training", color: "var(--color-laser-blue)" },
		{ id: "travel", label: "Travel Paths", color: "var(--color-chrome-silver)" },
	];

	function toggleFilter(id: string) {
		activeFilters = new Set(activeFilters);
		if (activeFilters.has(id)) {
			activeFilters.delete(id);
		} else {
			activeFilters.add(id);
		}
	}

	function handleSelectBot(botId: string) {
		window.location.href = `/bots/${botId}`;
	}

	// Map systems from store to the format GalaxyMap expects
	const mapSystems = $derived(
		$galaxySystems.map((s) => ({
			id: s.id,
			name: s.name,
			x: s.x,
			y: s.y,
			empire: s.empire,
			policeLevel: s.policeLevel,
			connections: s.connections,
			poiCount: s.poiCount,
			visited: s.visited,
		}))
	);

	// System detail panel state
	let selectedSystem = $state<string | null>(null);
	const selectedSys = $derived($galaxySystems.find((s: GalaxySystemSummary) => s.id === selectedSystem));
	const botsInSystem = $derived($bots.filter((b) => b.systemId === selectedSystem));

	function handleSelectSystem(systemId: string) {
		selectedSystem = selectedSystem === systemId ? null : systemId;
	}
</script>

<svelte:head>
	<title>Galaxy - SpaceMolt Commander</title>
</svelte:head>

<div class="space-y-4">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-star-white">Galaxy Map</h1>
		<span class="text-sm text-chrome-silver">{mapSystems.length} system(s) | {$bots.length} bot(s)</span>
	</div>

	<!-- Filter bar -->
	<div class="card p-3">
		<div class="flex flex-wrap gap-2">
			{#each filterOptions as filter}
				<button
					class="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all
						{activeFilters.has(filter.id)
						? 'bg-nebula-blue text-star-white border border-hull-grey/50'
						: 'text-hull-grey border border-hull-grey/20 hover:border-hull-grey/50 hover:text-chrome-silver'}"
					onclick={() => toggleFilter(filter.id)}
				>
					<span class="w-2 h-2 rounded-full" style="background: {filter.color}; opacity: {activeFilters.has(filter.id) ? 1 : 0.3}"></span>
					{filter.label}
				</button>
			{/each}
		</div>
	</div>

	<!-- Canvas map + optional side panel -->
	<div class="flex gap-4">
		<div class="card p-0 overflow-hidden flex-1">
			<div class="h-[calc(100vh-240px)] min-h-[400px]">
				<GalaxyMap
					systems={mapSystems}
					bots={$bots}
					{activeFilters}
					onSelectSystem={handleSelectSystem}
					onSelectBot={handleSelectBot}
				/>
			</div>
		</div>

		<!-- System detail side panel -->
		{#if selectedSys}
			<div class="card p-4 w-[360px] shrink-0 space-y-4 self-start">
				<div class="flex items-center justify-between">
					<h3 class="text-lg font-semibold text-star-white">{selectedSys.name}</h3>
					<button
						class="text-hull-grey hover:text-star-white text-sm"
						onclick={() => (selectedSystem = null)}
					>&times;</button>
				</div>

				<div class="space-y-2 text-sm">
					<div class="flex justify-between">
						<span class="text-chrome-silver">Empire</span>
						<span class="capitalize text-star-white">{selectedSys.empire || "neutral"}</span>
					</div>
					<div class="flex justify-between">
						<span class="text-chrome-silver">Police Level</span>
						<span class="text-star-white">{selectedSys.policeLevel}</span>
					</div>
					<div class="flex justify-between">
						<span class="text-chrome-silver">Connections</span>
						<span class="text-star-white">{selectedSys.connections.length}</span>
					</div>
					<div class="flex justify-between">
						<span class="text-chrome-silver">POIs</span>
						<span class="text-star-white">{selectedSys.pois.length > 0 ? selectedSys.pois.length : selectedSys.poiCount}</span>
					</div>
					<div class="flex justify-between">
						<span class="text-chrome-silver">Visited</span>
						<span class={selectedSys.visited ? 'text-bio-green' : 'text-hull-grey'}>{selectedSys.visited ? "Yes" : "No"}</span>
					</div>
				</div>

				<!-- POIs in this system -->
				<div>
					<h4 class="text-xs text-chrome-silver uppercase tracking-wider mb-2">Points of Interest</h4>
					{#if selectedSys.pois.length === 0}
						<p class="text-xs text-hull-grey">
							{#if selectedSys.poiCount > 0}
								{selectedSys.poiCount} POI(s) detected — send a bot to scan details
							{:else}
								No POI data yet (bot needs to visit this system)
							{/if}
						</p>
					{:else}
						<div class="space-y-1">
							{#each selectedSys.pois as poi}
								<div class="py-1 border-b border-hull-grey/10 last:border-0">
									<div class="flex items-center gap-2 text-xs">
										<span class="w-2 h-2 rounded-full shrink-0 {poi.hasBase ? 'bg-bio-green' : poi.type.includes('asteroid') ? 'bg-shell-orange' : poi.type.includes('gas') || poi.type.includes('nebula') ? 'bg-void-purple' : 'bg-hull-grey'}"></span>
										<span class="text-star-white flex-1">{poi.name}</span>
										<span class="text-hull-grey">{poi.type.replace(/_/g, " ")}</span>
										{#if poi.hasBase}
											<span class="text-bio-green text-[10px] bg-bio-green/10 px-1 rounded">Station</span>
										{/if}
									</div>
									{#if poi.resources && poi.resources.length > 0}
										<div class="ml-4 mt-1 space-y-1">
											{#each poi.resources as res}
												<div class="flex items-center justify-between gap-2 text-[11px] bg-deep-void/50 rounded px-2 py-0.5">
													<span class="text-shell-orange font-medium capitalize">{res.resourceId.replace(/_/g, " ")}</span>
													<div class="flex items-center gap-3">
														<span class="text-hull-grey">
															<span class="text-chrome-silver">{(res.richness * 100).toFixed(0)}%</span> rich
														</span>
														{#if res.remaining > 0}
															<span class="text-bio-green">{res.remaining.toLocaleString()} qty</span>
														{:else}
															<span class="text-claw-red">depleted</span>
														{/if}
													</div>
												</div>
											{/each}
										</div>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				</div>

				<!-- Bots in this system -->
				<div>
					<h4 class="text-xs text-chrome-silver uppercase tracking-wider mb-2">Bots Here</h4>
					{#if botsInSystem.length === 0}
						<p class="text-xs text-hull-grey">No bots in system</p>
					{:else}
						<div class="space-y-1">
							{#each botsInSystem as bot}
								<a href="/bots/{bot.id}" class="flex items-center gap-2 text-xs py-1 hover:text-plasma-cyan">
									<span
										class="status-dot"
										class:active={bot.status === "running"}
										class:idle={bot.status === "idle" || bot.status === "ready"}
									></span>
									<span class="text-star-white">{bot.username}</span>
									{#if bot.routine}
										<span style="color: var(--color-routine-{bot.routine})">{bot.routine}</span>
									{/if}
								</a>
							{/each}
						</div>
					{/if}
				</div>

				<!-- Market summary placeholder -->
				<div>
					<h4 class="text-xs text-chrome-silver uppercase tracking-wider mb-2">Market</h4>
					<p class="text-xs text-hull-grey">Market data loads when bots scan this system</p>
				</div>
			</div>
		{/if}
	</div>
</div>
