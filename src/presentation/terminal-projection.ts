import type { Component } from "@earendil-works/pi-tui";

/** Process-child operations needed only while it owns the physical terminal. */
export type PhysicalChildTerminal = Readonly<{
	beginAttachment(handler: (data: string) => void): Promise<() => void>;
	endAttachment(): Promise<void>;
	pauseOutput(): void;
	resumeOutput(): void;
}>;

/** Screen-level operations for a surface that renders this child's live screen. */
export type ChildScreenView = Readonly<{
	/**
	 * Resume the child's native screen and observe it. Resolves once the child's
	 * complete current frame has been established for viewers of the projection.
	 */
	begin(): Promise<void>;
	/** Stop observing and hide the child again. */
	end(): Promise<void>;
}>;

/** Complete terminal-facing surface for one Agent Runtime. */
export type TerminalProjection = Readonly<{
	presentation: Component;
	screenView: ChildScreenView;
	physicalTerminal: PhysicalChildTerminal;
	resize(columns: number, rows: number): void;
	dispatchInput(data: string): void;
	focusEditor(): void;
	addChangeHandler(handler: () => void): () => void;
	addFailureHandler(handler: (error: unknown) => void): () => void;
	addExitRequestHandler(handler: () => void): () => void;
}>;
