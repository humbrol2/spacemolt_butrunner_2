<script lang="ts">
	import { commanderLog, activityLog, bots, send, goals } from "$stores/websocket";
	import type { CommanderDecision, LogEntry } from "../../../../src/types/protocol";

	/** Unified timeline entry for the conversational log */
	interface TimelineEntry {
		id: string;
		timestamp: number;
		type: "thought" | "order" | "bot_reply";
		/** For thoughts: commander text. For orders: assignment description. For bot_reply: bot message. */
		message: string;
		/** Bot ID (for orders and replies) */
		botId: string | null;
		/** Routine name (for orders) */
		routine: string | null;
		/** Score (for orders) */
		score: number | null;
		/** Previous routine (for orders, when reassigning) */
		previousRoutine: string | null;
	}

	// Merge commander decisions and bot log entries into a single timeline
	const timeline = $derived.by(() => {
		const entries: TimelineEntry[] = [];
		let idCounter = 0;

		// Commander decisions → thoughts + orders
		for (const decision of $commanderLog) {
			const ts = new Date(decision.timestamp).getTime();

			// Each thought as a separate entry
			for (const thought of decision.thoughts) {
				entries.push({
					id: `cmd-${idCounter++}`,
					timestamp: ts,
					type: "thought",
					message: thought,
					botId: null,
					routine: null,
					score: null,
					previousRoutine: null,
				});
			}

			// Each assignment as an order
			for (const a of decision.assignments) {
				const prevLabel = a.previousRoutine ? ` (was ${a.previousRoutine})` : "";
				entries.push({
					id: `ord-${idCounter++}`,
					timestamp: ts + 1, // Slightly after thoughts
					type: "order",
					message: `Assigned to ${a.routine}${prevLabel}. ${a.reasoning}`,
					botId: a.botId,
					routine: a.routine,
					score: a.score,
					previousRoutine: a.previousRoutine,
				});
			}
		}

		// Bot state changes from activity log → bot replies
		for (const entry of $activityLog) {
			if (!entry.botId) continue;
			const ts = new Date(entry.timestamp).getTime();
			entries.push({
				id: `bot-${idCounter++}`,
				timestamp: ts,
				type: "bot_reply",
				message: entry.message,
				botId: entry.botId,
				routine: null,
				score: null,
				previousRoutine: null,
			});
		}

		// Sort by timestamp descending (newest first)
		entries.sort((a, b) => b.timestamp - a.timestamp);

		return entries.slice(0, 200);
	});

	// Stats
	const totalDecisions = $derived($commanderLog.length);
	const totalAssignments = $derived(
		$commanderLog.reduce((sum, d) => sum + d.assignments.length, 0)
	);
	const latestGoal = $derived.by(() => {
		if ($goals.length === 0) return "No objectives";
		const g = $goals[0];
		return `${g.type.replace(/_/g, " ")} (p${g.priority})`;
	});

	// Auto-scroll tracking
	let scrollContainer: HTMLDivElement | undefined = $state();
	let autoScroll = $state(true);
	let filter = $state<"all" | "thought" | "order" | "bot_reply">("all");

	const filteredTimeline = $derived(
		filter === "all" ? timeline : timeline.filter((e) => e.type === filter)
	);

	function formatTime(ts: number): string {
		return new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
	}

	function formatTimeAgo(ts: number): string {
		const diffSec = Math.round((Date.now() - ts) / 1000);
		if (diffSec < 60) return `${diffSec}s ago`;
		if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
		return `${Math.round(diffSec / 3600)}h ago`;
	}

	function forceEval() {
		send({ type: "force_evaluation" });
	}

	/** Get a consistent color for a bot ID */
	function botColor(botId: string): string {
		const colors = [
			"text-shell-orange", "text-bio-green", "text-laser-blue",
			"text-plasma-cyan", "text-warning-yellow", "text-claw-red",
		];
		let hash = 0;
		for (let i = 0; i < botId.length; i++) hash = (hash * 31 + botId.charCodeAt(i)) | 0;
		return colors[Math.abs(hash) % colors.length];
	}

	function botBorderColor(botId: string): string {
		const colors = [
			"border-shell-orange/40", "border-bio-green/40", "border-laser-blue/40",
			"border-plasma-cyan/40", "border-warning-yellow/40", "border-claw-red/40",
		];
		let hash = 0;
		for (let i = 0; i < botId.length; i++) hash = (hash * 31 + botId.charCodeAt(i)) | 0;
		return colors[Math.abs(hash) % colors.length];
	}
</script>

<svelte:head>
	<title>Commander - SpaceMolt Commander</title>
</svelte:head>

