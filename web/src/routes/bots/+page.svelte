<script lang="ts">
	import { bots, send } from "$stores/websocket";

	let showAddDialog = $state(false);
	let newUsername = $state("");
	let newPassword = $state("");
	let confirmRemove = $state<string | null>(null);

	function addBot() {
		if (!newUsername.trim() || !newPassword.trim()) return;
		send({ type: "add_bot", username: newUsername.trim(), password: newPassword.trim() });
		newUsername = "";
		newPassword = "";
		showAddDialog = false;
	}

	function startBot(id: string) {
		send({ type: "start_bot", botId: id });
	}

	function stopBot(id: string) {
		send({ type: "stop_bot", botId: id });
	}

	function removeBot(id: string) {
		send({ type: "remove_bot", botId: id });
		confirmRemove = null;
	}
</script>

<svelte:head>
	<title>Bots - SpaceMolt Commander</title>
</svelte:head>

<div class="space-y-4">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-star-white">Bot Management</h1>
		<button
			class="px-4 py-2 bg-plasma-cyan/20 text-plasma-cyan border border-plasma-cyan/30 rounded-lg text-sm font-medium hover:bg-plasma-cyan/30 transition-colors"
			onclick={() => (showAddDialog = true)}
		>
			+ Add Bot
		</button>
	</div>

	<!-- Fleet summary -->
	<div class="grid grid-cols-2 md:grid-cols-5 gap-3">
		<div class="card p-3 text-center">
			<p class="text-xs text-chrome-silver">Total</p>
			<p class="text-xl font-bold mono text-star-white">{$bots.length}</p>
		</div>
		<div class="card p-3 text-center">
			<p class="text-xs text-chrome-silver">Running</p>
			<p class="text-xl font-bold mono text-bio-green">{$bots.filter((b) => b.status === "running").length}</p>
		</div>
		<div class="card p-3 text-center">
			<p class="text-xs text-chrome-silver">Idle</p>
			<p class="text-xl font-bold mono text-warning-yellow">{$bots.filter((b) => b.status === "idle" || b.status === "ready").length}</p>
		</div>
		<div class="card p-3 text-center">
			<p class="text-xs text-chrome-silver">Error</p>
			<p class="text-xl font-bold mono text-claw-red">{$bots.filter((b) => b.status === "error").length}</p>
		</div>
		<div class="card p-3 text-center">
			<p class="text-xs text-chrome-silver">Offline</p>
			<p class="text-xl font-bold mono text-hull-grey">{$bots.filter((b) => b.status === "stopping").length}</p>
		</div>
	</div>

	<!-- Bot cards grid -->
	{#if $bots.length === 0}
		<div class="card p-12 text-center">
			<p class="text-lg text-hull-grey mb-2">No bots registered yet</p>
			<p class="text-sm text-hull-grey mb-4">Add a bot to get started with fleet operations</p>
			<button
				class="px-6 py-2 bg-plasma-cyan/20 text-plasma-cyan border border-plasma-cyan/30 rounded-lg text-sm font-medium hover:bg-plasma-cyan/30 transition-colors"
				onclick={() => (showAddDialog = true)}
			>
				+ Add Your First Bot
			</button>
		</div>
	{:else}
		<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
			{#each $bots as bot}
				<div class="card p-4 hover:border-plasma-cyan/30">
					<div class="flex items-center justify-between mb-3">
						<a href="/bots/{bot.id}" class="font-semibold text-star-white hover:text-plasma-cyan transition-colors">
							{bot.username}
						</a>
						<span
							class="status-dot"
							class:active={bot.status === "running"}
							class:idle={bot.status === "idle" || bot.status === "ready"}
							class:error={bot.status === "error"}
							class:offline={bot.status === "stopping"}
						></span>
					</div>

					<div class="space-y-1.5 text-xs">
						<div class="flex justify-between">
							<span class="text-chrome-silver">Empire</span>
							<span class="text-star-white">{bot.empire}</span>
						</div>
						<div class="flex justify-between">
							<span class="text-chrome-silver">Ship</span>
							<span class="text-star-white">{bot.shipName ?? bot.shipClass ?? "Unknown"}</span>
						</div>
						<div class="flex justify-between">
							<span class="text-chrome-silver">Routine</span>
							{#if bot.routine}
								<span style="color: var(--color-routine-{bot.routine})">{bot.routine}</span>
							{:else}
								<span class="text-hull-grey">None</span>
							{/if}
						</div>
						<div class="flex justify-between">
							<span class="text-chrome-silver">Credits</span>
							<span class="text-star-white mono">{bot.credits.toLocaleString()}</span>
						</div>
						<div class="flex justify-between">
							<span class="text-chrome-silver">Location</span>
							<span class="text-star-white">{bot.systemName ?? "Unknown"}{#if bot.poiName} - {bot.poiName}{/if}</span>
						</div>
						{#if bot.destination}
							<div class="flex justify-between">
								<span class="text-chrome-silver">Destination</span>
								<span class="text-plasma-cyan">{bot.destination}{#if bot.jumpsRemaining != null} <span class="text-hull-grey">({bot.jumpsRemaining}J)</span>{/if}</span>
							</div>
						{/if}

						<!-- Fuel/Cargo bars -->
						<div class="pt-1">
							<div class="flex items-center gap-2">
								<span class="text-chrome-silver w-10">Fuel</span>
								<div class="flex-1 h-1.5 bg-hull-grey/30 rounded-full overflow-hidden">
									<div
										class="h-full rounded-full transition-all {bot.fuelPct < 20 ? 'bg-claw-red' : bot.fuelPct < 50 ? 'bg-warning-yellow' : 'bg-bio-green'}"
										style="width: {bot.fuelPct}%"
									></div>
								</div>
								<span class="text-chrome-silver mono w-16 text-right text-[10px]">{Math.round(bot.fuel)}/{Math.round(bot.maxFuel)} <span class="text-hull-grey">{Math.round(bot.fuelPct)}%</span></span>
							</div>
							<div class="flex items-center gap-2 mt-1">
								<span class="text-chrome-silver w-10">Cargo</span>
								<div class="flex-1 h-1.5 bg-hull-grey/30 rounded-full overflow-hidden">
									<div
										class="h-full bg-laser-blue rounded-full transition-all"
										style="width: {bot.cargoPct}%"
									></div>
								</div>
								<span class="text-chrome-silver mono w-16 text-right text-[10px]">{Math.round(bot.cargoUsed)}/{Math.round(bot.cargoCapacity)} <span class="text-hull-grey">{Math.round(bot.cargoPct)}%</span></span>
							</div>
						</div>
					</div>

					<!-- Actions -->
					<div class="flex gap-2 mt-3 pt-3 border-t border-hull-grey/20">
						{#if bot.status === "running"}
							<button
								class="flex-1 px-3 py-1.5 text-xs font-medium rounded-md bg-claw-red/20 text-claw-red border border-claw-red/30 hover:bg-claw-red/30 transition-colors"
								onclick={() => stopBot(bot.id)}
							>
								Stop
							</button>
						{:else}
							<button
								class="flex-1 px-3 py-1.5 text-xs font-medium rounded-md bg-bio-green/20 text-bio-green border border-bio-green/30 hover:bg-bio-green/30 transition-colors"
								onclick={() => startBot(bot.id)}
							>
								Start
							</button>
						{/if}
						<a
							href="/bots/{bot.id}"
							class="flex-1 px-3 py-1.5 text-xs font-medium rounded-md text-center bg-nebula-blue text-chrome-silver border border-hull-grey/30 hover:text-star-white transition-colors"
						>
							Details
						</a>
						{#if confirmRemove === bot.id}
							<button
								class="px-3 py-1.5 text-xs font-medium rounded-md bg-claw-red text-star-white hover:bg-claw-red/80 transition-colors"
								onclick={() => removeBot(bot.id)}
							>
								Confirm
							</button>
						{:else}
							<button
								class="px-3 py-1.5 text-xs font-medium rounded-md text-hull-grey border border-hull-grey/30 hover:text-claw-red hover:border-claw-red/30 transition-colors"
								onclick={() => (confirmRemove = bot.id)}
								title="Remove bot"
							>
								&times;
							</button>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<!-- Add bot dialog -->
{#if showAddDialog}
	<div class="fixed inset-0 z-50 flex items-center justify-center">
		<button class="absolute inset-0 bg-black/60" onclick={() => (showAddDialog = false)} aria-label="Close"></button>
		<div class="relative card p-6 w-full max-w-md">
			<h2 class="text-lg font-semibold text-star-white mb-4">Add Bot</h2>
			<form
				onsubmit={(e) => {
					e.preventDefault();
					addBot();
				}}
				class="space-y-4"
			>
				<div>
					<label for="username" class="block text-sm text-chrome-silver mb-1">Username</label>
					<input
						id="username"
						type="text"
						bind:value={newUsername}
						class="w-full px-3 py-2 bg-deep-void border border-hull-grey/50 rounded-lg text-star-white text-sm focus:border-plasma-cyan focus:outline-none"
						placeholder="Bot username"
					/>
				</div>
				<div>
					<label for="password" class="block text-sm text-chrome-silver mb-1">Password</label>
					<input
						id="password"
						type="password"
						bind:value={newPassword}
						class="w-full px-3 py-2 bg-deep-void border border-hull-grey/50 rounded-lg text-star-white text-sm focus:border-plasma-cyan focus:outline-none"
						placeholder="Bot password"
					/>
				</div>
				<div class="flex gap-3 pt-2">
					<button
						type="button"
						class="flex-1 px-4 py-2 text-sm font-medium rounded-lg text-chrome-silver border border-hull-grey/30 hover:text-star-white transition-colors"
						onclick={() => (showAddDialog = false)}
					>
						Cancel
					</button>
					<button
						type="submit"
						class="flex-1 px-4 py-2 text-sm font-medium rounded-lg bg-plasma-cyan/20 text-plasma-cyan border border-plasma-cyan/30 hover:bg-plasma-cyan/30 transition-colors"
					>
						Add Bot
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}
