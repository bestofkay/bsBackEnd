/**
 * Production entry for Railway / Docker.
 * Applies Prisma migrations, then starts the API.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: process.env,
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

function resolveDatabaseUrl() {
  const direct = (
    process.env.DATABASE_URL ||
    process.env.MYSQL_URL ||
    process.env.MYSQLDATABASE_URL ||
    ""
  ).trim();
  if (direct) return direct.replace(/^mysql2:\/\//i, "mysql://");
  const host = process.env.MYSQLHOST || process.env.MYSQL_HOST;
  const user = process.env.MYSQLUSER || process.env.MYSQL_USER;
  const password = process.env.MYSQLPASSWORD || process.env.MYSQL_PASSWORD || "";
  const database = process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE;
  const port = process.env.MYSQLPORT || process.env.MYSQL_PORT || "3306";
  if (host && user && database) {
    const auth = password
      ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}`
      : encodeURIComponent(user);
    return `mysql://${auth}@${host}:${port}/${database}`;
  }
  return "";
}

async function main() {
  const databaseUrl = resolveDatabaseUrl();
  if (databaseUrl && !process.env.DATABASE_URL) {
    process.env.DATABASE_URL = databaseUrl;
  }
  if (databaseUrl) {
    console.log("[start] applying prisma migrations…");
    await run("npx", ["prisma", "migrate", "deploy"]);
  } else {
    console.warn(
      "[start] DATABASE_URL unset — skipping migrations (file catalog fallback)",
    );
  }

  const entry = path.join(root, "dist", "index.js");
  if (!existsSync(entry)) {
    throw new Error(`Missing build output: ${entry}`);
  }
  console.log("[start] launching API…");
  await run("node", [entry]);
}

main().catch((err) => {
  console.error("[start] fatal:", err);
  process.exit(1);
});
