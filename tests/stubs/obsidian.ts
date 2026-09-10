/**
 * Stand-ins for the Obsidian API, aliased over `obsidian` in `vitest.config.ts`.
 *
 * Only the surface the plugin's non-UI modules touch is implemented. The fakes
 * keep their state on exported objects instead of a mocking library, so a test
 * asserts what a real Obsidian call would have received.
 */

/** The slice of `HTMLElement` the settings tab and the alert modal use. */
export interface StubElement {
	tag: string;
	text: string;
	children: StubElement[];
	setText(value: string): void;
	createEl(tag: string, options?: { text?: string }): StubElement;
	empty(): void;
}

export function createStubElement(tag = "div"): StubElement {
	const element: StubElement = {
		tag,
		text: "",
		children: [],
		setText(value: string): void {
			element.text = value;
		},
		createEl(childTag: string, options?: { text?: string }): StubElement {
			const child = createStubElement(childTag);
			if (options?.text !== undefined) {
				child.text = options.text;
			}
			element.children.push(child);
			return child;
		},
		empty(): void {
			element.children.length = 0;
		},
	};
	return element;
}

export class Notice {
	message: string;
	timeout: number | undefined;
	hidden = false;

	constructor(message: string, timeout?: number) {
		this.message = message;
		this.timeout = timeout;
	}

	setMessage(message: string): this {
		this.message = message;
		return this;
	}

	hide(): void {
		this.hidden = true;
		this.message = "";
	}
}

/** Tests never branch on the platform, so every flag says "desktop". */
export const Platform = {
	isDesktop: true,
	isDesktopApp: true,
	isMobile: false,
	isMobileApp: false,
};

export class Plugin {
	readonly manifest = { id: "kairos", version: "0.0.0", dir: "" };

	constructor(public readonly app: unknown = null) {}
}

export class Modal {
	readonly contentEl = createStubElement();
	readonly titleEl = createStubElement();

	constructor(public readonly app: unknown = null) {}

	open(): void {
		this.onOpen();
	}

	close(): void {
		this.onClose();
	}

	onOpen(): void {
		// Subclasses render into `contentEl` here.
	}

	onClose(): void {
		// Subclasses tear their content down here.
	}
}

/**
 * A settings control, chained the way the real one is. The stub records the
 * calls and never fires a callback, because no test simulates user input.
 */
export class StubControl {
	readonly calls: string[] = [];

	setValue(value: string | number): this {
		this.calls.push(`value:${value}`);
		return this;
	}

	setPlaceholder(value: string): this {
		this.calls.push(`placeholder:${value}`);
		return this;
	}

	setLimits(min: number, max: number, step: number): this {
		this.calls.push(`limits:${min}-${max}-${step}`);
		return this;
	}

	setButtonText(value: string): this {
		this.calls.push(`button:${value}`);
		return this;
	}

	setTooltip(value: string): this {
		this.calls.push(`tooltip:${value}`);
		return this;
	}

	setCta(): this {
		this.calls.push("cta");
		return this;
	}

	onChange(callback: (value: string) => void): this {
		void callback;
		this.calls.push("onChange");
		return this;
	}

	onClick(callback: () => void): this {
		void callback;
		this.calls.push("onClick");
		return this;
	}
}

export class Setting {
	/** Every label and control the settings tab added, in order. */
	readonly calls: string[] = [];
	readonly controls: StubControl[] = [];

	constructor(public readonly containerEl: StubElement) {}

	setName(name: string): this {
		this.calls.push(`name:${name}`);
		return this;
	}

	setDesc(description: string): this {
		this.calls.push(`desc:${description}`);
		return this;
	}

	setHeading(): this {
		this.calls.push("heading");
		return this;
	}

	addText(configure: (control: StubControl) => unknown): this {
		return this.addControl("text", configure);
	}

	addToggle(configure: (control: StubControl) => unknown): this {
		return this.addControl("toggle", configure);
	}

