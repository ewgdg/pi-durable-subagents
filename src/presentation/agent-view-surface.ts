import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";

import type { TerminalProjection } from "./terminal-projection.ts";
import {
	createProcessPhysicalTerminalPort,
	PhysicalTerminalAttachment,
	type PhysicalTerminalPort,
} from "./physical-terminal-attachment.ts";

type AgentTerminalAttachment = Readonly<{
	attach(projection: TerminalProjection): Promise<void>;
	dispatchInput(data: string): void;
	close(): Promise<void>;
}>;

export type PhysicalAgentViewSurface = Readonly<{
	ready: Promise<void>;
	closed: Promise<void>;
	suspend(): Promise<void>;
	resume(): Promise<void>;
	close(): void;
}>;

export function startPhysicalAgentViewSurface(
	view: DurableAgentView,
	options: Readonly<{
		ownerTui: TUI;
		requestShutdown(): void;
		physicalTerminal?: PhysicalTerminalPort;
	}>,
): PhysicalAgentViewSurface | undefined {
	const physicalTerminal = options.physicalTerminal
		?? createProcessPhysicalTerminalPort(options.ownerTui);
	if (!physicalTerminal.supportsPhysicalAttachment) return undefined;
	let closed = false;
	let settleClosed!: () => void;
	const closedPromise = new Promise<void>((resolve) => {
		settleClosed = resolve;
	});
	const closeFromHost = () => {
		if (closed) return;
		closed = true;
		void attachment.close().then(settleClosed);
	};
	const failFromAttachment = (error: unknown) => {
		if (closed) return;
		try {
			view.fail(error);
		} finally {
			closeFromHost();
		}
	};
	const attachment = new PhysicalTerminalAttachment({
		ownerTui: options.ownerTui,
		physicalTerminal,
		fail: failFromAttachment,
		requestExit() {
			closeFromHost();
			options.requestShutdown();
		},
	});
	const attachCurrentProjection = () => {
		if (closed) return;
		return attachment.attach(view.projection()).catch((error) => {
			failFromAttachment(error);
			throw error;
		});
	};
	const removeViewChangeHandler = view.addPresentationHandler(attachCurrentProjection);
	const removeViewCloseHandler = view.addCloseHandler(closeFromHost);
	const ready = attachment.attach(view.projection()).catch(failFromAttachment);
	const cleanup = closedPromise.then(async () => {
		removeViewChangeHandler();
		removeViewCloseHandler();
		await attachment.close();
		await view.close();
	});
	return {
		ready,
		closed: cleanup,
		suspend: () => attachment.suspend(),
		resume: () => attachment.attach(view.projection()),
		close: closeFromHost,
	};
}

export type DurableAgentView = Readonly<{
	agentId: string;
	label: string;
	projection(): TerminalProjection;
	addPresentationHandler(handler: () => void | Promise<void>): () => void;
	addCloseHandler(handler: () => void): () => void;
	fail(error: unknown): void;
	close(): Promise<void>;
}>;

