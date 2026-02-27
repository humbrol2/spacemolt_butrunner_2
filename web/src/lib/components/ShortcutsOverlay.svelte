<script lang="ts">
	interface Props {
		open: boolean;
		onclose: () => void;
	}

	let { open, onclose }: Props = $props();

	const shortcuts = [
		{ keys: ["1"], action: "Fleet" },
		{ keys: ["2"], action: "Commander" },
		{ keys: ["3"], action: "Economy" },
		{ keys: ["4"], action: "Faction" },
		{ keys: ["5"], action: "Galaxy" },
		{ keys: ["6"], action: "Activity" },
		{ keys: ["7"], action: "Market" },
		{ keys: ["8"], action: "Bots" },
		{ keys: ["9"], action: "Training" },
		{ keys: ["0"], action: "Settings" },
		{ keys: ["?"], action: "Show this overlay" },
	];
</script>

{#if open}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-center justify-center"
		onclick={onclose}
		onkeydown={(e) => e.key === "Escape" && onclose()}
		role="presentation"
	>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="bg-deep-void border border-hull-grey/50 rounded-xl shadow-2xl p-6 w-[400px] max-w-[90vw]"
			onclick={(e) => e.stopPropagation()}
			onkeydown={() => {}}
			role="dialog"
			aria-label="Keyboard shortcuts"
		>
			<div class="flex items-center justify-between mb-4">
				<h2 class="text-lg font-bold text-star-white">Keyboard Shortcuts</h2>
				<button
					class="text-hull-grey hover:text-star-white text-lg transition-colors"
					onclick={onclose}
				>&times;</button>
			</div>

			<div class="space-y-2">
				{#each shortcuts as shortcut}
					<div class="flex items-center justify-between py-1.5">
						<span class="text-sm text-chrome-silver">{shortcut.action}</span>
						<div class="flex gap-1">
							{#each shortcut.keys as key}
								<kbd
									class="px-2 py-0.5 text-xs font-mono rounded bg-nebula-blue border border-hull-grey/50 text-star-white min-w-[28px] text-center"
								>{key}</kbd>
							{/each}
						</div>
					</div>
				{/each}
			</div>

			<div class="mt-4 pt-3 border-t border-hull-grey/30">
				<p class="text-xs text-hull-grey text-center">Press any key or click outside to close</p>
			</div>
		</div>
	</div>
{/if}
