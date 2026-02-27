<script lang="ts">
	/**
	 * Price Heatmap - Stations x Items ECharts heatmap for Market page.
	 * Colors by demand: green = high demand (price above avg), red = low demand (price below avg).
	 */
	import Chart from "./Chart.svelte";

	interface PriceCell {
		station: string;
		item: string;
		price: number;
	}

	interface Props {
		data?: PriceCell[];
		stations?: string[];
		items?: string[];
	}

	let { data = [], stations = [], items = [] }: Props = $props();

	const option = $derived.by(() => {
		// Compute per-item stats for demand-relative coloring
		const itemStats = new Map<string, { min: number; max: number; avg: number; count: number }>();
		for (const d of data) {
			const stats = itemStats.get(d.item);
			if (stats) {
				stats.min = Math.min(stats.min, d.price);
				stats.max = Math.max(stats.max, d.price);
				stats.avg += d.price;
				stats.count++;
			} else {
				itemStats.set(d.item, { min: d.price, max: d.price, avg: d.price, count: 1 });
			}
		}
		for (const stats of itemStats.values()) {
			stats.avg /= stats.count;
		}

		// Normalize each cell: 0 = lowest price for item (buy here), 1 = highest (sell here / high demand)
		const heatData = data.map((d) => {
			const x = stations.indexOf(d.station);
			const y = items.indexOf(d.item);
			const stats = itemStats.get(d.item)!;
			const range = stats.max - stats.min;
			// Normalize to 0-1 within item's price range; single-station items get 0.5
			const normalized = range > 0 ? (d.price - stats.min) / range : 0.5;
			return [x, y, normalized, d.price];
		});

		return {
			tooltip: {
				position: "top",
				backgroundColor: "#0d1321ee",
				borderColor: "#3d5a6c",
				textStyle: { color: "#e8f4f8", fontSize: 12 },
				formatter: (params: any) => {
					const [x, y, norm, price] = params.data;
					const demand = norm > 0.66 ? "High" : norm > 0.33 ? "Medium" : "Low";
					return `<b>${stations[x]}</b><br/>${items[y]}: ${price?.toLocaleString() ?? "---"} cr<br/>Demand: ${demand}`;
				},
			},
			xAxis: {
				type: "category",
				data: stations,
				axisLabel: { color: "#a8c5d6", fontSize: 9, rotate: 45 },
				axisLine: { lineStyle: { color: "#3d5a6c" } },
			},
			yAxis: {
				type: "category",
				data: items,
				axisLabel: { color: "#a8c5d6", fontSize: 9 },
				axisLine: { lineStyle: { color: "#3d5a6c" } },
			},
			visualMap: {
				min: 0,
				max: 1,
				calculable: true,
				orient: "horizontal",
				left: "center",
				bottom: 0,
				text: ["High Demand", "Low Demand"],
				inRange: {
					color: ["#e63946", "#ffd93d", "#2dd4bf"],
				},
				textStyle: { color: "#a8c5d6", fontSize: 10 },
			},
			series: [
				{
					type: "heatmap",
					data: heatData,
					label: { show: false },
					emphasis: {
						itemStyle: { shadowBlur: 10, shadowColor: "rgba(0, 212, 255, 0.5)" },
					},
				},
			],
			grid: { left: 8, right: 8, top: 8, bottom: 60 },
		} as any;
	});
</script>

{#if data.length > 0}
	<Chart {option} />
{:else}
	<div class="w-full h-full flex items-center justify-center text-hull-grey text-sm">
		No market data scanned yet
	</div>
{/if}
