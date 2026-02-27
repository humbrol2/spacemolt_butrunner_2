<script lang="ts">
	import { onMount, onDestroy } from "svelte";
	import * as echarts from "echarts/core";
	import { LineChart, BarChart, PieChart, RadarChart, HeatmapChart } from "echarts/charts";
	import {
		GridComponent,
		TooltipComponent,
		LegendComponent,
		RadarComponent,
		VisualMapComponent,
		DataZoomComponent,
	} from "echarts/components";
	import { CanvasRenderer } from "echarts/renderers";

	echarts.use([
		LineChart,
		BarChart,
		PieChart,
		RadarChart,
		HeatmapChart,
		GridComponent,
		TooltipComponent,
		LegendComponent,
		RadarComponent,
		VisualMapComponent,
		DataZoomComponent,
		CanvasRenderer,
	]);

	interface Props {
		option: Record<string, any>;
		class?: string;
	}

	let { option, class: className = "" }: Props = $props();
	let container: HTMLDivElement;
	let chart: echarts.ECharts | null = null;
	let resizeObserver: ResizeObserver | null = null;

	onMount(() => {
		chart = echarts.init(container, "dark", { renderer: "canvas" });

		// Apply SpaceMolt dark theme overrides
		const themedOption: Record<string, any> = {
			backgroundColor: "transparent",
			textStyle: { color: "#a8c5d6", fontFamily: "'JetBrains Mono', monospace" },
			legend: { textStyle: { color: "#a8c5d6" } },
			...option,
			grid: { containLabel: true, left: 12, right: 12, top: 40, bottom: 12, ...(option.grid as any) },
		};

		chart.setOption(themedOption);

		resizeObserver = new ResizeObserver(() => chart?.resize());
		resizeObserver.observe(container);
	});

	$effect(() => {
		if (chart && option) {
			chart.setOption(option, { notMerge: false, lazyUpdate: true });
		}
	});

	onDestroy(() => {
		resizeObserver?.disconnect();
		chart?.dispose();
	});
</script>

<div bind:this={container} class="w-full h-full {className}"></div>
