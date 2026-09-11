/**
 * The channel SDK (docs/spec/syntax.md, contract): every delivery path
 * implements `DeliveryChannel`, and the settings UI enumerates whatever is
 * registered here.
 *
 * This module is deliberately free of Obsidian imports so the engine and the
 * tests can use it headlessly.
 */

import type { KairosSettings, Severity } from "../settings";

export interface OutboundMessage {
	instanceId: string;
	title: string;
	noteName?: string;
	dueLocal: string;
	dueEpochMs: number;
	severity: Severity;
	/** Minutes between the due time and now; 0 for an on-time alarm. */
	ageMinutes: number;
	/** Whether the platform can offer Done / Snooze / Open note. */
	actions: boolean;
}

export interface DeliveryResult {
	ok: boolean;
	detail?: string;
	/** Epoch ms before which a retry is pointless. */
	retryAt?: number;
	/** The provider's message id, when it returns one. */
	id?: string;
}

export interface ChannelContext {
	now: number;
	deviceId: string;
	tzId: string;
	settings: KairosSettings;
	/** Open the note that produced the reminder. */
	openInstance(instanceId: string): void;
	ack(instanceId: string): void;
	snooze(instanceId: string, minutes: number): void;
}

/**
 * `local` channels only fire while Obsidian runs; `server-scheduled` channels
 * accept a due time and deliver it with the app closed, so the engine mirrors
 * the live index into them instead of waiting for a tick.
 */
export type ChannelMode = "local" | "server-scheduled";

export interface DeliveryChannel {
	id: string;
	name: string;
	mode: ChannelMode;
	isConfigured(settings: KairosSettings): boolean;
	send(msg: OutboundMessage, ctx: ChannelContext): Promise<DeliveryResult>;
	/**
	 * Cancel a push that was scheduled on a server; `pushId` is the id the
	 * provider returned when it registered this instance.
	 */
	clear?(instanceId: string, ctx: ChannelContext, pushId?: string): Promise<void>;
}

export class ChannelRegistry {
	private channels: DeliveryChannel[] = [];

	register(channel: DeliveryChannel): void {
		this.channels = this.channels.filter((existing) => existing.id !== channel.id);
		this.channels.push(channel);
	}

	all(): DeliveryChannel[] {
		return [...this.channels];
	}

	names(): string[] {
		return this.channels.map((channel) => channel.name);
	}

	get(id: string): DeliveryChannel | undefined {
		return this.channels.find((channel) => channel.id === id);
	}

	configured(settings: KairosSettings): DeliveryChannel[] {
		return this.channels.filter((channel) => channel.isConfigured(settings));
	}

	/**
	 * Sends to every configured channel whatever its mode; one channel failing
	 * never blocks another. The one caller is the `Test notification` command,
	 * where reaching each configured channel is the point. The fire path is
	 * `deliverLocal`.
	 */
	async deliver(msg: OutboundMessage, ctx: ChannelContext): Promise<DeliveryResult[]> {
		return this.deliverTo(this.configured(ctx.settings), msg, ctx);
	}

	/**
	 * The path a *firing* reminder takes: only the channels that deliver without a
	 * server. A `server-scheduled` channel is registered ahead of time by
	 * `syncServerScheduled` and its registration is what the provider holds for
	 * this due time, so asking it to send again at the moment the reminder fires
	 * is a second push for one due time. `ntfy` cannot deliver an already-started
	 * schedule either: it clamps the `X-At` it is handed to ten seconds out
	 * (`MIN_SERVER_DELAY_SECONDS`), so the duplicate arrives ten seconds after the
	 * alert it duplicates — the third arrival in the `.testvault` trace of
	 * 2026-09-11, a reminder due 11:14 delivered at 11:14:10.
	 */
	async deliverLocal(msg: OutboundMessage, ctx: ChannelContext): Promise<DeliveryResult[]> {
		return this.deliverTo(this.configured(ctx.settings).filter((channel) => channel.mode === "local"), msg, ctx);
	}

	/** The same, restricted to the channels that schedule on their own server. */
	async deliverScheduled(msg: OutboundMessage, ctx: ChannelContext): Promise<DeliveryResult[]> {
		return this.deliverTo(this.configured(ctx.settings).filter((channel) => channel.mode === "server-scheduled"), msg, ctx);
	}

	private async deliverTo(channels: DeliveryChannel[], msg: OutboundMessage, ctx: ChannelContext): Promise<DeliveryResult[]> {
		const results: DeliveryResult[] = [];
		for (const channel of channels) {
			try {
				results.push(await channel.send(msg, ctx));
			} catch (error) {
				results.push({ ok: false, detail: `${channel.id}: ${describeError(error)}` });
			}
		}
		return results;
	}

	async clearInstance(instanceId: string, ctx: ChannelContext, pushId?: string): Promise<void> {
		for (const channel of this.all()) {
			if (!channel.clear) {
				continue;
			}
			try {
				await channel.clear(instanceId, ctx, pushId);
			} catch {
				// A failed cancellation is not worth an alert: the push expires on its own.
			}
		}
	}
}

export function describeError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return typeof error === "string" ? error : "unknown error";
}

/**
 * The engine records one outcome per instance, so a fan-out collapses to a
 * single result: any channel that succeeded counts as delivered, and every
 * failure is still reported. The provider's message id survives the collapse
 * when a channel returned one, because it is the handle that cancels the push.
 */
export function combinedResult(results: DeliveryResult[]): DeliveryResult {
	if (results.length === 0) {
		return { ok: false, detail: "no channel is configured" };
	}
	const failures = results.filter((result) => !result.ok).map((result) => result.detail ?? "failed");
	if (failures.length === results.length) {
		return { ok: false, detail: failures.join(", ") };
	}
	const id = results.find((result) => result.ok && result.id !== undefined)?.id;
	return {
		ok: true,
		...(failures.length === 0 ? {} : { detail: failures.join(", ") }),
		...(id === undefined ? {} : { id }),
	};
}
