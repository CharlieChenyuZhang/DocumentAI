import { createHash } from "node:crypto";
import {
  AgentRunner,
  InMemoryAgentRunner,
  type AgentRunnerRunRequest,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerStopRequest,
} from "@copilotkit/runtime/v2";

const sharedRunner = new InMemoryAgentRunner({
  maxThreads: 300,
  maxRunsPerThread: 50,
  maxBytes: 128 * 1024 * 1024,
});

export function scopedThread(owner: string, thread: string) {
  return createHash("sha256")
    .update(JSON.stringify([owner, thread]))
    .digest("hex");
}

/** CopilotKit's memory store is process-global, even across runner instances.
 * Namespace every operation while preserving the browser's protocol thread ID.
 * Do not expose the library's unscoped local thread-list/clear endpoints.
 */
export class ScopedRunner extends AgentRunner {
  constructor(
    private owner: string,
    private delegate: AgentRunner = sharedRunner,
  ) {
    super();
  }
  run(request: AgentRunnerRunRequest) {
    return this.delegate.run({
      ...request,
      threadId: scopedThread(this.owner, request.threadId),
    });
  }
  connect(request: AgentRunnerConnectRequest) {
    return this.delegate.connect({
      ...request,
      threadId: scopedThread(this.owner, request.threadId),
    });
  }
  isRunning(request: AgentRunnerIsRunningRequest) {
    return this.delegate.isRunning({
      ...request,
      threadId: scopedThread(this.owner, request.threadId),
    });
  }
  stop(request: AgentRunnerStopRequest) {
    return this.delegate.stop({
      ...request,
      threadId: scopedThread(this.owner, request.threadId),
    });
  }
}
