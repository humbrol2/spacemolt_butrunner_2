<script lang="ts">
	import { factionState, economy } from "$stores/websocket";

	function formatItemName(id: string): string {
		return id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
	}

	const totalStorageItems = $derived(
		($factionState?.storage ?? []).reduce((sum, i) => sum + i.quantity, 0)
	);

	const storageByCategory = $derived(() => {
		const items = $factionState?.storage ?? [];
		const cats: Record<string, typeof items> = {};
		for (const item of items) {
			const cat = item.itemId.startsWith("ore_")
				? "Ores"
				: item.itemId.startsWith("refined_")
					? "Refined"
					: item.itemId.startsWith("component_")
						? "Components"
						: item.itemId.startsWith("module_")
							? "Modules"
							: "Other";
			if (!cats[cat]) cats[cat] = [];
			cats[cat].push(item);
		}
		// Sort each category by quantity desc
		for (const cat of Object.keys(cats)) {
			cats[cat].sort((a, b) => b.quantity - a.quantity);
		}
		return cats;
	});

	const onlineMembers = $derived(
		($factionState?.members ?? []).filter((m) => m.online).length
	);
</script>

<svelte:head>
	<title>Faction - SpaceMolt Commander</title>
</svelte:head>

<div class="space-y-4">
	<div class="flex items-center justify-between">
		<div class="flex items-center gap-3">
			<h1 class="text-2xl font-bold text-star-white">Faction</h1>
			{#if $factionState?.tag}
				<span class="text-sm font-mono px-2 py-0.5 rounded bg-void-purple/20 text-void-purple border border-void-purple/30">
					[{$factionState.tag}]
				</span>
			{/if}
			{#if $factionState?.name}
				<span class="text-chrome-silver text-sm">{$factionState.name}</span>
			{/if}
		</div>
		{#if $factionState?.commanderAware}
			<span class="text-xs px-2 py-1 rounded bg-bio-green/10 text-bio-green border border-bio-green/30">
				Commander Aware
			</span>
		{:else}
			<span class="text-xs px-2 py-1 rounded bg-hull-grey/10 text-hull-grey border border-hull-grey/30">
				Commander Not Using Faction Storage
			</span>
		{/if}
	</div>

	{#if !$factionState?.id}
		<!-- No faction -->
		<div class="card p-12 text-center">
			<p class="text-xl text-hull-grey mb-2">No Faction</p>
			<p class="text-sm text-hull-grey/70">
				Bots are not in a faction, or no bot is logged in yet.
			</p>
		</div>
	{:else}
		<!-- Summary cards -->
		<div class="grid grid-cols-2 md:grid-cols-4 gap-3">
			<div class="card p-4">
				<p class="text-xs text-chrome-silver uppercase tracking-wider">Treasury</p>
				<p class="text-2xl font-bold mono text-bio-green mt-1">
					{$factionState.credits.toLocaleString()}
				</p>
				<p class="text-xs text-hull-grey mt-1">credits</p>
			</div>
			<div class="card p-4">
				<p class="text-xs text-chrome-silver uppercase tracking-wider">Storage Items</p>
				<p class="text-2xl font-bold mono text-plasma-cyan mt-1">
					{totalStorageItems.toLocaleString()}
				</p>
				<p class="text-xs text-hull-grey mt-1">
					{$factionState.storage.length} type(s)
				</p>
			</div>
			<div class="card p-4">
				<p class="text-xs text-chrome-silver uppercase tracking-wider">Members</p>
				<p class="text-2xl font-bold mono text-star-white mt-1">
					{$factionState.memberCount}
				</p>
				<p class="text-xs text-hull-grey mt-1">
					{onlineMembers} online
				</p>
			</div>
			<div class="card p-4">
				<p class="text-xs text-chrome-silver uppercase tracking-wider">Storage Mode</p>
				<p class="text-lg font-bold mt-1 capitalize {$factionState.storageMode === 'faction_deposit' ? 'text-void-purple' : 'text-hull-grey'}">
					{$factionState.storageMode.replace(/_/g, " ")}
				</p>
				<p class="text-xs text-hull-grey mt-1">fleet default</p>
			</div>
		</div>

		<div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
			<!-- Storage (2/3 width) -->
			<div class="lg:col-span-2 card p-4">
				<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
					Faction Storage
				</h2>
				{#if $factionState.storage.length === 0}
					<p class="text-sm text-hull-grey py-8 text-center">Storage is empty</p>
				{:else}
					<div class="space-y-4">
						{#each Object.entries(storageByCategory()) as [category, items]}
							<div>
								<h3 class="text-xs text-hull-grey uppercase tracking-wider mb-2">{category}</h3>
								<div class="grid grid-cols-1 sm:grid-cols-2 gap-1">
									{#each items as item}
										<div class="flex items-center justify-between py-1.5 px-2 rounded bg-deep-void/50 hover:bg-nebula-blue/20 transition-colors">
											<span class="text-sm text-star-white">{item.itemName}</span>
											<span class="mono text-sm font-medium {category === 'Ores' ? 'text-shell-orange' : category === 'Refined' ? 'text-plasma-cyan' : category === 'Components' ? 'text-void-purple' : 'text-chrome-silver'}">
												{item.quantity.toLocaleString()}
											</span>
										</div>
									{/each}
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Members + Diplomacy (1/3 width) -->
			<div class="space-y-4">
				<!-- Members -->
				<div class="card p-4">
					<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
						Members
					</h2>
					{#if $factionState.members.length === 0}
						<p class="text-sm text-hull-grey py-4 text-center">
							{$factionState.memberCount} member(s) — details not available
						</p>
					{:else}
						<div class="space-y-1 max-h-[300px] overflow-y-auto">
							{#each $factionState.members.sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0)) as member}
								<div class="flex items-center justify-between py-1.5 px-2 rounded hover:bg-nebula-blue/20 transition-colors">
									<div class="flex items-center gap-2">
										<span class="w-2 h-2 rounded-full shrink-0 {member.online ? 'bg-bio-green' : 'bg-hull-grey/40'}"></span>
										<span class="text-sm {member.online ? 'text-star-white' : 'text-hull-grey'}">{member.username}</span>
									</div>
									<span class="text-xs capitalize px-1.5 py-0.5 rounded
										{member.role === 'leader' ? 'bg-warning-yellow/20 text-warning-yellow' :
										 member.role === 'officer' ? 'bg-laser-blue/20 text-laser-blue' :
										 'bg-hull-grey/10 text-hull-grey'}">
										{member.role}
									</span>
								</div>
							{/each}
						</div>
					{/if}
				</div>

				<!-- Facilities -->
				<div class="card p-4">
					<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
						Facilities
					</h2>
					{#if $factionState.facilities.length === 0}
						<p class="text-sm text-hull-grey py-4 text-center">No facilities</p>
					{:else}
						<div class="space-y-2">
							{#each $factionState.facilities as facility}
								<div class="py-2 px-2 rounded bg-deep-void/50">
									<div class="flex items-center justify-between">
										<span class="text-sm text-star-white font-medium">{facility.name}</span>
										<span class="text-xs capitalize px-1.5 py-0.5 rounded
											{facility.status === 'active' ? 'bg-bio-green/20 text-bio-green' : 'bg-hull-grey/10 text-hull-grey'}">
											{facility.status}
										</span>
									</div>
									<div class="flex items-center gap-2 mt-1 text-xs text-hull-grey">
										<span>{facility.type.replace(/_/g, " ")}</span>
										{#if facility.systemName}
											<span>- {facility.systemName}</span>
										{/if}
									</div>
								</div>
							{/each}
						</div>
					{/if}
				</div>

				<!-- Diplomacy -->
				<div class="card p-4">
					<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
						Diplomacy
					</h2>
					<div class="space-y-3">
						<div>
							<h3 class="text-xs text-bio-green mb-1.5">Allies</h3>
							{#if $factionState.allies.length === 0}
								<p class="text-xs text-hull-grey">None</p>
							{:else}
								{#each $factionState.allies as ally}
									<div class="text-sm text-star-white py-0.5">{ally.name}</div>
								{/each}
							{/if}
						</div>
						<div>
							<h3 class="text-xs text-claw-red mb-1.5">Enemies</h3>
							{#if $factionState.enemies.length === 0}
								<p class="text-xs text-hull-grey">None</p>
							{:else}
								{#each $factionState.enemies as enemy}
									<div class="text-sm text-star-white py-0.5">{enemy.name}</div>
								{/each}
							{/if}
						</div>
					</div>
				</div>
			</div>
		</div>

		<!-- Commander Integration Info -->
		<div class="card p-4">
			<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">
				Commander Integration
			</h2>
			<div class="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
				<div>
					<p class="text-chrome-silver mb-1">Faction Storage in Scoring</p>
					<p class="{$factionState.commanderAware ? 'text-bio-green' : 'text-hull-grey'}">
						{$factionState.commanderAware ? "Active" : "Inactive"}
					</p>
					<p class="text-xs text-hull-grey mt-1">
						{#if $factionState.commanderAware}
							Commander boosts miners when storage is low, boosts crafters when ore is available
						{:else}
							Set fleet storage mode to "faction_deposit" in Settings to enable
						{/if}
					</p>
				</div>
				{#if $factionState}
					{@const oreTotal = $factionState.storage.filter(i => i.itemId.startsWith("ore_")).reduce((sum, i) => sum + i.quantity, 0)}
					<div>
						<p class="text-chrome-silver mb-1">Ore in Faction Storage</p>
						<p class="mono text-shell-orange">{oreTotal.toLocaleString()}</p>
						<p class="text-xs text-hull-grey mt-1">
							{#if oreTotal < 20}
								Low — miners get priority boost
							{:else if oreTotal >= 50}
								High — crafters get priority boost
							{:else}
								Moderate supply level
							{/if}
						</p>
					</div>
				{/if}
				<div>
					<p class="text-chrome-silver mb-1">Supply Chain Status</p>
					{#if $economy?.deficits?.length}
						<p class="text-warning-yellow">{$economy.deficits.length} deficit(s)</p>
					{:else}
						<p class="text-bio-green">Healthy</p>
					{/if}
					<p class="text-xs text-hull-grey mt-1">
						Based on fleet production/consumption rates
					</p>
				</div>
			</div>
		</div>
	{/if}
</div>
