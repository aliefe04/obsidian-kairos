/**
 * Calendar channel (docs/spec/syntax.md §1 write side): an RFC 5545 file inside
 * the vault, so reminders survive a closed app on any platform.
 */

import { Plugin } from "obsidian";
import { describeError, type ChannelContext, type DeliveryChannel, type DeliveryResult, type OutboundMessage } from "./types";
import { icalUtc, icsText } from "./ical";
import type { KairosSettings } from "../settings";

export interface IcsEvent {
	uid: string;
	title: string;
	dueLocal: string;
	tzId: string;
	noteName?: string;
	alarmMinutesBefore: number;
	createdMs: number;
}

export interface IcsBuildOptions {
	calName: string;
	nowMs: number;
}

const CRLF = "\r\n";

function localStamp(wallClock: string): string {
	return wallClock.replace(/[-:]/gu, "").replace("T", "T");
}

export function buildIcs(events: IcsEvent[], options: IcsBuildOptions): string {
	const lines: string[] = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Kairos//Kairos reminders//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
	lines.push(icsText(`X-WR-CALNAME:${options.calName}`));
	for (const event of events) {
		const trigger = event.alarmMinutesBefore === 0 ? "PT0M" : `-PT${event.alarmMinutesBefore}M`;
		lines.push("BEGIN:VEVENT");
		lines.push(icsText(`UID:${event.uid}@kairos`));
		lines.push(`DTSTAMP:${icalUtc(options.nowMs)}`);
		lines.push(`DTSTART;TZID=${event.tzId}:${localStamp(event.dueLocal)}00`);
		lines.push(icsText(`SUMMARY:${event.title}`));
		if (event.noteName) {
			lines.push(icsText(`DESCRIPTION:${event.noteName}`));
		}
		lines.push("BEGIN:VALARM");
		lines.push("ACTION:DISPLAY");
		lines.push(icsText(`DESCRIPTION:${event.title}`));
		lines.push(`TRIGGER:${trigger}`);
		lines.push("END:VALARM");
		lines.push("END:VEVENT");
	}
	lines.push("END:VCALENDAR");
	return `${lines.join(CRLF)}${CRLF}`;
}

export interface IcsChannelOptions {
	plugin: Plugin;
	events: (settings: KairosSettings) => IcsEvent[];
}

export function createIcsChannel(options: IcsChannelOptions): DeliveryChannel {
	const write = async (settings: KairosSettings): Promise<DeliveryResult> => {
		const path = settings.icsPath.trim().length > 0 ? settings.icsPath.trim() : "kairos.ics";
		const body = buildIcs(options.events(settings), { calName: "Kairos", nowMs: Date.now() });
		try {
			await options.plugin.app.vault.adapter.write(path, body);
			return { ok: true, detail: path };
		} catch (error) {
			return { ok: false, detail: describeError(error) };
		}
	};
	return {
		id: "ics",
		name: "Calendar file",
		mode: "local",
		isConfigured: (settings) => settings.icsEnabled,
		send: async (msg: OutboundMessage, ctx: ChannelContext): Promise<DeliveryResult> => {
			void msg;
			return write(ctx.settings);
		},
		clear: async (instanceId: string, ctx: ChannelContext): Promise<void> => {
			void instanceId;
			await write(ctx.settings);
		},
	};
}
