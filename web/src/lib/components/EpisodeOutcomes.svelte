<script lang="ts">
	/**
	 * Episode Outcomes - Stacked area chart for Training page showing success/fail rates.
	 */
	import Chart from "./Chart.svelte";

	interface Props {
		data?: Array<{ time: string; success: number; fail: number }>;
	}

	let { data = [] }: Props = $props();

	const option = $derived.by(() => {
		const times = data.map((d) => d.time);
		const successes = data.map((d) => d.success);
		const fails = data.map((d) => d.fail);

		return {
			tooltip: {
				trigger: "axis",
				backgroundColor: "#0d1321ee",
				borderColor: "#3d5a6c",
				textStyle: { color: "#e8f4f8", fontSize: 12 },
			},
			legend: {
				data: ["Success", "Fail"],
				textStyle: { color: "#a8c5d6", fontSize: 11 },
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
			series: [
				{
					name: "Success",
					type: "line",
					stack: "total",
					data: successes,
					smooth: true,
					showSymbol: false,
					lineStyle: { color: "#2dd4bf", width: 2 },
					areaStyle: { color: "rgba(45, 212, 191, 0.2)" },
				},
				{
					name: "Fail",
					type: "line",
					stack: "total",
					data: fails,
					smooth: true,
					showSymbol: false,
					lineStyle: { color: "#e63946", width: 2 },
					areaStyle: { color: "rgba(230, 57, 70, 0.2)" },
				},
			],
			grid: { left: 8, right: 8, top: 30, bottom: 8 },
		} as any;
	});
</script>

{#if data.length > 0}
	<Chart {option} />
{:else}
	<div class="w-full h-full flex items-center justify-center text-hull-grey text-sm">
		No episode data collected
	</div>
{/if}
