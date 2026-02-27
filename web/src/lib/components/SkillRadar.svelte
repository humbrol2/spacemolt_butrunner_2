<script lang="ts">
	/**
	 * Skill Radar - Spider chart for bot detail Skills tab.
	 */
	import Chart from "./Chart.svelte";

	interface Props {
		skills?: Record<string, { level: number; xp: number; xpNext?: number; maxXp?: number }>;
	}

	let { skills = {} }: Props = $props();

	const option = $derived.by(() => {
		const entries = Object.entries(skills);
		if (entries.length === 0) return {};

		const maxLevel = Math.max(...entries.map(([, s]) => s.level), 10);

		return {
			tooltip: {
				backgroundColor: "#0d1321ee",
				borderColor: "#3d5a6c",
				textStyle: { color: "#e8f4f8", fontSize: 12 },
			},
			radar: {
				indicator: entries.map(([name]) => ({
					name: name.replace(/_/g, " "),
					max: maxLevel,
				})),
				shape: "polygon",
				axisName: { color: "#a8c5d6", fontSize: 10 },
				splitArea: { areaStyle: { color: ["#0d132100", "#1a274422"] } },
				splitLine: { lineStyle: { color: "#3d5a6c44" } },
				axisLine: { lineStyle: { color: "#3d5a6c44" } },
			},
			series: [
				{
					type: "radar",
					data: [
						{
							value: entries.map(([, s]) => s.level),
							name: "Level",
							areaStyle: { color: "rgba(0, 212, 255, 0.15)" },
							lineStyle: { color: "#00d4ff", width: 2 },
							itemStyle: { color: "#00d4ff" },
						},
					],
				},
			],
		} as any;
	});
</script>

{#if Object.keys(skills).length > 0}
	<div class="h-full">
		<Chart {option} />
	</div>
{:else}
	<div class="w-full h-full flex items-center justify-center text-hull-grey text-sm">
		No skill data available
	</div>
{/if}
