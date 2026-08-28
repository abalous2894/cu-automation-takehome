/**
 * Meridian CU Core — legacy-style back-office mock
 *
 * Intentionally hostile to automation:
 * - Table-based layouts, no test IDs, minimal ARIA
 * - Frameset navigation (toolbar + content)
 * - Simulated error states via query params
 */

import express from "express";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.MOCK_APP_PORT ?? "3000", 10);

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

interface Member {
  id: string;
  name: string;
  savingsBalance: number;
  checkingBalance: number;
  status: "active" | "closed";
}

const MEMBERS: Record<string, Member> = {
  "12345": {
    id: "12345",
    name: "Jane Smith",
    savingsBalance: 8420.5,
    checkingBalance: 1250.0,
    status: "active",
  },
  "67890": {
    id: "67890",
    name: "Robert Johnson",
    savingsBalance: 15200.75,
    checkingBalance: 3400.25,
    status: "active",
  },
  "11111": {
    id: "11111",
    name: "Maria Garcia",
    savingsBalance: 0,
    checkingBalance: 50.0,
    status: "closed",
  },
};

// Tenant overrides for the multi-tenant demo. Tenant A deliberately keeps
// the SAME field labels as the base deployment (only branding/URL differ) —
// a base artifact replays there with just an entry-URL change. Tenant B
// renames fields, which is the case that needs a label overlay.
const TENANT_LABELS: Record<string, Record<string, string>> = {
  "tenant-a": {
    memberLabel: "Member #",
    searchTitle: "Member Search",
    brand: "Northside Federal CU",
  },
  "tenant-b": {
    memberLabel: "Account Number",
    searchTitle: "Account Lookup",
    brand: "Southgate Community CU",
  },
};

// ---------------------------------------------------------------------------
// HTML helpers — deliberately legacy markup
// ---------------------------------------------------------------------------

function pageShell(title: string, body: string, tenant?: string): string {
  const labels = tenant ? TENANT_LABELS[tenant] : undefined;
  const searchTitle = labels?.searchTitle ?? "Member Search";
  const brand = labels?.brand ? ` — ${labels.brand}` : "";

  return `<!DOCTYPE html>
<html>
<head>
  <title>${title} — Meridian CU Core</title>
  <style>
    body { font-family: Tahoma, Arial, sans-serif; font-size: 12px; margin: 0; background: #c0c0c0; }
    .toolbar { background: #000080; color: white; padding: 4px 8px; font-weight: bold; }
    .toolbar a { color: #ffff00; margin-right: 16px; text-decoration: none; }
    .content { padding: 12px; background: #ffffff; margin: 8px; border: 2px inset #808080; }
    table.form { border-collapse: collapse; }
    table.form td { padding: 4px 8px; vertical-align: middle; }
    table.form td.label { text-align: right; font-weight: bold; white-space: nowrap; }
    table.data { border-collapse: collapse; width: 100%; margin-top: 12px; }
    table.data th, table.data td { border: 1px solid #808080; padding: 4px 8px; text-align: left; }
    table.data th { background: #000080; color: white; }
    .error { color: red; font-weight: bold; padding: 8px; border: 1px solid red; background: #fff0f0; }
    .warning { color: #804000; font-weight: bold; padding: 8px; border: 1px solid #ff8000; background: #ffffcc; }
    input[type=text] { border: 2px inset #808080; padding: 2px 4px; font-family: Tahoma; }
    input[type=submit], input[type=button] { border: 2px outset #808080; padding: 2px 12px; background: #c0c0c0; cursor: pointer; }
    .balance { font-size: 16px; font-weight: bold; color: #000080; }
  </style>
</head>
<body>
  <div class="toolbar">
    MERIDIAN CU CORE v4.2.1${brand} &nbsp;|&nbsp;
    <a href="/">Home</a>
    <a href="/search">Member Search</a>
    <a href="/tenant-a/search">Tenant A</a>
    <a href="/tenant-b/search">Tenant B</a>
  </div>
  <div class="content">
    ${body}
  </div>
</body>
</html>`;
}

