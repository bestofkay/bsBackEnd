/**
 * Recompute analysis for uploads/extraction-result.json and refresh APT-SAMPLE01 archive.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const samplePath = path.resolve("uploads/extraction-result.json");

async function loadAnalyze() {
  const mod = await import(pathToFileURL(path.resolve("src/modules/analysis/analyze.ts")).href);
  return mod.analyzeStatement;
}

async function main() {
  const analyzeStatement = await loadAnalyze();
  const body = JSON.parse(fs.readFileSync(samplePath, "utf8"));
  const statement = body.statement || {};
  const period = statement.statement_period || {};
  const analysis = analyzeStatement({
    statement: {
      id: body.statement_id || "stmt_APT-SAMPLE01",
      account: {
        account_name: statement.account_name ?? null,
        account_number: statement.account_number ?? null,
        bank_name: statement.bank_name ?? null,
        bank_code: null,
        currency: statement.currency ?? "NGN",
        account_type: statement.account_type ?? null,
        branch: null,
        iban: null,
        sort_code: null,
      },
      statement_period_start: period.from ?? null,
      statement_period_end: period.to ?? null,
      opening_balance: statement.opening_balance ?? null,
      closing_balance: statement.closing_balance ?? null,
      currency: statement.currency ?? "NGN",
      bank_name: statement.bank_name ?? null,
      statement_number: null,
      page_count: null,
      extracted_at: null,
    },
    transactions: body.transactions || [],
    reconciled: body.validation?.reconciled === true,
  });

  body.analysis = analysis;
  fs.writeFileSync(samplePath, JSON.stringify(body));
  console.log("Wrote analysis to extraction-result.json");
  console.log({
    score: analysis.score,
    overdraft_days: analysis.cashflow.overdraft_days,
    deepest: analysis.cashflow.highest_overdraft,
    dep_act: analysis.activity.monthly_deposit_activity_pct,
    wd_act: analysis.activity.monthly_withdrawal_activity_pct,
    avg_net: analysis.cashflow.average_monthly_net,
    is_gambler: analysis.flags.is_gambler,
  });

  // Force re-import via sample-report by deleting DB analysis if API is up
  const loginRes = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "demo@statement.local", password: "demo1234" }),
  });
  if (!loginRes.ok) {
    console.warn("API login failed; file updated only");
    return;
  }
  const cookieList =
    typeof loginRes.headers.getSetCookie === "function" ? loginRes.headers.getSetCookie() : [];
  const cookie = (cookieList[0] || loginRes.headers.get("set-cookie") || "").split(";")[0];

  // Touch catalog by calling sample-report after clearing file catalog payload analysis is enough
  // Prefer direct upsert through sample endpoint — delete catalog file so it reimports
  const catalogPayload = path.resolve("uploads/catalog/APT-SAMPLE01.json");
  if (fs.existsSync(catalogPayload)) fs.unlinkSync(catalogPayload);

  // Also nudge MySQL by posting a tiny marker via Prisma in Node if available
  try {
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient();
    await prisma.analysis.deleteMany({ where: { referenceId: "APT-SAMPLE01" } });
    await prisma.$disconnect();
    console.log("Cleared MySQL APT-SAMPLE01 analysis row");
  } catch (e) {
    console.warn("MySQL clear skipped:", e.message);
  }

  const sampleRes = await fetch(`${BASE}/api/v1/auth/sample-report`, {
    headers: { Cookie: cookie },
  });
  const sample = await sampleRes.json();
  console.log("sample-report", sampleRes.status, {
    score: sample.analysis?.score,
    od: sample.analysis?.cashflow?.overdraft_days,
    dep: sample.analysis?.activity?.monthly_deposit_activity_pct,
    storage: sample.storage,
  });
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
