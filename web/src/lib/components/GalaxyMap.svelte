<script lang="ts">
	/**
	 * Canvas 2D Galaxy Map - Interactive map with zoom/pan, system nodes, bot positions, overlays.
	 * Renders:
	 *   1. Starfield background (procedural, covers full galaxy extent)
	 *   2. Jump connections
	 *   3. Active overlay layers (based on filter toggles)
	 *   4. System nodes (empire-colored circles)
	 *   5. Bot icons (routine-colored diamonds, offset from nodes)
	 *   6. Labels
	 *   7. Tooltip (DOM overlay)
	 */
	import { onMount, onDestroy } from "svelte";
	import type { BotSummary } from "../../../../src/types/protocol";

	interface SystemNode {
		id: string;
		name: string;
		x: number;
		y: number;
		empire: string;
		policeLevel: number;
		connections: string[];
		poiCount?: number;
		visited?: boolean;
	}

	interface Props {
		systems?: SystemNode[];
		bots?: BotSummary[];
		activeFilters?: Set<string>;
		onSelectSystem?: (systemId: string) => void;
		onSelectBot?: (botId: string) => void;
	}

	const EMPIRE_COLORS: Record<string, string> = {
		solarian: "#ffd700",
		voidborn: "#9b59b6",
		crimson: "#e63946",
		nebula: "#00d4ff",
		outerrim: "#2dd4bf",
		neutral: "#5a6a7a",
	};

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

	const POLICE_COLORS = ["#e63946", "#e6394699", "#ffd93d", "#2dd4bf", "#2dd4bf"];

	let {
		systems = [],
		bots = [],
		activeFilters = new Set<string>(),
		onSelectSystem,
		onSelectBot,
	}: Props = $props();

	let canvas: HTMLCanvasElement;
	let container: HTMLDivElement;
	let tooltipEl: HTMLDivElement;

	// View state
	let viewX = $state(0);
	let viewY = $state(0);
	let zoom = $state(1);
	let minZoom = $state(0.02);
	let isDragging = $state(false);
	let dragStartX = 0;
	let dragStartY = 0;
	let viewStartX = 0;
	let viewStartY = 0;

	// Tooltip state
	let tooltipVisible = $state(false);
	let tooltipX = $state(0);
	let tooltipY = $state(0);
	let tooltipTitle = $state("");
	let tooltipSubtitle = $state("");

	// Stars (procedural background)
	let stars: Array<{ x: number; y: number; size: number; brightness: number }> = [];

	// Galaxy bounds (computed from systems)
	let galaxyMinX = -2000;
	let galaxyMaxX = 2000;
	let galaxyMinY = -2000;
	let galaxyMaxY = 2000;

	let animFrame: number;
	let hasFittedOnce = false;
	let lastSystemCount = 0;

	function computeGalaxyBounds() {
		if (systems.length === 0) {
			galaxyMinX = -2000;
			galaxyMaxX = 2000;
			galaxyMinY = -2000;
			galaxyMaxY = 2000;
			return;
		}

		let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
		for (const sys of systems) {
			if (sys.x < minX) minX = sys.x;
			if (sys.x > maxX) maxX = sys.x;
			if (sys.y < minY) minY = sys.y;
			if (sys.y > maxY) maxY = sys.y;
		}

		// Add generous padding (30% of extent or at least 200)
		const extentX = maxX - minX || 400;
		const extentY = maxY - minY || 400;
		const padX = Math.max(200, extentX * 0.3);
		const padY = Math.max(200, extentY * 0.3);

		galaxyMinX = minX - padX;
		galaxyMaxX = maxX + padX;
		galaxyMinY = minY - padY;
		galaxyMaxY = maxY + padY;
	}

	function generateStars(count: number) {
		const rangeX = galaxyMaxX - galaxyMinX;
		const rangeY = galaxyMaxY - galaxyMinY;
		// Stars cover galaxy extent + 50% overflow so you never see sharp edges
		stars = Array.from({ length: count }, () => ({
			x: galaxyMinX - rangeX * 0.25 + Math.random() * rangeX * 1.5,
			y: galaxyMinY - rangeY * 0.25 + Math.random() * rangeY * 1.5,
			size: Math.random() * 1.5 + 0.3,
			brightness: Math.random() * 0.6 + 0.2,
		}));
	}

	/** Fit the view so all systems are visible with some padding */
	function fitToGalaxy() {
		if (!canvas || systems.length === 0) return;

		computeGalaxyBounds();

		const w = canvas.width;
		const h = canvas.height;
		if (w === 0 || h === 0) return;

		// Center of all systems
		const cx = (galaxyMinX + galaxyMaxX) / 2;
		const cy = (galaxyMinY + galaxyMaxY) / 2;

		// Zoom to fit all systems (with padding already in bounds)
		const extentX = galaxyMaxX - galaxyMinX;
		const extentY = galaxyMaxY - galaxyMinY;
		const fitZoom = Math.min(w / extentX, h / extentY);

		// Compute min zoom: allow zooming out to 50% of the fit level
		minZoom = fitZoom * 0.5;

		viewX = cx;
		viewY = cy;
		zoom = fitZoom;
	}

	function worldToScreen(wx: number, wy: number): [number, number] {
		const cx = canvas.width / 2;
		const cy = canvas.height / 2;
		return [(wx - viewX) * zoom + cx, (wy - viewY) * zoom + cy];
	}

	function screenToWorld(sx: number, sy: number): [number, number] {
		const cx = canvas.width / 2;
		const cy = canvas.height / 2;
		return [(sx - cx) / zoom + viewX, (sy - cy) / zoom + viewY];
	}

	function findNearestSystem(sx: number, sy: number, threshold = 15): SystemNode | null {
		let nearest: SystemNode | null = null;
		let minDist = threshold;
		for (const sys of systems) {
			const [px, py] = worldToScreen(sys.x, sys.y);
			const dist = Math.sqrt((sx - px) ** 2 + (sy - py) ** 2);
			if (dist < minDist) {
				minDist = dist;
				nearest = sys;
			}
		}
		return nearest;
	}

	function findNearestBot(sx: number, sy: number, threshold = 25): BotSummary | null {
		let nearest: BotSummary | null = null;
		let minDist = threshold;

		// Bots are drawn offset from their system node - match the offset logic in draw()
		const botsBySystem = new Map<string, typeof bots>();
		for (const bot of bots) {
			if (!bot.systemId) continue;
			const existing = botsBySystem.get(bot.systemId) ?? [];
			existing.push(bot);
			botsBySystem.set(bot.systemId, existing);
		}

		for (const [systemId, systemBots] of botsBySystem) {
			const sys = systems.find((s) => s.id === systemId);
			if (!sys) continue;
			const [basePx, basePy] = worldToScreen(sys.x, sys.y);
			const size = 6 * zoom;
			const nodeSize = Math.max(3, 5 * zoom);
			const baseOffsetX = nodeSize + size + 4;
			const baseOffsetY = -(nodeSize + size + 2);
			const spacing = (size * 2 + 6);

			for (let i = 0; i < systemBots.length; i++) {
				const bot = systemBots[i];
				const bx = basePx + baseOffsetX;
				const by = basePy + baseOffsetY - (i * spacing);
				const dist = Math.sqrt((sx - bx) ** 2 + (sy - by) ** 2);
				if (dist < minDist) {
					minDist = dist;
					nearest = bot;
				}
			}
		}
		return nearest;
	}

	function draw() {
		const ctx = canvas?.getContext("2d");
		if (!ctx) return;

		const w = canvas.width;
		const h = canvas.height;

		// Auto-fit when systems first arrive or change significantly
		if (systems.length > 0) {
			const systemCountChanged = systems.length !== lastSystemCount;
			if (systemCountChanged) {
				lastSystemCount = systems.length;
			}
			computeGalaxyBounds();

			// Check if coordinates are valid (spread out, not all at origin)
			const boundsExtent = (galaxyMaxX - galaxyMinX) + (galaxyMaxY - galaxyMinY);
			const hasValidCoords = boundsExtent > 800; // More than just padding

			if (systemCountChanged) {
				generateStars(Math.max(800, Math.min(3000, systems.length * 30)));
			}

			// Fit on first valid data, or re-fit if coords became valid after being collapsed
			if (hasValidCoords && !hasFittedOnce) {
				fitToGalaxy();
				hasFittedOnce = true;
			} else if (!hasValidCoords && hasFittedOnce) {
				// Coords collapsed back to (0,0) — reset so we re-fit when they're valid again
				hasFittedOnce = false;
			}
		}

		// Clear
		ctx.fillStyle = "#0a0e17";
		ctx.fillRect(0, 0, w, h);

		// 1. Starfield
		const time = Date.now() * 0.001;
		for (const star of stars) {
			const [sx, sy] = worldToScreen(star.x, star.y);
			if (sx < -10 || sx > w + 10 || sy < -10 || sy > h + 10) continue;
			const twinkle = star.brightness + Math.sin(time + star.x * 0.1) * 0.15;
			ctx.globalAlpha = Math.max(0, Math.min(1, twinkle));
			ctx.fillStyle = "#e8f4f8";
			ctx.beginPath();
			ctx.arc(sx, sy, star.size * Math.min(zoom * 0.5 + 0.5, 1.5), 0, Math.PI * 2);
			ctx.fill();
		}
		ctx.globalAlpha = 1;

		// 2. Jump connections
		ctx.lineWidth = 1;
		const systemMap = new Map(systems.map((s) => [s.id, s]));

		for (const sys of systems) {
			const [x1, y1] = worldToScreen(sys.x, sys.y);
			for (const connId of sys.connections) {
				const conn = systemMap.get(connId);
				if (!conn || conn.id < sys.id) continue; // draw each line once
				const [x2, y2] = worldToScreen(conn.x, conn.y);
				// Brighter connections between visited systems
				const bothVisited = (sys.visited ?? false) && (conn.visited ?? false);
				ctx.strokeStyle = bothVisited ? "#1a2744aa" : "#1a274444";
				ctx.beginPath();
				ctx.moveTo(x1, y1);
				ctx.lineTo(x2, y2);
				ctx.stroke();
			}
		}

		// 3. Threat overlay
		if (activeFilters.has("threats")) {
			for (const sys of systems) {
				const [sx, sy] = worldToScreen(sys.x, sys.y);
				const color = POLICE_COLORS[sys.policeLevel] ?? POLICE_COLORS[0];
				ctx.fillStyle = color + "22";
				ctx.beginPath();
				ctx.arc(sx, sy, 20 * zoom, 0, Math.PI * 2);
				ctx.fill();
			}
		}

		// 4. Faction territory overlay
		if (activeFilters.has("factions")) {
			for (const sys of systems) {
				const [sx, sy] = worldToScreen(sys.x, sys.y);
				const color = EMPIRE_COLORS[sys.empire] ?? EMPIRE_COLORS.neutral;
				ctx.fillStyle = color + "15";
				ctx.beginPath();
				ctx.arc(sx, sy, 30 * zoom, 0, Math.PI * 2);
				ctx.fill();
			}
		}

		// 5. System nodes
		for (const sys of systems) {
			const [sx, sy] = worldToScreen(sys.x, sys.y);
			if (sx < -50 || sx > w + 50 || sy < -50 || sy > h + 50) continue;

			const color = EMPIRE_COLORS[sys.empire] ?? EMPIRE_COLORS.neutral;
			const visited = sys.visited ?? false;
			const nodeSize = Math.max(3, 5 * zoom);
			const nodeAlpha = visited ? 1.0 : 0.4;

			// Glow (brighter for visited systems)
			ctx.fillStyle = color + (visited ? "44" : "18");
			ctx.beginPath();
			ctx.arc(sx, sy, nodeSize * 2, 0, Math.PI * 2);
			ctx.fill();

			// Node
			ctx.globalAlpha = nodeAlpha;
			ctx.fillStyle = color;
			ctx.beginPath();
			ctx.arc(sx, sy, nodeSize, 0, Math.PI * 2);
			ctx.fill();
			ctx.globalAlpha = 1;

			// Unvisited ring indicator (dim dashed-like outline)
			if (!visited) {
				ctx.strokeStyle = color + "55";
				ctx.lineWidth = 0.8;
				ctx.beginPath();
				ctx.arc(sx, sy, nodeSize + 2, 0, Math.PI * 2);
				ctx.stroke();
			}

			// POI count indicator (small dots around visited systems at higher zoom)
			if (visited && zoom > 0.4 && (sys.poiCount ?? 0) > 0) {
				const poiCount = Math.min(sys.poiCount ?? 0, 8); // cap visual indicators
				const indicatorRadius = nodeSize + 5;
				for (let p = 0; p < poiCount; p++) {
					const angle = (Math.PI * 2 * p) / poiCount - Math.PI / 2;
					const px = sx + Math.cos(angle) * indicatorRadius;
					const py = sy + Math.sin(angle) * indicatorRadius;
					ctx.fillStyle = "#2dd4bf88";
					ctx.beginPath();
					ctx.arc(px, py, 1.2, 0, Math.PI * 2);
					ctx.fill();
				}
			}

			// Label (only at sufficient zoom)
			if (zoom > 0.6) {
				ctx.font = `${Math.max(9, 11 * zoom)}px 'JetBrains Mono', monospace`;
				ctx.fillStyle = visited ? "#a8c5d6" : "#5a6a7a";
				ctx.textAlign = "center";
				ctx.fillText(sys.name, sx, sy + nodeSize + 12);
			}
		}

		// 6. Bot positions overlay
		if (activeFilters.has("bots")) {
			// Group bots by system for stacking
			const botsBySystem = new Map<string, typeof bots>();
			for (const bot of bots) {
				if (!bot.systemId) continue;
				const existing = botsBySystem.get(bot.systemId) ?? [];
				existing.push(bot);
				botsBySystem.set(bot.systemId, existing);
			}

			for (const [systemId, systemBots] of botsBySystem) {
				const sys = systemMap.get(systemId);
				if (!sys) continue;

				const [baseSx, baseSy] = worldToScreen(sys.x, sys.y);
				const size = 6 * zoom;
				const nodeSize = Math.max(3, 5 * zoom);
				// Offset bots above and to the right of the system node
				const baseOffsetX = nodeSize + size + 4;
				const baseOffsetY = -(nodeSize + size + 2);
				const spacing = (size * 2 + 6);

				for (let i = 0; i < systemBots.length; i++) {
					const bot = systemBots[i];
					// Stack bots vertically with spacing
					const sx = baseSx + baseOffsetX;
					const sy = baseSy + baseOffsetY - (i * spacing);
					const color = ROUTINE_COLORS[bot.routine ?? ""] ?? "#5a6a7a";

					// Diamond shape
					ctx.fillStyle = color;
					ctx.beginPath();
					ctx.moveTo(sx, sy - size);
					ctx.lineTo(sx + size, sy);
					ctx.lineTo(sx, sy + size);
					ctx.lineTo(sx - size, sy);
					ctx.closePath();
					ctx.fill();

					// Pulse for active bots
					if (bot.status === "running") {
						ctx.strokeStyle = color + "88";
						ctx.lineWidth = 1.5;
						const pulseSize = size + 3 + Math.sin(time * 2) * 2;
						ctx.beginPath();
						ctx.moveTo(sx, sy - pulseSize);
						ctx.lineTo(sx + pulseSize, sy);
						ctx.lineTo(sx, sy + pulseSize);
						ctx.lineTo(sx - pulseSize, sy);
						ctx.closePath();
						ctx.stroke();
					}

					// Bot label (to the right of the diamond)
					if (zoom > 0.5) {
						ctx.font = `${Math.max(8, 10 * zoom)}px 'JetBrains Mono', monospace`;
						ctx.fillStyle = color;
						ctx.textAlign = "left";
						ctx.fillText(bot.username, sx + size + 3, sy + 3);
					}
				}
			}
		}

		// 7. Resource overlay (highlights systems with POIs)
		if (activeFilters.has("resources")) {
			for (const sys of systems) {
				if ((sys.poiCount ?? 0) === 0) continue;
				const [sx, sy] = worldToScreen(sys.x, sys.y);
				const intensity = Math.min(1, (sys.poiCount ?? 0) / 8);
				const ringSize = (10 + intensity * 10) * zoom;
				ctx.strokeStyle = `rgba(255, 217, 61, ${0.2 + intensity * 0.3})`;
				ctx.lineWidth = 1.5;
				ctx.beginPath();
				ctx.arc(sx, sy, ringSize, 0, Math.PI * 2);
				ctx.stroke();
			}
		}

		// 8. Market activity overlay
		if (activeFilters.has("market")) {
			for (const sys of systems) {
				const [sx, sy] = worldToScreen(sys.x, sys.y);
				// Show a small market indicator
				ctx.strokeStyle = "#2dd4bf44";
				ctx.lineWidth = 1;
				ctx.beginPath();
				ctx.arc(sx, sy, 8 * zoom, 0, Math.PI * 2);
				ctx.stroke();
			}
		}

		animFrame = requestAnimationFrame(draw);
	}

	// Event handlers
	function handleWheel(e: WheelEvent) {
		e.preventDefault();
		const factor = e.deltaY > 0 ? 0.9 : 1.1;
		const newZoom = Math.max(minZoom, Math.min(10, zoom * factor));

		// Zoom toward cursor position
		const rect = canvas.getBoundingClientRect();
		const mx = e.clientX - rect.left;
		const my = e.clientY - rect.top;
		const [wx, wy] = screenToWorld(mx, my);

		zoom = newZoom;

		// Adjust view so the world point under cursor stays put
		const cx = canvas.width / 2;
		const cy = canvas.height / 2;
		viewX = wx - (mx - cx) / zoom;
		viewY = wy - (my - cy) / zoom;
	}

	function handlePointerDown(e: PointerEvent) {
		isDragging = true;
		dragStartX = e.clientX;
		dragStartY = e.clientY;
		viewStartX = viewX;
		viewStartY = viewY;
		canvas.setPointerCapture(e.pointerId);
	}

	function handlePointerMove(e: PointerEvent) {
		const rect = canvas.getBoundingClientRect();
		const mx = e.clientX - rect.left;
		const my = e.clientY - rect.top;

		if (isDragging) {
			const dx = e.clientX - dragStartX;
			const dy = e.clientY - dragStartY;
			viewX = viewStartX - dx / zoom;
			viewY = viewStartY - dy / zoom;
		} else {
			// Tooltip on hover
			const sys = findNearestSystem(mx, my);
			const bot = findNearestBot(mx, my);

			if (bot) {
				tooltipVisible = true;
				tooltipX = mx;
				tooltipY = my;
				tooltipTitle = bot.username;
				tooltipSubtitle = `${bot.routine ?? "idle"} | ${bot.systemName ?? "?"} | ${Math.round(bot.fuelPct)}% fuel`;
			} else if (sys) {
				tooltipVisible = true;
				tooltipX = mx;
				tooltipY = my;
				tooltipTitle = sys.name;
				const poiInfo = (sys.poiCount ?? 0) > 0 ? ` | ${sys.poiCount} POIs` : "";
				const visitInfo = sys.visited ? "" : " | Uncharted";
				tooltipSubtitle = `${sys.empire} | Police: ${sys.policeLevel}${poiInfo}${visitInfo}`;
			} else {
				tooltipVisible = false;
			}
		}
	}

	function handlePointerUp(e: PointerEvent) {
		if (isDragging) {
			const movedDist = Math.abs(e.clientX - dragStartX) + Math.abs(e.clientY - dragStartY);
			if (movedDist < 5) {
				// Click - not drag. Check system first (higher priority)
				const rect = canvas.getBoundingClientRect();
				const mx = e.clientX - rect.left;
				const my = e.clientY - rect.top;

				const sys = findNearestSystem(mx, my);
				const bot = findNearestBot(mx, my);

				if (sys && bot) {
					// If both found, check which is closer to the click
					const [ssx, ssy] = worldToScreen(sys.x, sys.y);
					const sysDist = Math.sqrt((mx - ssx) ** 2 + (my - ssy) ** 2);
					const nodeSize = Math.max(3, 5 * zoom);
					if (sysDist <= nodeSize * 2.5) {
						onSelectSystem?.(sys.id);
					} else {
						onSelectBot?.(bot.id);
					}
				} else if (sys) {
					onSelectSystem?.(sys.id);
				} else if (bot) {
					onSelectBot?.(bot.id);
				}
			}
		}
		isDragging = false;
	}

	function handlePointerLeave() {
		tooltipVisible = false;
	}

	function resizeCanvas() {
		if (!canvas || !container) return;
		const rect = container.getBoundingClientRect();
		canvas.width = rect.width;
		canvas.height = rect.height;
	}

	let resizeObserver: ResizeObserver | null = null;

	onMount(() => {
		resizeCanvas();
		// Initial stars (will be regenerated when systems arrive)
		computeGalaxyBounds();
		generateStars(800);

		resizeObserver = new ResizeObserver(resizeCanvas);
		resizeObserver.observe(container);

		animFrame = requestAnimationFrame(draw);
	});

	onDestroy(() => {
		resizeObserver?.disconnect();
		if (animFrame) cancelAnimationFrame(animFrame);
	});
