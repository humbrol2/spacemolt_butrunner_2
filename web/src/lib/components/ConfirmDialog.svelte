<script lang="ts">
	interface Props {
		open: boolean;
		title: string;
		message: string;
		confirmLabel?: string;
		cancelLabel?: string;
		variant?: "danger" | "warning" | "default";
		onconfirm: () => void;
		oncancel: () => void;
	}

	let {
		open,
		title,
		message,
		confirmLabel = "Confirm",
		cancelLabel = "Cancel",
		variant = "default",
		onconfirm,
		oncancel,
	}: Props = $props();

	const confirmClasses = {
		danger: "bg-claw-red/20 text-claw-red border-claw-red/30 hover:bg-claw-red/30",
		warning: "bg-shell-orange/20 text-shell-orange border-shell-orange/30 hover:bg-shell-orange/30",
		default: "bg-plasma-cyan/20 text-plasma-cyan border-plasma-cyan/30 hover:bg-plasma-cyan/30",
	};
</script>

{#if open}
	<div class="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-center justify-center">
		<div
			class="bg-deep-void border border-hull-grey/50 rounded-xl shadow-2xl p-6 w-[420px] max-w-[90vw]"
			role="alertdialog"
			aria-label={title}
		>
			<h2 class="text-lg font-bold text-star-white mb-2">{title}</h2>
			<p class="text-sm text-chrome-silver mb-6">{message}</p>

			<div class="flex justify-end gap-3">
				<button
					class="px-4 py-2 text-sm font-medium rounded-lg text-chrome-silver border border-hull-grey/30 hover:text-star-white transition-colors"
					onclick={oncancel}
				>
					{cancelLabel}
				</button>
				<button
					class="px-4 py-2 text-sm font-medium rounded-lg border transition-colors {confirmClasses[variant]}"
					onclick={onconfirm}
				>
					{confirmLabel}
				</button>
			</div>
		</div>
	</div>
{/if}
