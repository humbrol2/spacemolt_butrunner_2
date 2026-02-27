<script lang="ts">
	import "../app.css";
	import { page } from "$app/stores";
	import { goto } from "$app/navigation";
	import { onMount, onDestroy } from "svelte";
	import {
		connect,
		disconnect,
		connectionState,
		fleetStats,
		notifications,
		unreadNotifications,
		clearNotifications,
		dismissNotification,
	} from "$stores/websocket";
	import ShortcutsOverlay from "$lib/components/ShortcutsOverlay.svelte";

	let { children } = $props();

	let showNotifications = $state(false);
	let showShortcuts = $state(false);

	// Toast notifications (auto-dismiss after 5s)
	let toasts = $state<Array<{ id: string; level: string; title: string; message: string; timestamp: number }>>([]);
	// Track which notification IDs have already been shown as toasts (prevents re-creation after auto-dismiss)
	const shownToastIds = new Set<string>();

	// Watch for new notifications and create toasts
	$effect(() => {
		const latest = $notifications[0];
		if (latest && !shownToastIds.has(latest.id)) {
			shownToastIds.add(latest.id);
			toasts = [{ ...latest, level: latest.level }, ...toasts].slice(0, 5);
			// Auto-dismiss after 5s
			setTimeout(() => {
				toasts = toasts.filter((t) => t.id !== latest.id);
			}, 5000);
			// Clean up old IDs (keep last 50 to prevent memory leak)
			if (shownToastIds.size > 50) {
				const ids = [...shownToastIds];
				for (let i = 0; i < ids.length - 50; i++) shownToastIds.delete(ids[i]);
			}
		}
	});

	const navItems = [
		{ href: "/", label: "Fleet", key: "1" },
		{ href: "/commander", label: "Commander", key: "2" },
		{ href: "/economy", label: "Economy", key: "3" },
		{ href: "/faction", label: "Faction", key: "4" },
		{ href: "/galaxy", label: "Galaxy", key: "5" },
		{ href: "/activity", label: "Activity", key: "6" },
		{ href: "/market", label: "Market", key: "7" },
		{ href: "/bots", label: "Bots", key: "8" },
		{ href: "/training", label: "Training", key: "9" },
	];

	function isActive(href: string, pathname: string): boolean {
		if (href === "/") return pathname === "/";
		return pathname.startsWith(href);
	}

	function handleKeydown(e: KeyboardEvent) {
		// Don't trigger shortcuts when typing in inputs
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;

		// Close overlay on any key if open
		if (showShortcuts && e.key !== "?") {
			showShortcuts = false;
			return;
		}

		const num = parseInt(e.key);
		if (num >= 1 && num <= 9) {
			const item = navItems[num - 1];
			if (item) goto(item.href);
		}
		if (e.key === "0") goto("/settings");
		if (e.key === "?") {
			showShortcuts = !showShortcuts;
		}
	}

	onMount(() => {
		connect();
		window.addEventListener("keydown", handleKeydown);
	});

	onDestroy(() => {
		disconnect();
		if (typeof window !== "undefined") {
			window.removeEventListener("keydown", handleKeydown);
		}
	});
</script>