function searchPage(tenant?: string, error?: string, simulate?: string): string {
  const labels = tenant ? TENANT_LABELS[tenant] : undefined;
  const memberLabel = labels?.memberLabel ?? "Member #";
  const searchTitle = labels?.searchTitle ?? "Member Search";
  const basePath = tenant ? `/${tenant}` : "";

  let extra = "";
  if (simulate === "timeout") {
    extra = `<div class="warning">Session expired — please log in again. <input type="button" value="OK" onclick="this.parentElement.style.display='none'"></div>`;
  }

  return pageShell(searchTitle, `
    <h2>${searchTitle}</h2>
    ${extra}
    ${error ? `<div class="error">${error}</div>` : ""}
    <form method="GET" action="${basePath}/member">
      <table class="form">
        <tr>
          <td class="label">${memberLabel}</td>
          <td><input type="text" name="id" size="20" maxlength="10"></td>
        </tr>
        <tr>
          <td></td>
          <td><input type="submit" value="Search"></td>
        </tr>
      </table>
    </form>
  `, tenant);
}

function memberDetailPage(member: Member, simulate?: string): string {
  let extra = "";
  if (simulate === "permission_denied") {
    extra = `<div class="error">Access Denied — you do not have permission to view this account.</div>`;
  }

  return pageShell(`Member ${member.id}`, `
    <h2>Account Summary</h2>
    ${extra}
    <table class="form">
      <tr><td class="label">Member Name:</td><td>${member.name}</td></tr>
      <tr><td class="label">Member #:</td><td>${member.id}</td></tr>
      <tr><td class="label">Status:</td><td>${member.status.toUpperCase()}</td></tr>
    </table>
    <h3>Account Balances</h3>
    <table class="data">
      <tr><th>Account Type</th><th>Balance</th></tr>
      <tr><td>Savings</td><td class="balance">$${member.savingsBalance.toFixed(2)}</td></tr>
      <tr><td>Checking</td><td class="balance">$${member.checkingBalance.toFixed(2)}</td></tr>
    </table>
    <br>
    <form method="GET" action="/subaccount">
      <input type="hidden" name="memberId" value="${member.id}">
      <input type="submit" value="Open New Sub-Account">
    </form>
  `);
}

function notFoundPage(id: string, tenant?: string): string {
  const basePath = tenant ? `/${tenant}` : "";
  // Escape the reflected query value — even a mock shouldn't demo XSS
  const safeId = id.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return pageShell("Not Found", `
    <h2>Search Results</h2>
    <div class="error">No member found matching ID: ${safeId}</div>
    <p><a href="${basePath}/search">Return to search</a></p>
  `, tenant);
}

function subAccountFormPage(memberId: string): string {
  return pageShell("New Sub-Account", `
    <h2>Open New Sub-Account</h2>
    <p>Member: ${memberId}</p>
    <form method="POST" action="/subaccount/confirm">
      <input type="hidden" name="memberId" value="${memberId}">
      <table class="form">
        <tr>
          <td class="label">Account Type:</td>
          <td>
            <select name="accountType">
              <option value="savings">Savings</option>
              <option value="checking">Checking</option>
            </select>
          </td>
        </tr>
        <tr>
          <td class="label">Initial Deposit:</td>
          <td><input type="text" name="deposit" size="10" value="0.00"></td>
        </tr>
        <tr>
          <td></td>
          <td><input type="submit" value="Continue to Confirmation"></td>
        </tr>
      </table>
    </form>
  `);
}

