import { chromium } from "playwright";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto("http://localhost:3000/search");
  console.log(await page.locator("body").ariaSnapshot({ mode: "ai" }));
  console.log("textbox count:", await page.getByRole("textbox").count());
  console.log("button count:", await page.getByRole("button").count());
  await browser.close();
}

main();
