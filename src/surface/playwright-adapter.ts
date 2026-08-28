import type { Browser, Page } from "playwright";
import type { ActionType, ElementTarget } from "../schema/capability.js";
import type { PolicyEngine } from "../policy/engine.js";
import {
  inferLocatorsFromRef,
  resolveLocator,
  type SurfaceAction,
  type SurfaceAdapter,
  type SurfaceObservation,
} from "./types.js";

export class PlaywrightSurfaceAdapter implements SurfaceAdapter {
  constructor(private page: Page) {}

  static async create(
    browser: Browser,
    options: {
      headless?: boolean;
      viewport?: { width: number; height: number };
      /**
       * When provided, EVERY network request — main-frame navigations,
       * link clicks, form posts, redirects, subresources — is checked
       * against the policy allowlist at the network layer. Explicit goto
       * checks alone don't cover navigation triggered by UI interaction.
       */
      policy?: PolicyEngine;
    } = {},
  ): Promise<{ adapter: PlaywrightSurfaceAdapter; page: Page }> {
    const context = await browser.newContext({
      viewport: options.viewport ?? { width: 1280, height: 720 },
    });
    if (options.policy) {
      const policy = options.policy;
      await context.route("**/*", (route) => {
        try {
          policy.assertNavigationAllowed(route.request().url());
          void route.continue();
        } catch (err) {
          // Nothing leaves the machine either way. For main-frame navigations,
          // render an explicit block page so screenshots taken after the block
          // are self-explanatory evidence; subresources are silently aborted.
          if (route.request().resourceType() === "document") {
            const message = (err instanceof Error ? err.message : String(err))
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;");
            void route.fulfill({
              status: 403,
              contentType: "text/html",
              body: `<html><body style="font-family:monospace;padding:40px"><h1>Blocked by policy</h1><p>${message}</p><p>This navigation was stopped at the network layer. No request was sent.</p></body></html>`,
            });
          } else {
            void route.abort("blockedbyclient");
          }
        }
      });
    }
    const page = await context.newPage();
    return { adapter: new PlaywrightSurfaceAdapter(page), page };
  }

  getPage(): Page {
    return this.page;
  }

  async observe(): Promise<SurfaceObservation> {
    const snapshot = await this.page.locator("body").ariaSnapshot({ mode: "ai" });
    return {
      snapshot,
      url: this.page.url(),
      title: await this.page.title(),
    };
  }

  async execute(action: SurfaceAction): Promise<void> {
    switch (action.action) {
      case "navigate": {
        if (!action.value) throw new Error("navigate requires a URL value");
        await this.page.goto(action.value, { waitUntil: "domcontentloaded" });
        break;
      }
      case "click": {
        const locator = await this.resolveActionTarget(action);
        await locator.click({ timeout: action.target ? 10000 : 5000 });
        break;
      }
      case "fill": {
        const locator = await this.resolveActionTarget(action);
        await locator.fill(action.value ?? "", { timeout: 10000 });
        break;
      }
      case "select": {
        const locator = await this.resolveActionTarget(action);
        await locator.selectOption(action.value ?? "");
        break;
      }
      case "press": {
        await this.page.keyboard.press(action.value ?? "Enter");
        break;
      }
      case "wait": {
        const ms = action.value ? parseInt(action.value, 10) : 1000;
        await this.page.waitForTimeout(ms);
        break;
      }
      default:
        throw new Error(`Action not implemented in adapter: ${action.action}`);
    }
  }

  async resolveTarget(target: ElementTarget) {
    return resolveLocator(this.page, target);
  }

  async captureTargetFromRef(ref: string): Promise<ElementTarget> {
    return inferLocatorsFromRef(this.page, ref);
  }

  private async resolveActionTarget(action: SurfaceAction) {
    if (action.target) {
      return resolveLocator(this.page, action.target);
    }
    if (action.ref) {
      return this.page.locator(`aria-ref=${action.ref}`);
    }
    throw new Error("Action requires either ref or target");
  }
}

export function surfaceAction(
  action: ActionType,
  opts: Omit<SurfaceAction, "action"> = {},
): SurfaceAction {
  return { action, ...opts };
}
