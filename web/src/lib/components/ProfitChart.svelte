<script lang="ts">
	/**
	 * Profit Chart - revenue, costs, and net profit over time.
	 * Fetches data from /api/economy/history with time range filter.
	 */
	import Chart from "./Chart.svelte";

	type Range = "1h" | "1d" | "1w" | "all";

	let range = $state<Range>("1d");
	let history = $state<Array<{ timestamp: number; revenue: number; cost: number; profit: number }>>([]);

	async function fetchHistory(r: Range) {
		try {
			const res = await fetch(`/api/economy/history?range=${r}`);
			if (res.ok) {
				history = await res.json();
			}
		} catch {
			// silent
		}
	}

	$effect(() => {
		fetchHistory(range);
	});

	// Auto-refresh every 30s
	$effect(() => {
		const interval = setInterval(() => fetchHistory(range), 30_000);
		return () => clearInterval(interval);
	});

	function setRange(r: Range) {
		range = r;
	}

	const RANGES: { label: string; value: Range }[] = [
		{ label: "1H", value: "1h" },
		{ label: "1D", value: "1d" },
		{ label: "1W", value: "1w" },
		{ label: "ALL", value: "all" },
	];

	const option = $derived.by(() => {
		if (!history || history.length === 0) return null;

		// Build cumulative series
		let cumRevenue = 0;
		let cumCost = 0;
		const times: string[] = [];
		const revenueData: number[] = [];
		const costData: number[] = [];
		const profitData: number[] = [];

		for (const d of history) {
			cumRevenue += d.revenue;
			cumCost += d.cost;
			const t = new Date(d.timestamp);
			if (range === "1h" || range === "1d") {
				times.push(t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
			} else {
				times.push(t.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
			}
			revenueData.push(cumRevenue);
			costData.push(cumCost);
			profitData.push(cumRevenue - cumCost);
		}

		return {
			tooltip: {
				trigger: "axis",
				backgroundColor: "#0d1321ee",
				borderColor: "#3d5a6c",
				textStyle: { color: "#e8f4f8", fontSize: 12 },
				formatter: (params: any) => {
					const items = Array.isArray(params) ? params : [params];
					let html = `<b>${items[0]?.axisValue ?? ""}</b>`;
					for (const p of items) {
						const color = p.color ?? "#fff";
						html += `<br/><span style="color:${color}">${p.seriesName}:</span> ${p.value?.toLocaleString() ?? "---"} cr`;
					}
					return html;
				},
			},
			legend: {
				data: ["Revenue", "Costs", "Net Profit"],
				textStyle: { color: "#a8c5d6", fontSize: 11 },
				top: 0,
				right: 0,
			},
			xAxis: {
				type: "category",
				data: times,
				axisLine: { lineStyle: { color: "#3d5a6c" } },
				axisLabel: { color: "#a8c5d6", fontSize: 10, rotate: range === "1w" || range === "all" ? 30 : 0 },
				boundaryGap: false,
			},
			yAxis: {
				type: "value",
				axisLine: { show: false },
				splitLine: { lineStyle: { color: "#1a274444" } },
				axisLabel: {
					color: "#a8c5d6",
					fontSize: 10,
					formatter: (v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(0)}k` : `${v}`),
				},
			},
			series: [
				{
					name: "Revenue",
					type: "line",
					data: revenueData,
					smooth: true,
					showSymbol: false,
					lineStyle: { color: "#4ade80", width: 2 },
					areaStyle: {
						color: {
							type: "linear",
							x: 0, y: 0, x2: 0, y2: 1,
							colorStops: [
								{ offset: 0, color: "rgba(74, 222, 128, 0.15)" },
								{ offset: 1, color: "rgba(74, 222, 128, 0.01)" },
							],
						},
					},
				},
				{
					name: "Costs",
					type: "line",
					data: costData,
					smooth: true,
					showSymbol: false,
					lineStyle: { color: "#f87171", width: 2 },
					areaStyle: {
						color: {
							type: "linear",
							x: 0, y: 0, x2: 0, y2: 1,
							colorStops: [
								{ offset: 0, color: "rgba(248, 113, 113, 0.15)" },
								{ offset: 1, color: "rgba(248, 113, 113, 0.01)" },
							],
						},
					},
				},
				{
					name: "Net Profit",
					type: "line",
					data: profitData,
					smooth: true,
					showSymbol: false,
					lineStyle: { color: "#00d4ff", width: 2.5 },
					areaStyle: {
						color: {
							type: "linear",
							x: 0, y: 0, x2: 0, y2: 1,
							colorStops: [
								{ offset: 0, color: "rgba(0, 212, 255, 0.2)" },
								{ offset: 1, color: "rgba(0, 212, 255, 0.02)" },
							],
						},
					},
				},
			],
			grid: { left: 8, right: 8, top: 36, bottom: 8 },
		} as any;
	});
</script>

<div class="card p-4">
	<div class="flex items-center justify-between mb-2">
		<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider">
			Profit & Loss
		</h2>
		<div class="flex gap-1">
			{#each RANGES as r}
				<button
					class="px-2 py-0.5 text-xs rounded transition-colors {range === r.value
						? 'bg-plasma-cyan/20 text-plasma-cyan'
						: 'text-hull-grey hover:text-chrome-silver'}"
					onclick={() => setRange(r.value)}
				>
					{r.label}
				</button>
			{/each}
		</div>
	</div>

	{#if option}
		<div class="h-64">
			<Chart {option} />
		</div>
	{:else}
		<div class="h-64 flex items-center justify-center text-hull-grey text-sm">
			Collecting financial data...
		</div>
	{/if}
</div>