<div class="space-y-4">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-star-white">Commander Log</h1>
		<button
			class="px-3 py-1.5 text-xs font-medium rounded-md bg-plasma-cyan/20 text-plasma-cyan border border-plasma-cyan/30 hover:bg-plasma-cyan/30 transition-colors"
			onclick={forceEval}
		>
			Force Evaluation
		</button>
	</div>

	<!-- Quick stats -->
	<div class="grid grid-cols-2 md:grid-cols-4 gap-3">
		<div class="card p-4">
			<p class="text-xs text-chrome-silver uppercase tracking-wider">Primary Objective</p>
			<p class="text-lg font-bold text-plasma-cyan mt-1 capitalize">{latestGoal}</p>
		</div>
		<div class="card p-4">
			<p class="text-xs text-chrome-silver uppercase tracking-wider">Evaluations</p>
			<p class="text-2xl font-bold mono text-star-white mt-1">{totalDecisions}</p>
		</div>
		<div class="card p-4">
			<p class="text-xs text-chrome-silver uppercase tracking-wider">Orders Issued</p>
			<p class="text-2xl font-bold mono text-star-white mt-1">{totalAssignments}</p>
		</div>
		<div class="card p-4">
			<p class="text-xs text-chrome-silver uppercase tracking-wider">Active Bots</p>
			<p class="text-2xl font-bold mono text-star-white mt-1">{$bots.filter(b => b.status === "running").length}</p>
		</div>
	</div>

	<!-- Filter bar -->
	<div class="flex items-center gap-2">
		<span class="text-xs text-hull-grey uppercase tracking-wider mr-1">Filter:</span>
		{#each [
			{ value: "all", label: "All", count: timeline.length },
			{ value: "thought", label: "Thoughts", count: timeline.filter(e => e.type === "thought").length },
			{ value: "order", label: "Orders", count: timeline.filter(e => e.type === "order").length },
			{ value: "bot_reply", label: "Bot Replies", count: timeline.filter(e => e.type === "bot_reply").length },
		] as f}
			<button
				class="px-2.5 py-1 text-xs rounded-md transition-colors {filter === f.value
					? 'bg-nebula-blue text-star-white'
					: 'text-chrome-silver hover:text-star-white hover:bg-nebula-blue/40'}"
				onclick={() => filter = f.value as typeof filter}
			>
				{f.label}
				<span class="ml-1 text-hull-grey">({f.count})</span>
			</button>
		{/each}
	</div>

	<!-- Conversational log -->
	<div
		class="card overflow-hidden"
		bind:this={scrollContainer}
	>
		<div class="max-h-[calc(100vh-320px)] overflow-y-auto p-4 space-y-2">
			{#if filteredTimeline.length === 0}
				<div class="py-16 text-center">
					<p class="text-hull-grey text-sm">No commander activity yet.</p>
					<p class="text-hull-grey/60 text-xs mt-1">The commander evaluates the fleet periodically and posts thoughts here.</p>
				</div>
			{:else}
				{#each filteredTimeline as entry (entry.id)}
					{#if entry.type === "thought"}
						<!-- Commander thought -->
						<div class="flex gap-3 items-start">
							<div class="shrink-0 w-8 h-8 rounded-full bg-plasma-cyan/20 border border-plasma-cyan/40 flex items-center justify-center text-plasma-cyan text-xs font-bold mt-0.5">
								C
							</div>
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2 mb-0.5">
									<span class="text-xs font-semibold text-plasma-cyan">Commander</span>
									<span class="text-xs text-hull-grey mono">{formatTime(entry.timestamp)}</span>
								</div>
								<p class="text-sm text-chrome-silver leading-relaxed">{entry.message}</p>
							</div>
						</div>

					{:else if entry.type === "order"}
						<!-- Commander order to bot -->
						<div class="flex gap-3 items-start">
							<div class="shrink-0 w-8 h-8 rounded-full bg-plasma-cyan/20 border border-plasma-cyan/40 flex items-center justify-center text-plasma-cyan text-xs font-bold mt-0.5">
								C
							</div>
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2 mb-0.5">
									<span class="text-xs font-semibold text-plasma-cyan">Commander</span>
									<span class="text-xs text-hull-grey">&#8594;</span>
									{#if entry.botId}
										<a href="/bots/{entry.botId}" class="text-xs font-semibold {botColor(entry.botId)} hover:underline">{entry.botId}</a>
									{/if}
									<span class="text-xs text-hull-grey mono">{formatTime(entry.timestamp)}</span>
								</div>
								<div class="rounded-lg bg-nebula-blue/30 border border-plasma-cyan/20 px-3 py-2 mt-1">
									<div class="flex items-center gap-2">
										{#if entry.routine}
											<span class="px-1.5 py-0.5 text-xs font-medium rounded bg-plasma-cyan/20 text-plasma-cyan border border-plasma-cyan/30">
												{entry.routine}
											</span>
										{/if}
										{#if entry.score !== null}
											<span class="text-xs text-hull-grey mono">score {entry.score.toFixed(0)}</span>
										{/if}
										{#if entry.previousRoutine}
											<span class="text-xs text-hull-grey">
												(was <span class="text-chrome-silver">{entry.previousRoutine}</span>)
											</span>
										{/if}
									</div>
									<p class="text-xs text-chrome-silver mt-1">{entry.message}</p>
								</div>
							</div>
						</div>

					{:else if entry.type === "bot_reply"}
						<!-- Bot reply -->
						<div class="flex gap-3 items-start justify-end">
							<div class="flex-1 min-w-0 flex flex-col items-end">
								<div class="flex items-center gap-2 mb-0.5">
									<span class="text-xs text-hull-grey mono">{formatTime(entry.timestamp)}</span>
									{#if entry.botId}
										<a href="/bots/{entry.botId}" class="text-xs font-semibold {botColor(entry.botId)} hover:underline">{entry.botId}</a>
									{/if}
								</div>
								<div class="rounded-lg bg-deep-void/80 border {entry.botId ? botBorderColor(entry.botId) : 'border-hull-grey/20'} px-3 py-1.5 max-w-[85%]">
									<p class="text-xs text-chrome-silver">{entry.message}</p>
								</div>
							</div>
							{#if entry.botId}
								<div class="shrink-0 w-8 h-8 rounded-full bg-nebula-blue/40 border border-hull-grey/40 flex items-center justify-center text-xs font-bold mt-0.5 {botColor(entry.botId)}">
									{entry.botId.slice(0, 2).toUpperCase()}
								</div>
							{/if}
						</div>
					{/if}
				{/each}
			{/if}
		</div>
	</div>
</div>
