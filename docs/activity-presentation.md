# Activity presentation

The activity dock displays the latest published Agent status snapshot. Lifecycle, runtime configuration, queue, selection, and attention changes refresh that snapshot through the activity source's change notifications. Editor input, resizing, theme invalidation, and animation redraw the retained snapshot without inspecting transcripts.

A new dock samples its source when installed, and disposal removes its subscription and animation timer. Active children animate between state changes; settlement stops the timer.

Presentation snapshots are transient display data. Explicit Agent status and roster observations still inspect current durable evidence. Each roster entry shares one transcript inspection across its evidence pointer, model/thinking context, and recency ordering.

Compaction is a transient human-facing activity, not a Run phase or scheduling state. While a live Agent compacts, both its dock row and the open `/agents` selector show `compacting` instead of ordinary work or waiting status. Start and end signals refresh both surfaces without reopening the selector; ending compaction reveals the current underlying status, not an assumed idle state. Native completion includes failure and cancellation, and Runtime failure or disposal clears the indicator. Lifecycle termination and failure labels take precedence.

The selector subscribes while open and removes that subscription on disposal. Refreshes preserve its selected Agent and scope.

In fullscreen mode the dock is also a pointer target: a completed primary click on any rendered dock row dispatches the registered `/agents` command exactly as if it had been submitted from the editor. Only completed clicks are consumed, so presses still start drag-selection over the dock, wheel keeps scrolling the transcript, and middle or secondary buttons have no dock action. A visible overlay owns interaction, so the dock never stacks its menu from behind one. Pi's regular terminal mode does not route component mouse input, so the dock is keyboard-only there and the `/agents` command remains the only entry. A dock installed without a menu action stays purely informational.