	addSlider(configure: (control: StubControl) => unknown): this {
		return this.addControl("slider", configure);
	}

	addDropdown(configure: (control: StubControl) => unknown): this {
		return this.addControl("dropdown", configure);
	}

	addButton(configure: (control: StubControl) => unknown): this {
		return this.addControl("button", configure);
	}

	private addControl(kind: string, configure: (control: StubControl) => unknown): this {
		const control = new StubControl();
		configure(control);
		this.controls.push(control);
		this.calls.push(kind);
		return this;
	}
}

export class PluginSettingTab {
	readonly containerEl = createStubElement();
	displayCount = 0;

	constructor(
		public readonly app: unknown,
		public readonly plugin: unknown,
	) {}

	display(): void {
		this.displayCount += 1;
		this.containerEl.empty();
	}

	hide(): void {
		// Nothing to tear down in the stub.
	}
}

export class TFile {
	path = "";
	name = "";
	basename = "";
	extension = "md";
	parent: TFolder | null = null;
}

export class TFolder {
	path = "";
	name = "";
	children: Array<TFile | TFolder> = [];
	parent: TFolder | null = null;
}

export function normalizePath(path: string): string {
	const slashed = path.replace(/\\/gu, "/").replace(/\/+/gu, "/");
	return slashed.replace(/^\/+|\/+$/gu, "");
}

const setTimer = setTimeout;
const clearTimer = clearTimeout;

export interface Debouncer<TArgs extends unknown[]> {
	(...args: TArgs): void;
	cancel(): void;
	run(): void;
}

export function debounce<TArgs extends unknown[]>(callback: (...args: TArgs) => unknown, timeout = 0, resetTimer = false): Debouncer<TArgs> {
	let handle: Parameters<typeof clearTimer>[0] | null = null;
	let pending: TArgs | null = null;
	const invoke = (): void => {
		handle = null;
		const args = pending;
		pending = null;
		if (args !== null) {
			callback(...args);
		}
	};
	const debounced = (...args: TArgs): void => {
		pending = args;
		if (handle !== null && !resetTimer) {
			clearTimer(handle);
		}
		handle = setTimer(invoke, timeout);
	};
	const cancel = (): void => {
		if (handle !== null) {
			clearTimer(handle);
			handle = null;
		}
		pending = null;
	};
	return Object.assign(debounced, { cancel, run: invoke });
}

export interface RequestUrlOptions {
	url: string;
	method?: string;
	body?: string;
	headers?: Record<string, string>;
	throw?: boolean;
}

export interface RequestUrlResponse {
	status: number;
	text: string;
	json: unknown;
	arrayBuffer: ArrayBuffer;
	headers: Record<string, string>;
}

export interface RequestUrlStub {
	/** Every request the plugin made, in order. */
	calls: RequestUrlOptions[];
	/** Status the canned response carries. */
	status: number;
	text: string;
	/** Replaces the canned response; a throwing handler models an offline device. */
	handler: ((options: RequestUrlOptions) => RequestUrlResponse) | null;
	reset(): void;
}

export const requestUrlStub: RequestUrlStub = {
	calls: [],
	status: 200,
	text: "",
	handler: null,
	reset(): void {
		requestUrlStub.calls.length = 0;
		requestUrlStub.status = 200;
		requestUrlStub.text = "";
		requestUrlStub.handler = null;
	},
};

export function requestUrl(options: RequestUrlOptions | string): Promise<RequestUrlResponse> {
	const init = typeof options === "string" ? { url: options } : options;
	requestUrlStub.calls.push(init);
	const handler = requestUrlStub.handler;
	if (handler) {
		return new Promise<RequestUrlResponse>((resolve) => {
			resolve(handler(init));
		});
	}
	return Promise.resolve({
		status: requestUrlStub.status,
		text: requestUrlStub.text,
		json: null,
		arrayBuffer: new ArrayBuffer(0),
		headers: {},
	});
}
