<script lang="ts">
	import { send, commanderLog, goals as goalsStore, fleetSettings as fleetSettingsStore } from "$stores/websocket";

	let activeTab = $state("goals");

	const tabs = [
		{ id: "goals", label: "Goals" },
		{ id: "commander", label: "Commander" },
		{ id: "fleet", label: "Fleet" },
		{ id: "economy", label: "Economy" },
		{ id: "cache", label: "Cache" },
		{ id: "about", label: "About" },
	];

	// Goals state - read from live store
	let showAddGoal = $state(false);
	let newGoalType = $state("maximize_income");
	let newGoalPriority = $state(1);

	const goalTypes = [
		"maximize_income",
		"explore_region",
		"prepare_for_war",
		"level_skills",
		"establish_trade_route",
		"resource_stockpile",
		"faction_operations",
	];

	let editingIndex = $state<number | null>(null);
	let editGoalType = $state("maximize_income");
	let editGoalPriority = $state(1);

	function addGoal() {
		send({ type: "set_goal", goal: { type: newGoalType as any, priority: newGoalPriority, params: {} } });
		showAddGoal = false;
	}

	function removeGoal(index: number) {
		send({ type: "remove_goal", index });
		if (editingIndex === index) editingIndex = null;
	}

	function startEdit(index: number) {
		const goal = $goalsStore[index];
		if (!goal) return;
		editingIndex = index;
		editGoalType = goal.type;
		editGoalPriority = goal.priority;
	}

	function saveEdit() {
		if (editingIndex === null) return;
		send({ type: "update_goal" as any, index: editingIndex, goal: { type: editGoalType as any, priority: editGoalPriority, params: {} } });
		editingIndex = null;
	}

	function cancelEdit() {
		editingIndex = null;
	}

	// Commander settings
	let commanderSettings = $state({
		evaluationInterval: 60,
		reassignmentCooldown: 300,
		reassignmentThreshold: 0.3,
	});

	// Fleet settings
	let fleetSettings = $state({
		maxBots: 20,
		loginStagger: 5000,
		snapshotInterval: 30,
		factionTaxPercent: 0,
		minBotCredits: 0,
	});

	// Economy settings
	let economySettings = $state({
		enablePremiumOrders: true,
		maxPremiumPct: 50,
		minCraftingMarginPct: 30,
		batchSellSize: 100,
		orderStaleTimeout: 120,
	});

	// Sync fleet settings from backend
	$effect(() => {
		const fs = $fleetSettingsStore;
		fleetSettings.factionTaxPercent = fs.factionTaxPercent;
		fleetSettings.minBotCredits = fs.minBotCredits;
	});

	let saveSuccess = $state(false);

	function saveSettings(settings: Record<string, unknown>) {
		send({ type: "update_settings", settings });
		saveSuccess = true;
		setTimeout(() => (saveSuccess = false), 2000);
	}
</script>

<svelte:head>
	<title>Settings - SpaceMolt Commander</title>
</svelte:head>

