<script lang="ts">
	/**
	 * Decision Distribution - Pie chart for Training page showing routine assignment breakdown.
	 */
	import Chart from "./Chart.svelte";

	interface Props {
		/** Map of routine name → count */
		data?: Record<string, number>;
	}

	const ROUTINE_COLORS: Record<string, string> = {
		miner: "#ff6b35",
		harvester: "#ff6b35",
		trader: "#2dd4bf",
		explorer: "#00d4ff",
		crafter: "#9b59b6",
		hunter: "#e63946",
		salvager: "#ffd93d",
		mission_runner: "#ffd700",
		return_home: "#8899aa",
		scout: "#66ccff",
	};

	let { data = {} }: Props = $props();

	const option = $derived.by(() => {
		const entries = Object.entries(data).filter(([, v]) => v > 0);

		return {
			tooltip: {
				trigger: "item",
				backgroundColor: "#0d1321ee",
				borderColor: "#3d5a6c",
				textStyle: { color: "#e8f4f8", fontSize: 12 },
				formatter: "{b}: {c} ({d}%)",
			},
			legend: {
				orient: "vertical",
				right: 10,
				top: "center",
				textStyle: { color: "#a8c5d6", fontSize: 11 },
			},
			series: [
				{
					type: "pie",
					radius: ["40%", "70%"],
					center: ["35%", "50%"],
					avoidLabelOverlap: true,
					label: { show: false },
					emphasis: {
						label: { show: true, fontSize: 12, fontWeight: "bold", color: "#e8f4f8" },
					},
					data: entries.map(([name, value]) => ({
						name,
						value,
						itemStyle: { color: ROUTINE_COLORS[name] ?? "#5a6a7a" },
					})),
				},
			],
		} as any;
	});
</script>

{#if Object.keys(data).length > 0}
	<Chart {option} />
{:else}
	<div class="w-full h-full flex items-center justify-center text-hull-grey text-sm">
		No decision data collected
	</div>
{/if}
