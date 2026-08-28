import type { Browser, BrowserContext, Page } from "playwright";

export type SessionController = "agent" | "human";
export type SessionState =
  | "idle"
  | "automating"
  | "paused_for_human"
  | "completed"
  | "failed";

export interface SessionInfo {
  sessionId: string;
  state: SessionState;
  controller: SessionController;
  startedAt: string;
  currentStepIndex: number;
  currentUrl?: string;
}

export class SessionManager {
  private state: SessionState = "idle";
  private controller: SessionController = "agent";
  private currentStepIndex = 0;
  readonly sessionId: string;
  readonly startedAt: string;

  constructor(
    public readonly browser: Browser,
    public readonly context: BrowserContext,
    public readonly page: Page,
    sessionId?: string,
  ) {
    this.sessionId = sessionId ?? crypto.randomUUID();
    this.startedAt = new Date().toISOString();
  }

  get info(): SessionInfo {
    return {
      sessionId: this.sessionId,
      state: this.state,
      controller: this.controller,
      startedAt: this.startedAt,
      currentStepIndex: this.currentStepIndex,
      currentUrl: this.page.url(),
    };
  }

  startAutomation(): void {
    this.state = "automating";
    this.controller = "agent";
  }

  pauseForHuman(): void {
    this.state = "paused_for_human";
    this.controller = "human";
  }

  resumeAutomation(fromStepIndex?: number): void {
    if (fromStepIndex !== undefined) {
      this.currentStepIndex = fromStepIndex;
    }
    this.state = "automating";
    this.controller = "agent";
  }

  advanceStep(): void {
    this.currentStepIndex++;
  }

  complete(): void {
    this.state = "completed";
  }

  fail(): void {
    this.state = "failed";
  }

  assertAgentControl(): void {
    if (this.controller !== "agent") {
      throw new Error(
        `Automation cannot act: session is under ${this.controller} control`,
      );
    }
  }

  async close(): Promise<void> {
    await this.context.close();
    await this.browser.close();
  }
}
