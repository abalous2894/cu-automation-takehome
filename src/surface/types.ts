import type { Page, Frame, Locator } from "playwright";
import type {
  ActionType,
  ElementTarget,
  LocatorStrategy,
} from "../schema/capability.js";

export interface SurfaceObservation {
  snapshot: string;
  url: string;
  title: string;
}

export interface SurfaceAction {
  action: ActionType;
  ref?: string;
  target?: ElementTarget;
  value?: string;
  description?: string;
}

export interface SurfaceAdapter {
  observe(): Promise<SurfaceObservation>;
  execute(action: SurfaceAction): Promise<void>;
  resolveTarget(target: ElementTarget): Promise<Locator>;
  captureTargetFromRef(ref: string): Promise<ElementTarget>;
  getPage(): Page;
}

export class LocatorMissError extends Error {
  constructor(
    message: string,
    public readonly strategiesTried: LocatorStrategy[],
  ) {
    super(message);
    this.name = "LocatorMissError";
  }
}

export interface ResolvedTarget {
  locator: Locator;
  /** Index into target.strategies of the strategy that resolved */
  strategyIndex: number;
  strategy: LocatorStrategy;
  /** True when a fallback (non-primary) strategy was needed — a drift signal */
  usedFallback: boolean;
}

/**
 * Try each strategy in order until one resolves to exactly one element.
 * Returning which strategy matched is the drift-detection signal: if the
 * primary strategy stops working but a fallback still resolves, the run
 * succeeds AND we learn the UI has drifted — the same telemetry model
 * production RPA healing agents use.
 */
export async function resolveLocatorDetailed(
  page: Page,
  target: ElementTarget,
): Promise<ResolvedTarget> {
  let context: Page | Frame = page;

  if (target.framePath?.length) {
    for (const frameName of target.framePath) {
      const frames: Frame[] =
        "frames" in context ? context.frames() : page.frames();
      const frame = frames.find(
        (f) => f.name() === frameName || f.url().includes(frameName),
      );
      if (!frame) {
        throw new LocatorMissError(`Frame not found: ${frameName}`, target.strategies);
      }
      context = frame;
    }
  }

  for (let i = 0; i < target.strategies.length; i++) {
    const strategy = target.strategies[i];
    // buildLocator inside the try: a malformed strategy (e.g. role type
    // without a role) must fall through to the next strategy, not crash
    // the whole resolution.
    try {
      const locator = buildLocator(context, strategy);
      const count = await locator.count();
      if (count === 1) {
        return { locator, strategyIndex: i, strategy, usedFallback: i > 0 };
      }
      if (count > 1) continue;
    } catch {
      continue;
    }
  }

  throw new LocatorMissError(
    `No locator strategy resolved uniquely: ${JSON.stringify(target.strategies)}`,
    target.strategies,
  );
}

export async function resolveLocator(
  page: Page,
  target: ElementTarget,
): Promise<Locator> {
  const resolved = await resolveLocatorDetailed(page, target);
  return resolved.locator;
}

function buildLocator(context: Page | Frame, strategy: LocatorStrategy): Locator {
  switch (strategy.type) {
    case "role":
      return strategy.name || strategy.value === "textbox"
        ? context.getByRole(strategy.role as never, {
            name: strategy.name ?? undefined,
            exact: strategy.match === "exact",
          })
        : context.getByRole(strategy.role as never);
    case "label":
      return context.getByLabel(strategy.value, {
        exact: strategy.match === "exact",
      });
    case "placeholder":
      return context.getByPlaceholder(strategy.value, {
        exact: strategy.match === "exact",
      });
    case "text":
      return context.getByText(strategy.value, {
        exact: strategy.match === "exact",
      });
    case "css":
      return context.locator(strategy.value);
    case "xpath":
      return context.locator(`xpath=${strategy.value}`);
    default:
      throw new Error(`Unknown locator strategy: ${strategy.type}`);
  }
}

export async function inferLocatorsFromRef(
  page: Page,
  ref: string,
): Promise<ElementTarget> {
  const locator = page.locator(`aria-ref=${ref}`);
  const strategies: LocatorStrategy[] = [];

  // Short timeouts: a stale/invalid ref should fail fast (this runs in the
  // recording and recovery paths), not burn 30s per attribute read.
  const t = { timeout: 2000 };
  const role = await locator.getAttribute("role", t).catch(() => null);
  const ariaLabel = await locator.getAttribute("aria-label", t).catch(() => null);
  const placeholder = await locator.getAttribute("placeholder", t).catch(() => null);
  const tagName = await locator
    .evaluate((el) => el.tagName.toLowerCase(), undefined, t)
    .catch(() => null);
  const inputType = await locator.getAttribute("type", t).catch(() => null);
  const valueAttr = await locator.getAttribute("value", t).catch(() => null);
  const textContent = await locator.textContent(t).catch(() => null);

  const implicitRole = role ?? inferImplicitRole(tagName, inputType);
  // For <input type=submit|button>, the accessible name is the value attribute
  const buttonValue =
    tagName === "input" && (inputType === "submit" || inputType === "button")
      ? valueAttr
      : null;
  const accessibleName = ariaLabel ?? buttonValue ?? textContent?.trim();

  if (implicitRole && accessibleName) {
    strategies.push({
      type: "role",
      role: implicitRole,
      name: accessibleName,
      value: accessibleName,
      match: "exact",
    });
  }

  if (placeholder) {
    strategies.push({
      type: "placeholder",
      value: placeholder,
      match: "exact",
    });
  }

  const nameAttr = await locator.getAttribute("name").catch(() => null);
  if (nameAttr && (tagName === "input" || tagName === "select" || tagName === "textarea")) {
    strategies.push({
      type: "css",
      value: `${tagName}[name="${nameAttr}"]`,
      match: "exact",
    });
  }

  if (implicitRole === "textbox" && !accessibleName) {
    strategies.push({
      type: "role",
      role: "textbox",
      value: "textbox",
      match: "exact",
    });
  }

  if (accessibleName && !placeholder && implicitRole === "textbox") {
    strategies.push({
      type: "label",
      value: accessibleName,
      match: "contains",
    });
  }

  if (strategies.length === 0 && textContent?.trim()) {
    strategies.push({
      type: "text",
      value: textContent.trim(),
      match: "exact",
    });
  }

  return { strategies };
}

function inferImplicitRole(
  tagName: string | null,
  inputType: string | null,
): string | null {
  if (tagName === "input") {
    switch (inputType) {
      case "submit":
      case "button":
      case "reset":
        return "button";
      case "checkbox":
        return "checkbox";
      case "radio":
        return "radio";
      default:
        return "textbox";
    }
  }
  const map: Record<string, string> = {
    button: "button",
    a: "link",
    select: "combobox",
    textarea: "textbox",
  };
  return tagName ? (map[tagName] ?? null) : null;
}