</script>

<div bind:this={container} class="relative w-full h-full">
	<canvas
		bind:this={canvas}
		class="w-full h-full {isDragging ? 'cursor-grabbing' : 'cursor-grab'}"
		onwheel={handleWheel}
		onpointerdown={handlePointerDown}
		onpointermove={handlePointerMove}
		onpointerup={handlePointerUp}
		onpointerleave={handlePointerLeave}
	></canvas>

	<!-- Zoom controls -->
	<div class="absolute bottom-3 right-3 flex flex-col gap-1">
		<button
			class="w-8 h-8 rounded bg-deep-void/80 border border-hull-grey/30 text-chrome-silver hover:text-star-white text-sm font-bold"
			onclick={() => { zoom = Math.min(10, zoom * 1.3); }}
		>+</button>
		<button
			class="w-8 h-8 rounded bg-deep-void/80 border border-hull-grey/30 text-chrome-silver hover:text-star-white text-sm font-bold"
			onclick={() => { zoom = Math.max(minZoom, zoom * 0.7); }}
		>-</button>
		<button
			class="w-8 h-8 rounded bg-deep-void/80 border border-hull-grey/30 text-chrome-silver hover:text-star-white text-xs"
			onclick={() => fitToGalaxy()}
			title="Fit to galaxy"
		>F</button>
	</div>

	<!-- Zoom level indicator -->
	<div class="absolute bottom-3 left-3 text-xs text-hull-grey mono">
		{(zoom * 100).toFixed(0)}% | {systems.length} systems | {systems.filter(s => s.visited).length} visited
	</div>

	<!-- Tooltip overlay -->
	{#if tooltipVisible}
		<div
			bind:this={tooltipEl}
			class="absolute pointer-events-none bg-deep-void/95 border border-hull-grey/50 rounded-lg px-3 py-2 shadow-lg z-10"
			style="left: {tooltipX + 12}px; top: {tooltipY - 10}px;"
		>
			<p class="text-sm font-medium text-star-white">{tooltipTitle}</p>
			<p class="text-xs text-chrome-silver">{tooltipSubtitle}</p>
		</div>
	{/if}
</div>
