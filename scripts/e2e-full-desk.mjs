/**
 * Full desk E2E: auth → users → sample → extract → analysis → search → get → UI assets.
 */
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const prisma = new PrismaClient();
const failures = [];

function assert(cond, msg) {
  if (!cond) {
    failures.push(msg);
    console.error("FAIL:", msg);
  } else {
    console.log("OK  ", msg);
  }
}

async function json(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON ${res.status}: ${text.slice(0, 240)}`);
  }
}

function cookieHeader(res) {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const raw = list[0] || res.headers.get("set-cookie") || "";
  return raw.split(";")[0];
}

async function main() {
  console.log("BASE", BASE);

  const health = await fetch(`${BASE}/health`).then(json);
  assert(health.status === "ok", "GET /health");

  const ready = await fetch(`${BASE}/ready`).then(json);
  assert(ready.status === "ready", "GET /ready");

  // Static UI
  const indexHtml = await fetch(`${BASE}/`).then((r) => r.text());
  assert(indexHtml.includes("Statement Analysis"), "index title Statement Analysis");
  assert(!indexHtml.includes("Aperture —"), "old Aperture title removed");
  const appJs = await fetch(`${BASE}/assets/app.js`).then((r) => r.text());
  assert(appJs.includes('APP_NAME = "Statement Analysis"'), "app.js branding");
  assert(appJs.includes('data-nav="users"'), "app.js Users nav");
  assert(appJs.includes("/api/v1/auth/users"), "app.js users API");
  const appCss = await fetch(`${BASE}/assets/app.css`).then((r) => r.status);
  assert(appCss === 200, "app.css served");

  // Wrong password
  const badLogin = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "demo@statement.local", password: "wrong" }),
  });
  assert(badLogin.status === 401, "bad password → 401");

  // Login
  const loginRes = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "demo@statement.local", password: "demo1234" }),
  });
  const login = await json(loginRes);
  const cookie = cookieHeader(loginRes);
  assert(loginRes.status === 200 && login.success, "login success");
  assert(cookie && cookie.startsWith("sa_session="), "sa_session cookie");
  const headers = { Cookie: cookie };

  const me = await fetch(`${BASE}/api/v1/auth/me`, { headers }).then(json);
  assert(me.success && me.user?.email === "demo@statement.local", "/auth/me");

  // Users list + create
  const usersBefore = await fetch(`${BASE}/api/v1/auth/users`, { headers }).then(json);
  assert(usersBefore.success && Array.isArray(usersBefore.users), "list users");
  assert(usersBefore.users.some((u) => u.email === "demo@statement.local"), "demo user listed");

  const uniq = `e2e_${Date.now()}@example.com`;
  const createRes = await fetch(`${BASE}/api/v1/auth/users`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ email: uniq, password: "pass1234", name: "E2E User" }),
  });
  const created = await json(createRes);
  assert(createRes.status === 201 && created.user?.email === uniq, "create user 201");

  const dupRes = await fetch(`${BASE}/api/v1/auth/users`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ email: uniq, password: "pass1234", name: "Dup" }),
  });
  assert(dupRes.status === 409, "duplicate user → 409");

  const newLogin = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: uniq, password: "pass1234" }),
  });
  assert(newLogin.status === 200, "new user can login");

  // Sample report path
  const sampleRes = await fetch(`${BASE}/api/v1/auth/sample-report`, { headers });
  const sample = await json(sampleRes);
  assert(sampleRes.status === 200, `sample-report ${sampleRes.status}`);
  assert(sample.reference_id === "APT-SAMPLE01", "sample reference");
  assert(sample.analysis?.score != null, "sample analysis.score");
  assert(Array.isArray(sample.transactions) && sample.transactions.length > 0, "sample txs");
  assert(
    (sample.analysis?.cashflow?.average_monthly_net == null ||
      Number.isFinite(sample.analysis.cashflow.average_monthly_net)) &&
      (sample.analysis?.cashflow?.lowest_balance == null ||
        Number.isFinite(sample.analysis.cashflow.lowest_balance)),
    "sample cashflow numbers finite",
  );
  const actDep = sample.analysis?.activity?.monthly_deposit_activity_pct;
  const actWd = sample.analysis?.activity?.monthly_withdrawal_activity_pct;
  if (actDep != null) assert(actDep <= 100.0001, `deposit activity ≤100 (got ${actDep})`);
  if (actWd != null) assert(actWd <= 100.0001, `withdrawal activity ≤100 (got ${actWd})`);
  assert(sample.analysis?.timing?.by_weekday?.length === 7, "sample timing.by_weekday");
  assert(sample.analysis?.timing?.week_of_month_totals?.length === 4, "sample week_of_month_totals");
  assert(sample.analysis?.timing?.loans?.by_weekday?.length === 7, "sample loan timing weekday");
  assert(
    sample.analysis?.timing?.loans?.week_of_month_totals?.length === 4,
    "sample loan week totals",
  );
  assert(appJs.includes("When money flows"), "app.js inflow timing section");
  assert(appJs.includes("When loans are disbursed"), "app.js loan timing section");
  assert(appJs.includes("weekMatrixTable"), "app.js week matrix helper");
  assert(appJs.includes('fd.append("force", "true")'), "upload forces fresh extract");
  assert(appJs.includes("force: true"), "url extract forces fresh run");
  assert(appJs.includes("bindInteractiveCharts"), "interactive chart binder");
  assert(appJs.includes("beginFreshRun"), "clears prior result before new run");

  if (ready.database?.configured !== false && ready.database?.ok) {
    const sampleTxDb = await prisma.transaction.count({
      where: { statementId: "stmt_APT-SAMPLE01" },
    });
    assert(sampleTxDb > 0, `sample txs in MySQL (${sampleTxDb})`);
  }

  // Search / get
  const searchRef = await fetch(`${BASE}/api/v1/analyses/search?reference_id=APT-SAMPLE01`, {
    headers,
  }).then(json);
  assert(searchRef.total >= 1, "search sample by reference");
  assert(
    searchRef.results?.some((r) => r.reference_id === "APT-SAMPLE01"),
    "search results include sample",
  );

  const getSample = await fetch(`${BASE}/api/v1/analyses/APT-SAMPLE01`, { headers }).then(json);
  assert(getSample.success && getSample.result?.reference_id === "APT-SAMPLE01", "GET sample");
  assert(
    sample.analysis?.score == null || getSample.result?.analysis?.score === sample.analysis.score,
    "GET analysis matches sample",
  );
  assert(getSample.result?.analysis?.timing?.loans?.by_weekday?.length === 7, "GET sample has loan timing");

  // Live extract CSV
  const filePath = path.resolve("tests/fixtures/statement.csv");
  assert(fs.existsSync(filePath), "fixture statement.csv exists");
  const bytes = fs.readFileSync(filePath);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "text/csv" }), path.basename(filePath));
  form.append("owner_name", "E2E Desk Owner");
  form.append("period_start", "2020-01-01");
  form.append("period_end", "2030-12-31");
  form.append("force", "true");

  const extractRes = await fetch(`${BASE}/api/v1/statements/extract`, {
    method: "POST",
    headers,
    body: form,
  });
  const extracted = await json(extractRes);
  assert(extractRes.status === 200 && extracted.success, `extract ${extractRes.status}`);
  assert(typeof extracted.reference_id === "string" && extracted.reference_id.startsWith("APT-"), "reference_id");
  assert(extracted.owner_name === "E2E Desk Owner", "owner_name");
  assert(extracted.analysis != null && extracted.analysis.score != null, "extract analysis");
  assert(Array.isArray(extracted.transactions), "extract transactions array");

  const flags = extracted.analysis?.flags || {};
  assert(typeof flags === "object", "analysis.flags object");
  assert(Array.isArray(extracted.analysis?.categories), "analysis.categories");
  assert(extracted.analysis?.cashflow != null, "analysis.cashflow");
  assert(extracted.analysis?.timing?.by_weekday?.length === 7, "extract timing.by_weekday");
  assert(extracted.analysis?.timing?.loans != null, "extract timing.loans");

  const ref = extracted.reference_id;
  const stmtId = extracted.statement_id;

  if (ready.database?.ok) {
    const analysisRow = await prisma.analysis.findUnique({ where: { referenceId: ref } });
    assert(!!analysisRow, `analyses row ${ref}`);
    assert(analysisRow.ownerName === "E2E Desk Owner", "analyses.owner_name");
    const txCount = await prisma.transaction.count({ where: { statementId: stmtId } });
    const expected = extracted.summary?.transaction_count ?? extracted.transactions?.length;
    assert(txCount === expected, `txs persisted ${txCount}===${expected}`);
  }

  const searchLive = await fetch(
    `${BASE}/api/v1/analyses/search?owner=${encodeURIComponent("E2E Desk")}`,
    { headers },
  ).then(json);
  assert(
    searchLive.results?.some((r) => r.reference_id === ref),
    "search finds extracted analysis",
  );

  const getLive = await fetch(`${BASE}/api/v1/analyses/${ref}`, { headers }).then(json);
  assert(getLive.result?.reference_id === ref, "GET live ref");
  assert(getLive.result?.owner_name === "E2E Desk Owner", "GET live owner");
  assert(getLive.result?.analysis?.score === extracted.analysis.score, "GET live score match");

  // Idempotent replay
  const form2 = new FormData();
  form2.append("file", new Blob([bytes], { type: "text/csv" }), path.basename(filePath));
  form2.append("owner_name", "Ignored On Replay");
  const replayRes = await fetch(`${BASE}/api/v1/statements/extract`, {
    method: "POST",
    headers,
    body: form2,
  });
  const replay = await json(replayRes);
  assert(replay.idempotent_replay === true, "idempotent_replay");
  assert(replay.reference_id === ref, "idempotent same reference");

  const missing = await fetch(`${BASE}/api/v1/analyses/APT-DOESNOTEXIST`, { headers });
  assert(missing.status === 404, "unknown ref 404");

  // Empty search rejected
  const emptySearch = await fetch(`${BASE}/api/v1/analyses/search`, { headers });
  assert(emptySearch.status === 400, "empty search → 400");

  // Unauthenticated users / archive denied
  const noAuthUsers = await fetch(`${BASE}/api/v1/auth/users`);
  assert(noAuthUsers.status === 401, "users without session → 401");
  const noAuthSearch = await fetch(`${BASE}/api/v1/analyses/search?reference_id=APT-SAMPLE01`);
  assert(noAuthSearch.status === 401, "search without session → 401");
  const noAuthGet = await fetch(`${BASE}/api/v1/analyses/APT-SAMPLE01`);
  assert(noAuthGet.status === 401, "get without session → 401");

  // Logout
  const logoutRes = await fetch(`${BASE}/api/v1/auth/logout`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: "{}",
  });
  assert(logoutRes.status === 200, "logout");

  console.log("\n--- summary ---");
  if (failures.length) {
    console.error(`${failures.length} failure(s)`);
    process.exitCode = 1;
  } else {
    console.log("All desk checks passed");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
