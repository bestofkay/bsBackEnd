/**
 * End-to-end verification: MySQL archive (extract → search → get → idempotent).
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
    throw new Error(`Non-JSON ${res.status}: ${text.slice(0, 200)}`);
  }
}

async function main() {
  console.log("BASE", BASE);

  const ready = await fetch(`${BASE}/ready`).then(json);
  assert(ready.status === "ready" && ready.database?.ok, "GET /ready database ok");

  const loginRes = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "demo@statement.local", password: "demo1234" }),
  });
  const login = await json(loginRes);
  const cookieList =
    typeof loginRes.headers.getSetCookie === "function" ? loginRes.headers.getSetCookie() : [];
  const cookie = cookieList[0] || loginRes.headers.get("set-cookie");
  assert(login.success, "login success");
  assert(cookie, "session cookie set");

  const headers = { Cookie: String(cookie).split(";")[0] };

  // Sample import (should write analyses + transactions)
  const sampleRes = await fetch(`${BASE}/api/v1/auth/sample-report`, { headers });
  const sample = await json(sampleRes);
  assert(sampleRes.status === 200, `sample-report status ${sampleRes.status}`);
  assert(sample.reference_id === "APT-SAMPLE01", "sample reference_id");
  assert(sample.analysis?.score != null, "sample has analysis.score");
  assert(Array.isArray(sample.transactions) && sample.transactions.length > 0, "sample has transactions");

  const sampleTxDb = await prisma.transaction.count({
    where: { statementId: "stmt_APT-SAMPLE01" },
  });
  assert(sampleTxDb > 0, `sample transactions in MySQL (got ${sampleTxDb})`);

  const searchOwner = await fetch(
    `${BASE}/api/v1/analyses/search?owner=${encodeURIComponent("SAMUEL")}`,
    { headers },
  ).then(json);
  assert(searchOwner.storage === "mysql", "search storage=mysql");
  assert(searchOwner.total >= 1, "search by owner finds sample");
  assert(
    searchOwner.results.some((r) => r.reference_id === "APT-SAMPLE01"),
    "owner search includes APT-SAMPLE01",
  );

  const searchRef = await fetch(
    `${BASE}/api/v1/analyses/search?reference_id=APT-SAMPLE01`,
    { headers },
  ).then(json);
  assert(searchRef.total === 1, "search by reference exact");

  const getRes = await fetch(`${BASE}/api/v1/analyses/APT-SAMPLE01`, { headers }).then(json);
  assert(getRes.success && getRes.result?.reference_id === "APT-SAMPLE01", "GET by reference");
  assert(getRes.result?.analysis?.score === sample.analysis.score, "GET payload analysis matches");

  // Live extract with optional owner + date window
  const filePath = path.resolve("tests/fixtures/statement.csv");
  assert(fs.existsSync(filePath), "tests/fixtures/statement.csv exists");

  const bytes = fs.readFileSync(filePath);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "text/csv" }), path.basename(filePath));
  form.append("owner_name", "E2E Archive Owner");
  form.append("period_start", "2020-01-01");
  form.append("period_end", "2030-12-31");
  form.append("force", "true");

  const extractRes = await fetch(`${BASE}/api/v1/statements/extract`, {
    method: "POST",
    headers,
    body: form,
  });
  const extracted = await json(extractRes);
  assert(extractRes.status === 200 && extracted.success, `extract status ${extractRes.status}`);
  assert(typeof extracted.reference_id === "string" && extracted.reference_id.startsWith("APT-"), "extract allocates reference_id");
  assert(extracted.owner_name === "E2E Archive Owner", "extract owner_name applied");
  assert(extracted.analysis != null, "extract includes analysis");

  const ref = extracted.reference_id;
  const stmtId = extracted.statement_id;
  const analysisRow = await prisma.analysis.findUnique({ where: { referenceId: ref } });
  assert(!!analysisRow, `analyses row for ${ref}`);
  assert(analysisRow.ownerName === "E2E Archive Owner", "analyses.owner_name");
  assert(analysisRow.score != null, "analyses.score set");

  const txCount = await prisma.transaction.count({ where: { statementId: stmtId } });
  assert(txCount === (extracted.summary?.transaction_count ?? extracted.transactions?.length), `transactions persisted (${txCount})`);

  const searchLive = await fetch(
    `${BASE}/api/v1/analyses/search?owner=${encodeURIComponent("E2E Archive")}`,
    { headers },
  ).then(json);
  assert(
    searchLive.results.some((r) => r.reference_id === ref),
    "search finds freshly extracted analysis",
  );

  const getLive = await fetch(`${BASE}/api/v1/analyses/${ref}`, { headers }).then(json);
  assert(getLive.result?.reference_id === ref, "GET live reference");
  assert(getLive.result?.owner_name === "E2E Archive Owner", "GET live owner");

  // Idempotent replay should keep same reference
  const form2 = new FormData();
  form2.append("file", new Blob([bytes], { type: "text/csv" }), path.basename(filePath));
  form2.append("owner_name", "Ignored On Replay");
  const replayRes = await fetch(`${BASE}/api/v1/statements/extract`, {
    method: "POST",
    headers,
    body: form2,
  });
  const replay = await json(replayRes);
  assert(replay.idempotent_replay === true, "idempotent_replay true");
  assert(replay.reference_id === ref, `idempotent keeps reference ${ref}`);

  // 404 for unknown ref
  const missing = await fetch(`${BASE}/api/v1/analyses/APT-DOESNOTEXIST`, { headers });
  assert(missing.status === 404, "unknown reference → 404");

  console.log("\n--- summary ---");
  if (failures.length) {
    console.error(`${failures.length} failure(s)`);
    process.exitCode = 1;
  } else {
    console.log("All archive checks passed");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
