<script lang="ts">
	/**
	 * Price History - Multi-series line chart with item selector for Market page.
	 */
	import Chart from "./Chart.svelte";

	interface PriceSeries {
		name: string;
		color: string;
		data: Array<{ time: string; price: number }>;
	}

	interface Props {
		series?: PriceSeries[];
		items?: string[];
		selectedItem?: string;
		onSelectItem?: (item: string) => void;
	}

	let { series = [], items = [], selectedItem = "", onSelectItem }: Props = $props();

	const option = $derived.by(() => {
		const filtered = selectedItem
			? series.filter((s) => s.name === selectedItem)
			: series.slice(0, 5);

		if (filtered.length === 0) return {};

		const times = filtered[0]?.data.map((d) => d.time.slice(11, 16)) ?? [];

		return {
			tooltip: {
				trigger: "axis",
				backgroundColor: "#0d1321ee",
				borderColor: "#3d5a6c",
				textStyle: { color: "#e8f4f8", fontSize: 12 },
			},
			legend: {
				data: filtered.map((s) => s.name),
				textStyle: { color: "#a8c5d6", fontSize: 10 },
				top: 0,
				right: 0,
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
				axisLabel: { color: "#a8c5d6", fontSize: 10 },
			},
			series: filtered.map((s) => ({
				name: s.name,
				type: "line",
				data: s.data.map((d) => d.price),
				smooth: true,
				showSymbol: false,
				lineStyle: { color: s.color, width: 2 },
			})),
			grid: { left: 8, right: 8, top: 30, bottom: 8 },
		} as any;
	});
</script>

<div class="flex flex-col h-full">
	{#if items.length > 0}
		<div class="flex gap-2 mb-2 overflow-x-auto pb-1">
			<button
				class="px-2 py-1 text-xs rounded-md shrink-0 transition-colors {!selectedItem
					? 'bg-nebula-blue text-plasma-cyan'
					: 'text-hull-grey hover:text-chrome-silver'}"
				onclick={() => onSelectItem?.("")}
			>
				All
			</button>
			{#each items as item}
				<button
					class="px-2 py-1 text-xs rounded-md shrink-0 transition-colors {selectedItem === item
						? 'bg-nebula-blue text-plasma-cyan'
						: 'text-hull-grey hover:text-chrome-silver'}"
					onclick={() => onSelectItem?.(item)}
				>
					{item}
				</button>
			{/each}
		</div>
	{/if}
	<div class="flex-1 min-h-0">
		{#if series.length > 0}
			<Chart {option} />
		{:else}
			<div class="w-full h-full flex items-center justify-center text-hull-grey text-sm">
				No price history recorded
			</div>
		{/if}
	</div>
</div>
