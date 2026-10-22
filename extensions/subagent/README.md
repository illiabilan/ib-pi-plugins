
## Background mode

Pass `background: true` to run any mode (single, parallel, chain, loop) detached. The tool returns a job id immediately, so the orchestrator stays free for dialog. When the job ends, its result is delivered as a follow-up message that triggers a new turn. Background jobs are aborted on session shutdown.
