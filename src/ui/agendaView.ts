/**
 * Agenda view: the live reminders, grouped by when they are due.
 * Minimal on purpose; the point of v0.1 is the alert, not the dashboard.
 */

import { ItemView, type WorkspaceLeaf } from "obsidian";

export const KAIROS_AGENDA_VIEW = "kairos-agenda";

export interface AgendaItem {
	instanceId: string;
	title: string;
	dueLocal: string;
	sourcePath: string;
	line: number;
}

export interface AgendaGroup {
	label: string;
	items: AgendaItem[];
}

/** Local calendar day of a wall clock string, so grouping never crosses zones. */
export function wallDay(wallClock: string): string {
	return wallClock.slice(0, 10);
}

export function groupAgenda(items: AgendaItem[], today: string, inSevenDays: string): AgendaGroup[] {
	const groups: AgendaGroup[] = [
		{ label: "Overdue", items: [] },
		{ label: "Today", items: [] },
		{ label: "Tomorrow", items: [] },
		{ label: "Next 7 days", items: [] },
	];
	const tomorrow = addDays(today, 1);
	for (const item of items) {
		const day = wallDay(item.dueLocal);
		if (day < today) {
			groups[0]?.items.push(item);
			continue;
		}
		if (day === today) {
			groups[1]?.items.push(item);
			continue;
		}
		if (day === tomorrow) {
			groups[2]?.items.push(item);
			continue;
		}
		if (day <= inSevenDays) {
			groups[3]?.items.push(item);
		}
	}
	return groups.filter((group) => group.items.length > 0);
}

export function addDays(isoDate: string, days: number): string {
	const [year, month, day] = isoDate.split("-").map((part) => Number(part));
	const base = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + days));
	return base.toISOString().slice(0, 10);
}

export class KairosAgendaView extends ItemView {
	constructor(
		leaf: WorkspaceLeaf,
		private readonly groups: () => AgendaGroup[],
		private readonly open: (item: AgendaItem) => void,
	) {
		super(leaf);
	}

	override getViewType(): string {
		return KAIROS_AGENDA_VIEW;
	}

	override getDisplayText(): string {
		return "Agenda";
	}

	override getIcon(): string {
		return "alarm-clock";
	}

	override async onOpen(): Promise<void> {
		this.render();
	}

	render(): void {
		const container = this.contentEl;
		container.empty();
		const groups = this.groups();
		if (groups.length === 0) {
			container.createEl("p", { text: "No live reminders." });
			return;
		}
		for (const group of groups) {
			container.createEl("h4", { text: group.label });
			const list = container.createEl("ul");
			for (const item of group.items) {
				const entry = list.createEl("li");
				const link = entry.createEl("a", { text: `${item.dueLocal.slice(11)} ${item.title}` });
				link.href = "#";
				this.registerDomEvent(link, "click", (event) => {
					event.preventDefault();
					this.open(item);
				});
			}
		}
	}
}
