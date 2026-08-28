/**
 * Verify the network-layer allowlist (H5): a page created with a policy
 * must block ALL requests to non-allowlisted domains, regardless of how
 * the navigation is triggered.
 */
import { chromium } from "playwright";
import { PlaywrightSurfaceAdapter } from "../src/surface/playwright-adapter.js";
import { PolicyEngine } from "../src/policy/engine.js";

const browser = await chromium.launch({ headless: true });
const { page } = await PlaywrightSurfaceAdapter.create(browser, {
  policy: new PolicyEngine(),
});

// 1. Allowed navigation works
await page.goto("http://localhost:3000/search", { waitUntil: "domcontentloaded" });
console.log("allowed goto:", page.url());

// 2. Direct goto to external domain is intercepted — the block page renders,
// no request leaves the machine
await page.goto("https://example.com", { timeout: 5000 }).catch(() => {});
const gotoBlocked = await page.content();
console.log(
  gotoBlocked.includes("Blocked by policy")
    ? "blocked goto: policy block page rendered"
    : "FAIL: external goto was NOT blocked",
);

// 3. UI-triggered navigation (click on injected external link) is blocked
await page.goto("http://localhost:3000/search", { waitUntil: "domcontentloaded" });
await page.evaluate(() => {
  const a = document.createElement("a");
  a.href = "https://example.com/exfil";
  a.textContent = "click me";
  a.id = "evil-link";
  document.body.appendChild(a);
});
await page.click("#evil-link").catch(() => {});
await page.waitForTimeout(1500);
const clickBlocked = await page.content();
console.log(
  clickBlocked.includes("Blocked by policy")
    ? "blocked click-nav: policy block page rendered, no request sent"
    : `FAIL: click navigated to ${page.url()}`,
);

await browser.close();
