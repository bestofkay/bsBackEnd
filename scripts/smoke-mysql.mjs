import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();
try {
  await p.$connect();
  console.log("connected");
  console.log("has analysis model", typeof p.analysis);
  const n = await p.analysis.count();
  console.log("analyses", n);

  await p.analysis.deleteMany({ where: { referenceId: "APT-TEST0001" } });
  await p.statement.deleteMany({ where: { id: "test_stmt_1" } });

  await p.statement.create({
    data: {
      id: "test_stmt_1",
      referenceId: "APT-TEST0001",
      sourceType: "sample",
      ownerName: "Test Owner",
      accountName: "Test Owner",
      processingStatus: "COMPLETED",
    },
  });
  await p.analysis.create({
    data: {
      statementId: "test_stmt_1",
      referenceId: "APT-TEST0001",
      ownerName: "Test Owner",
      score: 61,
      analysisJson: { score: 61 },
      publicResultJson: { success: true, reference_id: "APT-TEST0001" },
    },
  });
  const found = await p.analysis.findMany({
    where: { ownerName: { contains: "Test" } },
  });
  console.log("found", found.length, found[0]?.referenceId);
} catch (e) {
  console.error("ERR", e);
  process.exitCode = 1;
} finally {
  await p.$disconnect();
}