export async function openAgentViewSurface(
	ui: ExtensionUIContext,
	view: DurableAgentView,
	options: Readonly<{
		requestShutdown(): void;
		physicalTerminal?: PhysicalTerminalPort;
	}> = {
		requestShutdown: () => undefined,
	},
): Promise<void> {
	let attachment: AgentTerminalAttachment | undefined;
	let handle: OverlayHandle | undefined;
	let closedByHost = false;
	let settleHostClose!: () => void;
	const hostClose = new Promise<void>((resolve) => {
		settleHostClose = resolve;
	});
	let removeViewChangeHandler: () => void = () => undefined;
	let removeViewCloseHandler: () => void = () => undefined;

	const closeFromHost = () => {
		if (closedByHost) return;
		closedByHost = true;
		handle?.hide();
		const closedAttachment = attachment?.close() ?? Promise.resolve();
		void closedAttachment.then(settleHostClose);
	};
	const failFromAttachment = (error: unknown) => {
		if (closedByHost) return;
		try {
			view.fail(error);
		} finally {
			closeFromHost();
		}
	};
	const attachCurrentProjection = () => {
		if (!attachment || closedByHost) return;
		return attachment.attach(view.projection()).catch((error) => {
			failFromAttachment(error);
			throw error;
		});
	};

	try {
		const interactiveClose = ui.custom<void>(
			(tui) => {
				const physicalTerminal = options.physicalTerminal
					?? createProcessPhysicalTerminalPort(tui);
				const requestExit = () => {
					closeFromHost();
					options.requestShutdown();
				};
				attachment = physicalTerminal.supportsPhysicalAttachment
					? new PhysicalTerminalAttachment({
						ownerTui: tui,
						physicalTerminal,
						fail: failFromAttachment,
						requestExit,
					})
					: new DetachedDiagnosticAttachment({
						fail: failFromAttachment,
						requestExit,
					});
				removeViewChangeHandler = view.addPresentationHandler(attachCurrentProjection);
				removeViewCloseHandler = view.addCloseHandler(closeFromHost);
				return new DetachedAgentDiagnosticSurface(
					view,
					(data) => attachment?.dispatchInput(data),
				);
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "top-left",
					width: "100%",
					maxHeight: "100%",
					margin: 0,
				},
				onHandle: (overlayHandle) => {
					handle = overlayHandle;
					if (closedByHost) {
						overlayHandle.hide();
						return;
					}
					void attachCurrentProjection()?.catch(failFromAttachment);
				},
			},
		);
		await Promise.race([interactiveClose, hostClose]);
	} finally {
		removeViewChangeHandler();
		removeViewCloseHandler();
		await attachment?.close();
		await view.close();
	}
}

class DetachedDiagnosticAttachment implements AgentTerminalAttachment {
	readonly #fail: (error: unknown) => void;
	readonly #requestExit: () => void;
	#projection: TerminalProjection | undefined;
	#removeFailureHandler: () => void = () => undefined;
	#removeExitHandler: () => void = () => undefined;
	#closed = false;

	constructor(options: {
		fail(error: unknown): void;
		requestExit(): void;
	}) {
		this.#fail = options.fail;
		this.#requestExit = options.requestExit;
	}

	async attach(projection: TerminalProjection): Promise<void> {
		if (this.#closed || this.#projection === projection) return;
		await this.#releaseProjection();
		if (this.#closed) return;
		this.#projection = projection;
		const removeFailureHandler = projection.addFailureHandler((error) => {
			if (this.#projection !== projection || this.#closed) return;
			this.#fail(error);
		});
		if (this.#closed || this.#projection !== projection) {
			removeFailureHandler();
			return;
		}
		this.#removeFailureHandler = removeFailureHandler;
		const removeExitHandler = projection.addExitRequestHandler(() => {
			if (this.#projection !== projection || this.#closed) return;
			this.close();
			this.#requestExit();
		});
		if (this.#closed || this.#projection !== projection) {
			removeExitHandler();
			return;
		}
		this.#removeExitHandler = removeExitHandler;
		// This surface renders the projection's parsed screen, so it must resume the
		// child's native rendering and keep observing it while it stays open.
		await projection.screenView.begin();
	}

	dispatchInput(data: string): void {
		if (this.#closed || !this.#projection) return;
		try {
			this.#projection.dispatchInput(data);
		} catch (error) {
			this.#fail(error);
		}
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#releaseProjection();
	}

	async #releaseProjection(): Promise<void> {
		const projection = this.#projection;
		this.#projection = undefined;
		this.#removeFailureHandler();
		this.#removeExitHandler();
		this.#removeFailureHandler = () => undefined;
		this.#removeExitHandler = () => undefined;
		if (!projection) return;
		await projection.screenView.end().catch((error: unknown) => this.#fail(error));
	}
}

/**
 * Non-terminal SDK/test hosts keep xterm as their terminal and use this surface
 * only for diagnostics. Interactive Pi never uses it as the live child renderer.
 */
class DetachedAgentDiagnosticSurface implements Component {
	readonly #view: DurableAgentView;
	readonly #dispatchInput: (data: string) => void;

	constructor(
		view: DurableAgentView,
		dispatchInput: (data: string) => void,
	) {
		this.#view = view;
		this.#dispatchInput = dispatchInput;
	}

	render(width: number): string[] {
		return this.#view.projection().presentation.render(width);
	}

	handleInput(data: string): void {
		this.#dispatchInput(data);
	}

	invalidate(): void {
		this.#view.projection().presentation.invalidate();
	}
}