<!-- Connection status banner -->
{#if $connectionState === "disconnected"}
	<div
		class="fixed top-0 left-0 right-0 z-50 bg-claw-red/90 text-star-white text-center py-1.5 text-sm font-medium flex items-center justify-center gap-2"
	>
		<span class="w-2 h-2 rounded-full bg-star-white animate-pulse"></span>
		Connection lost. Reconnecting...
	</div>
{:else if $connectionState === "connecting"}
	<div
		class="fixed top-0 left-0 right-0 z-50 bg-shell-orange/90 text-star-white text-center py-1.5 text-sm font-medium flex items-center justify-center gap-2"
	>
		<span class="w-2 h-2 rounded-full bg-star-white animate-pulse"></span>
		Connecting...
	</div>
{/if}

<!-- Navigation bar -->
<nav
	class="sticky top-0 z-40 border-b border-hull-grey/50 bg-deep-void/95 backdrop-blur-md"
	class:mt-8={$connectionState !== "connected"}
>
	<div class="mx-auto flex h-12 max-w-[1920px] items-center px-4 gap-1">
		<!-- Logo -->
		<a href="/" class="flex items-center gap-2 mr-4 shrink-0">
			<span class="text-lg font-bold text-plasma-cyan">&#9889; COMMANDER</span>
		</a>

		<!-- Nav links -->
		<div class="flex items-center gap-0.5">
			{#each navItems as item}
				<a
					href={item.href}
					class="px-3 py-1.5 text-sm font-medium rounded-md transition-colors {isActive(
						item.href,
						$page.url.pathname
					)
						? 'bg-nebula-blue text-plasma-cyan'
						: 'text-chrome-silver hover:text-star-white hover:bg-nebula-blue/50'}"
				>
					{item.label}
				</a>
			{/each}
		</div>

		<!-- Spacer -->
		<div class="flex-1"></div>

		<!-- Right side stats -->
		<div class="hidden md:flex items-center gap-4 text-sm text-chrome-silver mr-3">
			{#if $fleetStats}
				<span class="flex items-center gap-1.5">
					<span
						class="status-dot"
						class:active={$fleetStats.activeBots > 0}
						class:offline={$fleetStats.activeBots === 0}
					></span>
					<span class="mono">{$fleetStats.activeBots}/{$fleetStats.totalBots}</span>
				</span>
				<span class="{$fleetStats.creditsPerHour >= 0 ? 'text-bio-green' : 'text-claw-red'} mono font-medium">
					{$fleetStats.creditsPerHour >= 0 ? '+' : ''}{$fleetStats.creditsPerHour.toLocaleString()} cr/hr
				</span>
			{:else}
				<span class="text-hull-grey">No data</span>
			{/if}
		</div>

		<!-- Notification bell -->
		<button
			class="relative p-2 text-chrome-silver hover:text-star-white transition-colors"
			onclick={() => (showNotifications = !showNotifications)}
		>
			<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					stroke-width="2"
					d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
				/>
			</svg>
			{#if $unreadNotifications > 0}
				<span
					class="absolute -top-0.5 -right-0.5 bg-claw-red text-star-white text-xs font-bold rounded-full w-4 h-4 flex items-center justify-center"
				>
					{$unreadNotifications > 9 ? "9+" : $unreadNotifications}
				</span>
			{/if}
		</button>

		<!-- Settings -->
		<a
			href="/settings"
			class="p-2 text-chrome-silver hover:text-star-white transition-colors"
			title="Settings"
		>
			<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					stroke-width="2"
					d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
				/>
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					stroke-width="2"
					d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
				/>
			</svg>
		</a>
	</div>
</nav>

<!-- Notification drawer -->
{#if showNotifications}
	<!-- Backdrop -->
	<button
		class="fixed inset-0 z-40 bg-black/40"
		onclick={() => (showNotifications = false)}
		aria-label="Close notifications"
	></button>
	<div
		class="fixed right-0 top-12 z-50 w-96 max-h-[calc(100vh-4rem)] overflow-y-auto border-l border-hull-grey/50 bg-deep-void/98 backdrop-blur-lg shadow-2xl"
	>
		<div class="flex items-center justify-between p-4 border-b border-hull-grey/30">
			<h3 class="font-semibold text-star-white">Notifications</h3>
			{#if $notifications.length > 0}
				<button
					class="text-xs text-chrome-silver hover:text-star-white transition-colors"
					onclick={() => clearNotifications()}
				>
					Clear All
				</button>
			{/if}
		</div>

		{#if $notifications.length === 0}
			<div class="p-8 text-center text-hull-grey">No notifications</div>
		{:else}
			<div class="divide-y divide-hull-grey/20">
				{#each $notifications as notif}
					<div class="p-3 hover:bg-nebula-blue/30 transition-colors">
						<div class="flex items-start gap-2">
							<span
								class="mt-0.5 w-2 h-2 rounded-full shrink-0 {notif.level === 'critical'
									? 'bg-claw-red'
									: notif.level === 'warning'
										? 'bg-warning-yellow'
										: 'bg-laser-blue'}"
							></span>
							<div class="flex-1 min-w-0">
								<p class="text-sm font-medium text-star-white">{notif.title}</p>
								<p class="text-xs text-chrome-silver mt-0.5">{notif.message}</p>
							</div>
							<button
								class="text-hull-grey hover:text-star-white text-xs"
								onclick={() => dismissNotification(notif.id)}
							>
								&times;
							</button>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/if}

<!-- Toast notifications (bottom-right) -->
{#if toasts.length > 0}
	<div class="fixed bottom-4 right-4 z-[90] flex flex-col gap-2 w-80">
		{#each toasts as toast (toast.id)}
			<div
				class="p-3 rounded-lg shadow-lg border backdrop-blur-md transition-all animate-slide-in
					{toast.level === 'critical'
					? 'bg-claw-red/90 border-claw-red text-star-white'
					: toast.level === 'warning'
						? 'bg-shell-orange/90 border-shell-orange text-star-white'
						: 'bg-nebula-blue/95 border-hull-grey/50 text-star-white'}"
			>
				<div class="flex items-start gap-2">
					<div class="flex-1 min-w-0">
						<p class="text-sm font-medium">{toast.title}</p>
						<p class="text-xs opacity-80 mt-0.5 truncate">{toast.message}</p>
					</div>
					<button
						class="text-star-white/60 hover:text-star-white text-xs shrink-0"
						onclick={() => (toasts = toasts.filter((t) => t.id !== toast.id))}
					>&times;</button>
				</div>
			</div>
		{/each}
	</div>
{/if}

<!-- Shortcuts overlay -->
<ShortcutsOverlay open={showShortcuts} onclose={() => (showShortcuts = false)} />

<!-- Page content -->
<main class="mx-auto max-w-[1920px] p-4">
	{@render children()}
</main>
