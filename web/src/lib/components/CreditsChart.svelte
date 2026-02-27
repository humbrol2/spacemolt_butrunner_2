<script lang="ts">
	/**
	 * Credits Over Time - line chart.
	 * Two modes:
	 *   1. Fleet mode (no data prop): fetches history from REST API with time range filters
	 *   2. Simple mode (data prop): renders provided data directly (used in bot detail)
	 */
	import Chart from "./Chart.svelte";
	import { fleetStats } from "$stores/websocket";

	type Range = "1h" | "1d" | "1w" | "1m";

	interface Props {
		data?: Array<{ time: string; credits: number }>;
	}

	let { data }: Props = $props();

	// Fleet mode state (only used when no data prop)
	let range = $state<Range>("1h");
	let history = $state<Array<{ time: string; credits: number }>>([]);
	let lastAppend = 0;

	const isFleetMode = $derived(data === undefined);
	const chartData = $derived(isFleetMode ? history : data!);

	async function fetchHistory(r: Range) {
		try {
			const res = await fetch(`/api/credits?range=${r}`);
			if (res.ok) {
				history = await res.json();
			}
		} catch {
			// silent
		}
	}

	// Fetch on mount and when range changes (fleet mode only)
	$effect(() => {
		if (isFleetMode) {
			fetchHistory(range);
		}
	});

	// Append live data from WebSocket every 30s (fleet mode only)
	$effect(() => {
		if (isFleetMode && $fleetStats && $fleetStats.totalCredits > 0) {
			const now = Date.now();
			if (now - lastAppend >= 30_000) {
				lastAppend = now;
				history = [...history, { time: new Date().toISOString(), credits: $fleetStats.totalCredits }];
			}
		}
	});

	function setRange(r: Range) {
		range = r;
		lastAppend = 0;
	}

	const RANGES: { label: string; value: Range }[] = [
		{ label: "1H", value: "1h" },
		{ label: "1D", value: "1d" },
		{ label: "1W", value: "1w" },
		{ label: "1M", value: "1m" },
	];

	const option = $derived.by(() => {
		if (!chartData || chartData.length === 0) return null;

		const times = chartData.map((d) => {
			if (!isFleetMode || range === "1h" || range === "1d") return d.time.slice(11, 16);
			return d.time.slice(5, 10) + " " + d.time.slice(11, 16);
		});
		const values = chartData.map((d) => d.credits);

		return {
			tooltip: {
				trigger: "axis",
				backgroundColor: "#0d1321ee",
				borderColor: "#3d5a6c",
				textStyle: { color: "#e8f4f8", fontSize: 12 },
				formatter: (params: any) => {
					const p = Array.isArray(params) ? params[0] : params;
					return `<b>${p.axisValue}</b><br/>Credits: ${p.value?.toLocaleString() ?? "---"}`;
				},
			},
			xAxis: {
				type: "category",
				data: times,
				axisLine: { lineStyle: { color: "#3d5a6c" } },
				axisLabel: { color: "#a8c5d6", fontSize: 10 },
				boundaryGap: false,
			},
			yAxis: {
				type: "value",
				axisLine: { show: false },
				splitLine: { lineStyle: { color: "#1a274444" } },
				axisLabel: {
					color: "#a8c5d6",
					fontSize: 10,
					formatter: (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : `${v}`),
				},
			},
			series: [
				{
					type: "line",
					data: values,
					smooth: true,
					showSymbol: false,
					lineStyle: { color: "#00d4ff", width: 2 },
					areaStyle: {
						color: {
							type: "linear",
							x: 0, y: 0, x2: 0, y2: 1,
							colorStops: [
								{ offset: 0, color: "rgba(0, 212, 255, 0.3)" },
								{ offset: 1, color: "rgba(0, 212, 255, 0.02)" },
							],
						},
					},
				},
			],
			grid: { left: 8, right: 8, top: 20, bottom: 8 },
		} as any;
	});
</script>

{#if isFleetMode}
	<div class="flex items-center justify-between mb-2">
		<h2 class="text-sm font-semibold text-chrome-silver uppercase tracking-wider">
			Credits Over Time
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
{/if}

{#if option}
	<Chart {option} />
{:else}
	<div class="w-full h-full flex items-center justify-center text-hull-grey text-sm">
		Collecting credit data...
	</div>
{/if}
