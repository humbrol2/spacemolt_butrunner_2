<script lang="ts">
	import { page } from "$app/stores";
	import { untrack } from "svelte";
	import { bots, send, activityLog, botStorage } from "$stores/websocket";
	import CreditsChart from "$lib/components/CreditsChart.svelte";
	import SkillRadar from "$lib/components/SkillRadar.svelte";

	const botId = $derived($page.params.id ?? "");
	const bot = $derived($bots.find((b) => b.id === botId));

	let activeTab = $state("overview");

	const tabs = [
		{ id: "overview", label: "Overview" },
		{ id: "storage", label: "Storage" },
		{ id: "skills", label: "Skills" },
		{ id: "history", label: "History" },
		{ id: "settings", label: "Settings" },
		{ id: "logs", label: "Logs" },
		{ id: "credentials", label: "Credentials" },
	];

	const storage = $derived($botStorage.get(botId));
	let storageRequested = $state(false);

	// Request storage when switching to storage tab
	$effect(() => {
		if (activeTab === "storage" && botId && !storageRequested) {
			storageRequested = true;
			send({ type: "request_bot_storage", botId });
		}
	});

	// Reset when bot changes
	$effect(() => {
		if (botId) {
			storageRequested = false;
		}
	});

	// Credit history for this bot (throttled to prevent reactive loops)
	let botCreditHistory = $state<Array<{ time: string; credits: number }>>([]);
	let lastBotCreditUpdate = 0;

	$effect(() => {
		if (bot) {
			// Only track `bot.credits` as dependency, not botCreditHistory
			const credits = bot.credits;
			const now = Date.now();
			const lastUpdate = untrack(() => lastBotCreditUpdate);
			if (now - lastUpdate >= 10_000) {
				lastBotCreditUpdate = now;
				const prev = untrack(() => botCreditHistory);
				botCreditHistory = [...prev.slice(-288), { time: new Date().toISOString(), credits }];
			}
		}
	});

	// Bot-specific log entries
	const botLogs = $derived(
		$activityLog.filter((e) => e.botId === botId).slice(0, 100)
	);

	// Reassign routine state
	let showReassignMenu = $state(false);
	const routines = ["miner", "harvester", "trader", "explorer", "crafter", "hunter", "salvager", "mission_runner", "return_home", "scout"];

	// Settings state - initialized from bot data when available
	let settingsForm = $state({
		maxFuelThreshold: 20,
		autoRepair: true,
		maxCargo: 90,
		storageMode: "sell" as "sell" | "deposit" | "faction_deposit",
		factionStorage: false,
	});
	let settingsInitialized = $state(false);

	// Reset settings form when navigating to a different bot
	let lastBotId = $state("");
	$effect(() => {
		if (botId !== lastBotId) {
			lastBotId = botId;
			settingsInitialized = false;
		}
	});

	$effect(() => {
		if (bot?.settings && !settingsInitialized) {
			settingsForm = {
				maxFuelThreshold: bot.settings.fuelEmergencyThreshold,
				autoRepair: bot.settings.autoRepair,
				maxCargo: bot.settings.maxCargoFillPct,
				storageMode: bot.settings.storageMode,
				factionStorage: bot.settings.factionStorage,
			};
			settingsInitialized = true;
		}
	});

	/** Format item_id to display name */
	function formatId(id: string): string {
		return id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
	}
</script>

<svelte:head>
	<title>{bot?.username ?? "Bot"} - SpaceMolt Commander</title>
</svelte:head>