<div class="space-y-4">
	<h1 class="text-2xl font-bold text-star-white">Settings</h1>

	<!-- Tabs -->
	<div class="border-b border-hull-grey/30">
		<div class="flex gap-0.5">
			{#each tabs as tab}
				<button
					class="px-4 py-2 text-sm font-medium border-b-2 transition-colors {activeTab === tab.id
						? 'border-plasma-cyan text-plasma-cyan'
						: 'border-transparent text-chrome-silver hover:text-star-white'}"
					onclick={() => (activeTab = tab.id)}
				>
					{tab.label}
				</button>
			{/each}
		</div>
	</div>

	<!-- Tab content -->
	<div class="card p-6 max-w-3xl">
		{#if activeTab === "goals"}
			<h2 class="text-lg font-semibold text-star-white mb-4">Fleet Goals</h2>
			<p class="text-sm text-chrome-silver mb-4">
				Define what the Commander should optimize for. Goals are evaluated in priority order.
			</p>
			<div class="space-y-3">
				{#each $goalsStore as goal, i}
					{#if editingIndex === i}
						<div class="p-3 bg-nebula-blue/30 border border-plasma-cyan/40 rounded-lg space-y-3">
							<div class="flex gap-3">
								<div class="flex-1">
									<label class="block text-xs text-chrome-silver mb-1">Goal Type</label>
									<select
										bind:value={editGoalType}
										class="w-full px-3 py-1.5 bg-deep-void border border-hull-grey/50 rounded text-star-white text-sm focus:border-plasma-cyan focus:outline-none"
									>
										{#each goalTypes as gt}
											<option value={gt}>{gt.replace(/_/g, " ")}</option>
										{/each}
									</select>
								</div>
								<div class="w-24">
									<label class="block text-xs text-chrome-silver mb-1">Priority</label>
									<input
										type="number"
										bind:value={editGoalPriority}
										min="1"
										max="10"
										class="w-full px-3 py-1.5 bg-deep-void border border-hull-grey/50 rounded text-star-white text-sm focus:border-plasma-cyan focus:outline-none"
									/>
								</div>
							</div>
							<div class="flex gap-2">
								<button
									class="px-3 py-1 text-xs font-medium rounded bg-bio-green/20 text-bio-green border border-bio-green/30 hover:bg-bio-green/30 transition-colors"
									onclick={saveEdit}
								>Save</button>
								<button
									class="px-3 py-1 text-xs font-medium rounded text-chrome-silver border border-hull-grey/30 hover:text-star-white transition-colors"
									onclick={cancelEdit}
								>Cancel</button>
							</div>
						</div>
					{:else}
						<div class="p-3 bg-nebula-blue/50 border border-hull-grey/30 rounded-lg flex items-center justify-between">
							<div>
								<p class="text-sm text-star-white font-medium">{goal.type.replace(/_/g, " ")}</p>
								<p class="text-xs text-chrome-silver">Priority {goal.priority}</p>
							</div>
							<div class="flex items-center gap-2">
								<span class="text-xs text-bio-green bg-bio-green/10 px-2 py-1 rounded">Active</span>
								<button
									class="text-hull-grey hover:text-plasma-cyan text-xs transition-colors"
									onclick={() => startEdit(i)}
									title="Edit goal"
								>edit</button>
								<button
									class="text-hull-grey hover:text-claw-red text-xs transition-colors"
									onclick={() => removeGoal(i)}
									title="Remove goal"
								>&times;</button>
							</div>
						</div>
					{/if}
				{/each}
			</div>

			{#if showAddGoal}
				<div class="mt-4 p-4 bg-nebula-blue/30 border border-hull-grey/30 rounded-lg space-y-3">
					<div>
						<label class="block text-sm text-chrome-silver mb-1">Goal Type</label>
						<select
							bind:value={newGoalType}
							class="w-full px-3 py-2 bg-deep-void border border-hull-grey/50 rounded-lg text-star-white text-sm focus:border-plasma-cyan focus:outline-none"
						>
							{#each goalTypes as gt}
								<option value={gt}>{gt.replace(/_/g, " ")}</option>
							{/each}
						</select>
					</div>
					<div>
						<label class="block text-sm text-chrome-silver mb-1">Priority (1-10)</label>
						<input
							type="number"
							bind:value={newGoalPriority}
							min="1"
							max="10"
							class="w-full px-3 py-2 bg-deep-void border border-hull-grey/50 rounded-lg text-star-white text-sm focus:border-plasma-cyan focus:outline-none"
						/>
					</div>
					<div class="flex gap-2">
						<button
							class="px-4 py-2 text-sm font-medium rounded-lg bg-plasma-cyan/20 text-plasma-cyan border border-plasma-cyan/30 hover:bg-plasma-cyan/30 transition-colors"
							onclick={addGoal}
						>Add</button>
						<button
							class="px-4 py-2 text-sm font-medium rounded-lg text-chrome-silver border border-hull-grey/30 hover:text-star-white transition-colors"
							onclick={() => (showAddGoal = false)}
						>Cancel</button>
					</div>
				</div>
			{:else}
				<button
					class="mt-4 px-4 py-2 text-sm font-medium rounded-lg bg-plasma-cyan/20 text-plasma-cyan border border-plasma-cyan/30 hover:bg-plasma-cyan/30 transition-colors"
					onclick={() => (showAddGoal = true)}
				>
					+ Add Goal
				</button>
			{/if}

			<!-- Force evaluation -->
			<div class="mt-6 pt-4 border-t border-hull-grey/30">
				<button
					class="px-4 py-2 text-sm font-medium rounded-lg bg-shell-orange/20 text-shell-orange border border-shell-orange/30 hover:bg-shell-orange/30 transition-colors"
					onclick={() => send({ type: "force_evaluation" })}
				>
					Force Commander Evaluation
				</button>
				<p class="text-xs text-hull-grey mt-1">Immediately trigger a fleet evaluation cycle</p>
			</div>

		{:else if activeTab === "commander"}
			<h2 class="text-lg font-semibold text-star-white mb-4">Commander Configuration</h2>
			<div class="space-y-4 max-w-md">
				<div>
					<label class="block text-sm text-chrome-silver mb-1">Brain Type</label>
					<select class="w-full px-3 py-2 bg-deep-void border border-hull-grey/50 rounded-lg text-star-white text-sm focus:border-plasma-cyan focus:outline-none">
						<option>Scoring</option>
						<option disabled>LLM (Coming Soon)</option>
					</select>
				</div>
				<div>
					<label class="block text-sm text-chrome-silver mb-1">Evaluation Interval (seconds)</label>
					<input
						type="number"
						bind:value={commanderSettings.evaluationInterval}
						class="w-full px-3 py-2 bg-deep-void border border-hull-grey/50 rounded-lg text-star-white text-sm focus:border-plasma-cyan focus:outline-none"
					/>
				</div>
				<div>
					<label class="block text-sm text-chrome-silver mb-1">Reassignment Cooldown (seconds)</label>
					<input
						type="number"
						bind:value={commanderSettings.reassignmentCooldown}
						class="w-full px-3 py-2 bg-deep-void border border-hull-grey/50 rounded-lg text-star-white text-sm focus:border-plasma-cyan focus:outline-none"
					/>
				</div>
				<div>
					<label class="block text-sm text-chrome-silver mb-1">Reassignment Threshold</label>
					<input
						type="number"
						bind:value={commanderSettings.reassignmentThreshold}
						step="0.05"
						class="w-full px-3 py-2 bg-deep-void border border-hull-grey/50 rounded-lg text-star-white text-sm focus:border-plasma-cyan focus:outline-none"
					/>
				</div>
			</div>

		{:else if activeTab === "fleet"}
			<h2 class="text-lg font-semibold text-star-white mb-4">Fleet Configuration</h2>
			<div class="space-y-4 max-w-md">
				<div>
					<label class="block text-sm text-chrome-silver mb-1">Max Bots</label>
					<input
						type="number"
						bind:value={fleetSettings.maxBots}
						class="w-full px-3 py-2 bg-deep-void border border-hull-grey/50 rounded-lg text-star-white text-sm focus:border-plasma-cyan focus:outline-none"
					/>
				</div>
				<div>
					<label class="block text-sm text-chrome-silver mb-1">Login Stagger (ms)</label>
					<input
						type="number"
						bind:value={fleetSettings.loginStagger}
						class="w-full px-3 py-2 bg-deep-void border border-hull-grey/50 rounded-lg text-star-white text-sm focus:border-plasma-cyan focus:outline-none"
					/>
				</div>
				<div>
					<label class="block text-sm text-chrome-silver mb-1">Snapshot Interval (seconds)</label>
					<input
						type="number"
						bind:value={fleetSettings.snapshotInterval}
						class="w-full px-3 py-2 bg-deep-void border border-hull-grey/50 rounded-lg text-star-white text-sm focus:border-plasma-cyan focus:outline-none"
					/>
				</div>
			</div>

			<h3 class="text-md font-semibold text-star-white mt-6 mb-3">Faction Treasury</h3>
			<div class="space-y-4 max-w-md">
				<div>
					<label class="block text-sm text-chrome-silver mb-1">Faction Tax (%)</label>
					<input
						type="number"
						bind:value={fleetSettings.factionTaxPercent}
						min="0"
						max="100"
						class="w-full px-3 py-2 bg-deep-void border border-hull-grey/50 rounded-lg text-star-white text-sm focus:border-plasma-cyan focus:outline-none"
					/>
					<p class="text-xs text-hull-grey mt-1">Percentage of sell profits deposited into faction treasury (0 = disabled)</p>
				</div>
				<div>
					<label class="block text-sm text-chrome-silver mb-1">Min Bot Credits</label>
					<input
						type="number"
						bind:value={fleetSettings.minBotCredits}
						min="0"
						step="1000"
						class="w-full px-3 py-2 bg-deep-void border border-hull-grey/50 rounded-lg text-star-white text-sm focus:border-plasma-cyan focus:outline-none"
					/>
					<p class="text-xs text-hull-grey mt-1">Bots below this amount withdraw from faction treasury (0 = disabled)</p>
				</div>
			</div>

		{:else if activeTab === "economy"}
			<h2 class="text-lg font-semibold text-star-white mb-4">Economy Configuration</h2>
			<div class="space-y-4 max-w-md">
				<div class="flex items-center justify-between">
					<label class="text-sm text-chrome-silver">Enable Premium Orders</label>
					<input type="checkbox" bind:checked={economySettings.enablePremiumOrders} class="w-4 h-4 accent-plasma-cyan" />
				</div>
				<div>
					<label class="block text-sm text-chrome-silver mb-1">Max Premium %</label>
					<input
						type="number"
						bind:value={economySettings.maxPremiumPct}
						class="w-full px-3 py-2 bg-deep-void border border-hull-grey/50 rounded-lg text-star-white text-sm focus:border-plasma-cyan focus:outline-none"
					/>
				</div>
				<div>
					<label class="block text-sm text-chrome-silver mb-1">Min Crafting Margin %</label>
					<input
						type="number"
						bind:value={economySettings.minCraftingMarginPct}
						class="w-full px-3 py-2 bg-deep-void border border-hull-grey/50 rounded-lg text-star-white text-sm focus:border-plasma-cyan focus:outline-none"
					/>
				</div>
				<div>
					<label class="block text-sm text-chrome-silver mb-1">Batch Sell Size</label>
					<input
						type="number"
						bind:value={economySettings.batchSellSize}
						class="w-full px-3 py-2 bg-deep-void border border-hull-grey/50 rounded-lg text-star-white text-sm focus:border-plasma-cyan focus:outline-none"
					/>
				</div>
				<div>
					<label class="block text-sm text-chrome-silver mb-1">Order Stale Timeout (minutes)</label>
					<input
						type="number"
						bind:value={economySettings.orderStaleTimeout}
						class="w-full px-3 py-2 bg-deep-void border border-hull-grey/50 rounded-lg text-star-white text-sm focus:border-plasma-cyan focus:outline-none"
					/>
				</div>
			</div>

		{:else if activeTab === "cache"}
			<h2 class="text-lg font-semibold text-star-white mb-4">Cache Management</h2>
			<div class="space-y-4">
				<div class="flex items-center justify-between p-3 bg-nebula-blue/30 rounded-lg">
					<div>
						<p class="text-sm text-star-white">Static Data (Map, Catalog, Skills)</p>
						<p class="text-xs text-chrome-silver">Refreshed on game version change</p>
					</div>
					<button
						class="px-3 py-1.5 text-xs font-medium rounded-md bg-shell-orange/20 text-shell-orange border border-shell-orange/30 hover:bg-shell-orange/30 transition-colors"
						onclick={() => send({ type: "refresh_cache", cacheKey: "static" })}
					>
						Force Refresh
					</button>
				</div>
				<div class="flex items-center justify-between p-3 bg-nebula-blue/30 rounded-lg">
					<div>
						<p class="text-sm text-star-white">Market Data</p>
						<p class="text-xs text-chrome-silver">TTL: 5 minutes</p>
					</div>
					<button
						class="px-3 py-1.5 text-xs font-medium rounded-md bg-shell-orange/20 text-shell-orange border border-shell-orange/30 hover:bg-shell-orange/30 transition-colors"
						onclick={() => send({ type: "refresh_cache", cacheKey: "market" })}
					>
						Clear Cache
					</button>
				</div>
				<div class="flex items-center justify-between p-3 bg-nebula-blue/30 rounded-lg">
					<div>
						<p class="text-sm text-star-white">System Data</p>
						<p class="text-xs text-chrome-silver">TTL: 60 minutes</p>
					</div>
					<button
						class="px-3 py-1.5 text-xs font-medium rounded-md bg-shell-orange/20 text-shell-orange border border-shell-orange/30 hover:bg-shell-orange/30 transition-colors"
						onclick={() => send({ type: "refresh_cache", cacheKey: "systems" })}
					>
						Clear Cache
					</button>
				</div>
			</div>

		{:else if activeTab === "about"}
			<h2 class="text-lg font-semibold text-star-white mb-4">About</h2>
			<div class="space-y-2 text-sm">
				<div class="flex justify-between">
					<span class="text-chrome-silver">Commander Version</span>
					<span class="text-star-white mono">2.0.0</span>
				</div>
				<div class="flex justify-between">
					<span class="text-chrome-silver">Runtime</span>
					<span class="text-star-white">Bun</span>
				</div>
				<div class="flex justify-between">
					<span class="text-chrome-silver">Frontend</span>
					<span class="text-star-white">Svelte 5 + Tailwind 4</span>
				</div>
				<div class="flex justify-between">
					<span class="text-chrome-silver">Database</span>
					<span class="text-star-white">SQLite (bun:sqlite)</span>
				</div>
				<div class="flex justify-between">
					<span class="text-chrome-silver">Game API</span>
					<span class="text-star-white">SpaceMolt HTTP API v1</span>
				</div>
			</div>
			<div class="mt-6 pt-4 border-t border-hull-grey/30">
				<p class="text-xs text-hull-grey">SpaceMolt Commander v2 - Fleet automation and training data collection</p>
			</div>
		{/if}
	</div>

	{#if activeTab !== "about" && activeTab !== "goals" && activeTab !== "cache"}
		<div class="flex items-center gap-3">
			<button
				class="px-6 py-2 text-sm font-medium rounded-lg bg-plasma-cyan/20 text-plasma-cyan border border-plasma-cyan/30 hover:bg-plasma-cyan/30 transition-colors"
				onclick={() => {
					if (activeTab === "commander") saveSettings(commanderSettings);
					else if (activeTab === "fleet") saveSettings(fleetSettings);
					else if (activeTab === "economy") saveSettings(economySettings);
				}}
			>
				Save Changes
			</button>
			{#if saveSuccess}
				<span class="text-sm text-bio-green">Saved!</span>
			{/if}
		</div>
	{/if}
</div>