function subAccountConfirmPage(memberId: string, accountType: string, deposit: string): string {
  return pageShell("Confirm Sub-Account", `
    <h2>Confirmation Required</h2>
    <div class="warning">This action cannot be undone. Review details before submitting.</div>
    <table class="form">
      <tr><td class="label">Member #:</td><td>${memberId}</td></tr>
      <tr><td class="label">Account Type:</td><td>${accountType}</td></tr>
      <tr><td class="label">Initial Deposit:</td><td>$${deposit}</td></tr>
    </table>
    <form method="POST" action="/subaccount/submit">
      <input type="hidden" name="memberId" value="${memberId}">
      <input type="hidden" name="accountType" value="${accountType}">
      <input type="hidden" name="deposit" value="${deposit}">
      <input type="submit" value="Submit — Create Account">
    </form>
  `);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const app = express();
app.use(express.urlencoded({ extended: true }));

app.get("/", (_req, res) => {
  res.send(pageShell("Home", `
    <h2>Meridian CU Core — Back Office</h2>
    <p>Welcome to the Meridian Credit Union core banking system.</p>
    <p><a href="/search">Member Search</a></p>
  `));
});

app.get("/search", (req, res) => {
  res.send(searchPage(undefined, undefined, req.query.simulate as string));
});

app.get("/tenant-a/search", (req, res) => {
  res.send(searchPage("tenant-a", undefined, req.query.simulate as string));
});

app.get("/tenant-b/search", (req, res) => {
  res.send(searchPage("tenant-b", undefined, req.query.simulate as string));
});

app.get("/member", (req, res) => {
  const id = String(req.query.id ?? "").trim();
  const simulate = req.query.simulate as string | undefined;

  if (!id) {
    res.send(searchPage(undefined, "Please enter a member ID."));
    return;
  }

  const member = MEMBERS[id];
  if (!member) {
    res.send(notFoundPage(id));
    return;
  }

  res.send(memberDetailPage(member, simulate));
});

function handleMemberLookup(req: express.Request, res: express.Response): void {
  const id = String(req.query.id ?? "").trim();
  const simulate = req.query.simulate as string | undefined;
  // Keep tenant branding/labels on error pages too
  const tenant = req.path.startsWith("/tenant-a")
    ? "tenant-a"
    : req.path.startsWith("/tenant-b")
      ? "tenant-b"
      : undefined;

  if (!id) {
    res.send(searchPage(tenant, "Please enter a member ID."));
    return;
  }

  const member = MEMBERS[id];
  if (!member) {
    res.send(notFoundPage(id, tenant));
    return;
  }

  res.send(memberDetailPage(member, simulate));
}

app.get("/tenant-a/member", handleMemberLookup);
app.get("/tenant-b/member", handleMemberLookup);

app.get("/subaccount", (req, res) => {
  const memberId = String(req.query.memberId ?? "");
  res.send(subAccountFormPage(memberId));
});

app.post("/subaccount/confirm", (req, res) => {
  const { memberId, accountType, deposit } = req.body;
  res.send(subAccountConfirmPage(memberId, accountType, deposit));
});

app.post("/subaccount/submit", (req, res) => {
  const { memberId, accountType } = req.body;
  res.send(pageShell("Success", `
    <h2>Sub-Account Created</h2>
    <p>New ${accountType} account created for member ${memberId}.</p>
  `));
});

// Frameset demo — legacy navigation pattern
app.get("/frameset", (_req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><title>Meridian CU — Frameset</title></head>
<frameset rows="40,*">
  <frame src="/frameset/toolbar" name="toolbar" noresize>
  <frameset cols="200,*">
    <frame src="/frameset/nav" name="nav" noresize>
    <frame src="/search" name="content">
  </frameset>
</frameset>
</html>`);
});

app.get("/frameset/toolbar", (_req, res) => {
  res.send(`<html><body style="background:#000080;color:white;font-family:Tahoma;font-size:11px;margin:0;padding:4px;">
    MERIDIAN CU CORE v4.2.1 — Back Office Terminal
  </body></html>`);
});

app.get("/frameset/nav", (_req, res) => {
  res.send(`<html><body style="background:#c0c0c0;font-family:Tahoma;font-size:11px;margin:0;padding:4px;">
    <a href="/search" target="content">Member Search</a><br>
    <a href="/" target="content">Home</a>
  </body></html>`);
});

app.listen(PORT, () => {
  console.log(`Meridian CU Core mock running at http://localhost:${PORT}`);
  console.log(`  Search:    http://localhost:${PORT}/search`);
  console.log(`  Frameset:  http://localhost:${PORT}/frameset`);
  console.log(`  Tenant A:  http://localhost:${PORT}/tenant-a/search`);
  console.log(`  Tenant B:  http://localhost:${PORT}/tenant-b/search`);
});