<div class="space-y-4">
	<!-- Back + header -->
	<div class="flex items-center gap-3">
		<a href="/bots" class="text-chrome-silver hover:text-star-white transition-colors">
			<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
			</svg>
		</a>
		<h1 class="text-2xl font-bold text-star-white">{bot?.username ?? "Unknown Bot"}</h1>
		{#if bot}
			<span
				class="status-dot"
				class:active={bot.status === "running"}
				class:idle={bot.status === "idle" || bot.status === "ready"}
				class:error={bot.status === "error"}
				class:offline={bot.status === "stopping"}
			></span>
			<span class="text-sm text-chrome-silver capitalize">{bot.status}</span>
		{/if}
	</div>

	{#if !bot}
		<div class="card p-8 text-center">
			<p class="text-hull-grey">Bot not found or not connected</p>
			<a href="/bots" class="text-plasma-cyan hover:underline text-sm mt-2 inline-block">Back to fleet</a>
		</div>
	{:else}
		<!-- Quick stats bar -->
		<div class="grid grid-cols-2 md:grid-cols-6 gap-3">
			<div class="card p-3 text-center">
				<p class="text-xs text-chrome-silver">Credits</p>
				<p class="text-lg font-bold mono text-star-white">{bot.credits.toLocaleString()}</p>
			</div>
			<div class="card p-3 text-center">
				<p class="text-xs text-chrome-silver">cr/hr</p>
				<p class="text-lg font-bold mono {bot.creditsPerHour >= 0 ? 'text-bio-green' : 'text-claw-red'}">
					{bot.creditsPerHour >= 0 ? "+" : ""}{bot.creditsPerHour.toLocaleString()}
				</p>
			</div>
			<div class="card p-3 text-center">
				<p class="text-xs text-chrome-silver">Ship</p>
				<p class="text-sm font-medium text-star-white">{bot.shipName ?? bot.shipClass ?? "?"}</p>
			</div>
			<div class="card p-3 text-center">
				<p class="text-xs text-chrome-silver">Location</p>
				<p class="text-sm font-medium text-star-white truncate">{bot.poiName ?? bot.systemName ?? "?"}</p>
			</div>
			<div class="card p-3 text-center">
				<p class="text-xs text-chrome-silver">Fuel</p>
				<p class="text-lg font-bold mono {bot.fuelPct < 20 ? 'text-claw-red' : bot.fuelPct < 50 ? 'text-warning-yellow' : 'text-bio-green'}">
					{Math.round(bot.fuelPct)}%
				</p>
			</div>
			<div class="card p-3 text-center">
				<p class="text-xs text-chrome-silver">Cargo</p>
				<p class="text-lg font-bold mono text-laser-blue">{Math.round(bot.cargoPct)}%</p>
			</div>
		</div>

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
		<div class="card p-4">
			{#if activeTab === "overview"}
				<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
					<div>
						<h3 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">Current Assignment</h3>
						<div class="space-y-2 text-sm">
							<div class="flex justify-between">
								<span class="text-chrome-silver">Routine</span>
								{#if bot.routine}
									<span style="color: var(--color-routine-{bot.routine})" class="font-medium">{bot.routine}</span>
								{:else}
									<span class="text-hull-grey">None</span>
								{/if}
							</div>
							<div class="flex justify-between">
								<span class="text-chrome-silver">State</span>
								<span class="text-star-white">{bot.routineState || "Idle"}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-chrome-silver">Empire</span>
								<span class="text-star-white">{bot.empire}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-chrome-silver">Docked</span>
								<span class="text-star-white">{bot.docked ? "Yes" : "No"}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-chrome-silver">Hull</span>
								<span class="mono {bot.hullPct < 30 ? 'text-claw-red' : bot.hullPct < 60 ? 'text-warning-yellow' : 'text-bio-green'}">{Math.round(bot.hullPct)}%</span>
							</div>
							<div class="flex justify-between">
								<span class="text-chrome-silver">Shield</span>
								<span class="mono {bot.shieldPct < 30 ? 'text-claw-red' : bot.shieldPct < 60 ? 'text-warning-yellow' : 'text-bio-green'}">{Math.round(bot.shieldPct)}%</span>
							</div>
							<div class="flex justify-between">
								<span class="text-chrome-silver">Uptime</span>
								<span class="text-star-white mono">{Math.floor(bot.uptime / 3600000)}h {Math.floor((bot.uptime % 3600000) / 60000)}m</span>
							</div>
						</div>
					</div>
					<div>
						<h3 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">Performance</h3>
						<div class="h-40">
							<CreditsChart data={botCreditHistory} />
						</div>
					</div>
				</div>

				<!-- Ship Stats -->
				<div class="mt-4">
					<h3 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-2">Ship</h3>
					<div class="grid grid-cols-2 md:grid-cols-4 gap-3">
						<div class="rounded-lg bg-deep-void/50 p-2.5">
							<p class="text-xs text-chrome-silver">Name</p>
							<p class="text-sm font-medium text-star-white">{bot.shipName ?? "Unknown"}</p>
							<p class="text-xs text-hull-grey">{bot.shipClass ?? ""}</p>
						</div>
						{#if bot.shipStats}
						<div class="rounded-lg bg-deep-void/50 p-2.5">
							<p class="text-xs text-chrome-silver">Hull / Armor</p>
							<p class="text-sm font-medium mono text-star-white">{bot.shipStats.hull}/{bot.shipStats.maxHull}</p>
							<p class="text-xs text-hull-grey">Armor: {bot.shipStats.armor}</p>
						</div>
						<div class="rounded-lg bg-deep-void/50 p-2.5">
							<p class="text-xs text-chrome-silver">Shield</p>
							<p class="text-sm font-medium mono text-star-white">{bot.shipStats.shield}/{bot.shipStats.maxShield}</p>
						</div>
						<div class="rounded-lg bg-deep-void/50 p-2.5">
							<p class="text-xs text-chrome-silver">Speed</p>
							<p class="text-sm font-medium mono text-plasma-cyan">{bot.shipStats.speed}</p>
						</div>
						<div class="rounded-lg bg-deep-void/50 p-2.5">
							<p class="text-xs text-chrome-silver">Fuel</p>
							<p class="text-sm font-medium mono text-star-white">{bot.fuel}/{bot.maxFuel}</p>
						</div>
						<div class="rounded-lg bg-deep-void/50 p-2.5">
							<p class="text-xs text-chrome-silver">Cargo</p>
							<p class="text-sm font-medium mono text-star-white">{bot.cargoUsed}/{bot.cargoCapacity}</p>
						</div>
						<div class="rounded-lg bg-deep-void/50 p-2.5">
							<p class="text-xs text-chrome-silver">CPU</p>
							<p class="text-sm font-medium mono text-star-white">{bot.shipStats.cpuUsed}/{bot.shipStats.cpuCapacity}</p>
						</div>
						<div class="rounded-lg bg-deep-void/50 p-2.5">
							<p class="text-xs text-chrome-silver">Power</p>
							<p class="text-sm font-medium mono text-star-white">{bot.shipStats.powerUsed}/{bot.shipStats.powerCapacity}</p>
						</div>
						{/if}
					</div>
				</div>

				<!-- Modules + Cargo + Owned Ships -->
				<div class="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
					<div>
						<h3 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-2">Installed Modules</h3>
						{#if bot.modules && bot.modules.length > 0}
							<div class="space-y-1 max-h-40 overflow-y-auto">
								{#each bot.modules as mod}
									<div class="flex justify-between text-xs py-1 px-2 rounded bg-deep-void/50">
										<span class="text-star-white">{mod.name || formatId(mod.moduleId)}</span>
										<span class="mono text-hull-grey">{mod.moduleId}</span>
									</div>
								{/each}
							</div>
						{:else}
							<p class="text-xs text-hull-grey">No modules installed</p>
						{/if}
					</div>

					<div>
						<h3 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-2">Cargo Hold</h3>
						{#if bot.cargo && bot.cargo.length > 0}
							<div class="space-y-1 max-h-40 overflow-y-auto">
								{#each bot.cargo as item}
									<div class="flex justify-between text-xs py-0.5 border-b border-hull-grey/10 last:border-0">
										<span class="text-star-white">{formatId(item.itemId)}</span>
										<span class="mono text-chrome-silver">{item.quantity}</span>
									</div>
								{/each}
							</div>
						{:else}
							<p class="text-xs text-hull-grey">Empty</p>
						{/if}
					</div>

					<div>
						<h3 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-2">Owned Ships</h3>
						{#if bot.ownedShips && bot.ownedShips.length > 0}
							<div class="space-y-1 max-h-40 overflow-y-auto">
								{#each bot.ownedShips as ship}
									<div class="flex justify-between text-xs py-1 px-2 rounded bg-deep-void/50">
										<span class="text-star-white {ship.classId === bot.shipClass ? 'font-bold' : ''}">{formatId(ship.classId)}</span>
										{#if ship.classId === bot.shipClass}
											<span class="text-plasma-cyan text-[10px] font-medium">ACTIVE</span>
										{/if}
									</div>
								{/each}
							</div>
						{:else}
							<p class="text-xs text-hull-grey">No ship data</p>
						{/if}
					</div>
				</div>

				{#if bot.error}
					<div class="mt-4 p-3 bg-claw-red/10 border border-claw-red/30 rounded-lg">
						<p class="text-sm text-claw-red font-medium">Error</p>
						<p class="text-xs text-claw-red/80 mt-1">{bot.error}</p>
					</div>
				{/if}

			{:else if activeTab === "storage"}
				<div class="space-y-4">
					<div class="flex items-center justify-between">
						<h3 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider">Station Storage</h3>
						<button
							class="px-3 py-1 text-xs font-medium rounded bg-nebula-blue text-chrome-silver hover:text-star-white border border-hull-grey/30 transition-colors"
							onclick={() => { storageRequested = false; send({ type: "request_bot_storage", botId: bot.id }); storageRequested = true; }}
						>
							Refresh
						</button>
					</div>
					{#if !storage}
						<p class="text-sm text-hull-grey py-8 text-center">Loading storage data...</p>
					{:else if storage.stations.length === 0}
						<p class="text-sm text-hull-grey py-8 text-center">No items in storage</p>
					{:else}
						<div class="grid grid-cols-2 gap-3 mb-4">
							<div class="card p-3 text-center">
								<p class="text-xs text-chrome-silver">Total Items</p>
								<p class="text-xl font-bold mono text-plasma-cyan">{storage.totalItems.toLocaleString()}</p>
							</div>
							<div class="card p-3 text-center">
								<p class="text-xs text-chrome-silver">Stored Credits</p>
								<p class="text-xl font-bold mono text-bio-green">{storage.totalCredits.toLocaleString()}</p>
							</div>
						</div>
						{#each storage.stations as station}
							<div class="rounded-lg border border-hull-grey/20 overflow-hidden">
								<div class="px-3 py-2 bg-nebula-blue/30 flex items-center justify-between">
									<span class="text-sm font-medium text-star-white">{station.stationName}</span>
									{#if station.credits > 0}
										<span class="text-xs mono text-bio-green">{station.credits.toLocaleString()} cr</span>
									{/if}
								</div>
								<div class="divide-y divide-hull-grey/10">
									{#each station.items as item}
										<div class="flex items-center justify-between px-3 py-1.5 hover:bg-nebula-blue/10 transition-colors">
											<span class="text-sm text-star-white">{item.itemName || item.itemId}</span>
											<span class="mono text-sm text-chrome-silver">{item.quantity.toLocaleString()}</span>
										</div>
									{/each}
								</div>
							</div>
						{/each}
					{/if}
				</div>

			{:else if activeTab === "skills"}
				<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
					<div>
						<h3 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">Skill Radar</h3>
						<div class="h-64">
							<SkillRadar skills={bot.skills} />
						</div>
					</div>
					<div>
						<h3 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">Skill Levels</h3>
						{#if bot.skills && Object.keys(bot.skills).length > 0}
							<div class="space-y-2 max-h-64 overflow-y-auto">
								{#each Object.entries(bot.skills).sort((a, b) => b[1].level - a[1].level) as [name, skill]}
									<div class="flex items-center justify-between py-1.5 px-2 rounded bg-deep-void/50">
										<span class="text-sm text-star-white capitalize">{name.replace(/_/g, " ")}</span>
										<div class="flex items-center gap-3">
											<span class="mono text-sm font-bold text-plasma-cyan">Lv {skill.level}</span>
											{#if skill.xpNext > 0}
												<div class="w-20 h-1.5 bg-hull-grey/30 rounded-full overflow-hidden">
													<div class="h-full bg-plasma-cyan/60 rounded-full" style="width: {Math.min(100, (skill.xp / skill.xpNext) * 100)}%"></div>
												</div>
												<span class="text-xs text-hull-grey mono w-16 text-right">{skill.xp}/{skill.xpNext}</span>
											{/if}
										</div>
									</div>
								{/each}
							</div>
						{:else}
							<p class="text-xs text-hull-grey">No skill data yet — loads after bot login</p>
						{/if}
					</div>
				</div>

			{:else if activeTab === "history"}
				<h3 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">Decision History</h3>
				{#if botLogs.length === 0}
					<p class="text-sm text-hull-grey text-center py-8">No history for this bot yet</p>
				{:else}
					<div class="space-y-1 max-h-96 overflow-y-auto">
						{#each botLogs as entry}
							<div class="flex items-start gap-2 text-xs py-1 border-b border-hull-grey/10 last:border-0">
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
								<span class="text-star-white">{entry.message}</span>
							</div>
						{/each}
					</div>
				{/if}

			{:else if activeTab === "settings"}
				<h3 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">Bot Settings</h3>
				<div class="max-w-md space-y-4">
					<div>
						<label class="block text-sm text-chrome-silver mb-1">Fuel Emergency Threshold (%)</label>
						<input
							type="number"
							bind:value={settingsForm.maxFuelThreshold}
							min="5"
							max="50"
							class="w-full px-3 py-2 bg-deep-void border border-hull-grey/50 rounded-lg text-star-white text-sm focus:border-plasma-cyan focus:outline-none"
						/>
					</div>
					<div class="flex items-center justify-between">
						<label class="text-sm text-chrome-silver">Auto Repair</label>
						<input type="checkbox" bind:checked={settingsForm.autoRepair} class="w-4 h-4 accent-plasma-cyan" />
					</div>
					<div>
						<label class="block text-sm text-chrome-silver mb-1">Max Cargo Fill (%)</label>
						<input
							type="number"
							bind:value={settingsForm.maxCargo}
							min="50"
							max="100"
							class="w-full px-3 py-2 bg-deep-void border border-hull-grey/50 rounded-lg text-star-white text-sm focus:border-plasma-cyan focus:outline-none"
						/>
					</div>
					<div>
						<label class="block text-sm text-chrome-silver mb-1">Resource Handling</label>
						<select
							bind:value={settingsForm.storageMode}
							class="w-full px-3 py-2 bg-deep-void border border-hull-grey/50 rounded-lg text-star-white text-sm focus:border-plasma-cyan focus:outline-none"
						>
							<option value="sell">Sell at station</option>
							<option value="deposit">Deposit to personal storage</option>
							<option value="faction_deposit">Deposit to faction storage</option>
						</select>
						<p class="text-xs text-hull-grey mt-1">Controls how bots handle mined ore and gathered goods</p>
					</div>
					<button
						class="px-4 py-2 text-sm font-medium rounded-lg bg-plasma-cyan/20 text-plasma-cyan border border-plasma-cyan/30 hover:bg-plasma-cyan/30 transition-colors"
						onclick={() => send({ type: "update_bot_settings", botId: bot.id, settings: settingsForm })}
					>
						Save Settings
					</button>
				</div>

			{:else if activeTab === "logs"}
				<h3 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider mb-3">Live Log Stream</h3>
				<div class="bg-space-black rounded-lg p-3 font-mono text-xs max-h-96 overflow-y-auto">
					{#if botLogs.length === 0}
						<p class="text-hull-grey">Waiting for log entries...</p>
					{:else}
						{#each botLogs as entry}
							<div class="py-0.5">
								<span class="text-hull-grey">{entry.timestamp.slice(11, 23)}</span>
								<span class="{entry.level === 'error' ? 'text-claw-red' : entry.level === 'warn' ? 'text-warning-yellow' : entry.level === 'cmd' ? 'text-plasma-cyan' : 'text-chrome-silver'}"> [{entry.level.toUpperCase()}]</span>
								<span class="text-star-white"> {entry.message}</span>
							</div>
						{/each}
					{/if}
				</div>

			{:else if activeTab === "credentials"}
				<div class="max-w-md">
					<p class="text-sm text-chrome-silver mb-4">Bot login credentials are stored locally in SQLite. Passwords are never sent to the dashboard.</p>
					<div class="space-y-3">
						<div>
							<label class="block text-sm text-chrome-silver mb-1">Username</label>
							<input
								type="text"
								value={bot.username}
								disabled
								class="w-full px-3 py-2 bg-deep-void border border-hull-grey/30 rounded-lg text-hull-grey text-sm"
							/>
						</div>
						<div>
							<label class="block text-sm text-chrome-silver mb-1">Password</label>
							<input
								type="password"
								value="********"
								disabled
								class="w-full px-3 py-2 bg-deep-void border border-hull-grey/30 rounded-lg text-hull-grey text-sm"
							/>
						</div>
					</div>
				</div>
			{/if}
		</div>

		<!-- Actions -->
		<div class="flex gap-3">
			{#if bot.status === "running"}
				<button
					class="px-4 py-2 text-sm font-medium rounded-lg bg-claw-red/20 text-claw-red border border-claw-red/30 hover:bg-claw-red/30 transition-colors"
					onclick={() => send({ type: "stop_bot", botId: bot.id })}
				>
					Stop Bot
				</button>
			{:else}
				<button
					class="px-4 py-2 text-sm font-medium rounded-lg bg-bio-green/20 text-bio-green border border-bio-green/30 hover:bg-bio-green/30 transition-colors"
					onclick={() => send({ type: "start_bot", botId: bot.id })}
				>
					Start Bot
				</button>
			{/if}

			<!-- Force Reassign dropdown -->
			<div class="relative">
				<button
					class="px-4 py-2 text-sm font-medium rounded-lg bg-nebula-blue text-chrome-silver border border-hull-grey/30 hover:text-star-white transition-colors"
					onclick={() => (showReassignMenu = !showReassignMenu)}
				>
					Force Reassign
				</button>
				{#if showReassignMenu}
					<button class="fixed inset-0 z-40" onclick={() => (showReassignMenu = false)} aria-label="Close menu"></button>
					<div class="absolute left-0 top-full mt-1 z-50 bg-deep-void border border-hull-grey/50 rounded-lg shadow-xl py-1 min-w-[160px]">
						{#each routines as routine}
							<button
								class="w-full text-left px-3 py-1.5 text-sm hover:bg-nebula-blue/50 transition-colors"
								style="color: var(--color-routine-{routine})"
								onclick={() => {
									send({ type: "force_reassign", botId: bot.id, routine: routine as any });
									showReassignMenu = false;
								}}
							>
								{routine}
							</button>
						{/each}
					</div>
				{/if}
			</div>
		</div>
	{/if}
</div>
