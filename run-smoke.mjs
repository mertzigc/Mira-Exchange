// Kor alla smoke-sviter i repot och sammanfattar.
//
//   npm test                    alla sviter
//   npm test -- landlord        bara sviter vars namn innehaller "landlord"
//   npm test -- --verbose       skriv ut full utdata fran varje svit
//
// En svit raknas som gron om den avslutas med exitkod 0. Sviterna kor
// process.exit(1) vid fel, sa exitkoden ar sanningen — inte texten.
// Hela korningen returnerar 1 om nagon svit fallerar, sa den duger i CI.

import { readdirSync } from "node:fs";
import { spawn } from "node:child_process";

const TIMEOUT_MS = 180000;

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const filters = args.filter((a) => !a.startsWith("--"));

const suites = readdirSync(".")
  .filter((f) => f.endsWith("_smoke.mjs") && f !== "run-smoke.mjs")
  .filter((f) => filters.length === 0 || filters.some((q) => f.includes(q)))
  .sort();

if (suites.length === 0) {
  console.error("Ingen svit matchade " + JSON.stringify(filters));
  process.exit(1);
}

const run = (file) =>
  new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [file], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      out += "\n[avbruten: over " + TIMEOUT_MS / 1000 + " s]";
    }, TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      const m = out.match(/pass=(\d+)\s+fail=(\d+)/);
      resolve({
        file,
        code,
        ms: Date.now() - started,
        pass: m ? Number(m[1]) : null,
        fail: m ? Number(m[2]) : null,
        out,
      });
    });
  });

const pad = (s, n) => String(s).padEnd(n);
const results = [];

console.log("\nKor " + suites.length + " sviter\n");

for (const file of suites) {
  process.stdout.write("  " + pad(file, 34));
  const r = await run(file);
  results.push(r);
  const counts = r.pass === null ? "" : "  " + r.pass + " kontroller";
  console.log(
    (r.code === 0 ? "GRON " : "ROD  ") + pad((r.ms / 1000).toFixed(1) + "s", 8) + counts
  );
  if (verbose || r.code !== 0) {
    console.log(
      r.out.split("\n").map((l) => "        " + l).join("\n").replace(/\s+$/, "") + "\n"
    );
  }
}

const red = results.filter((r) => r.code !== 0);
const checks = results.reduce((n, r) => n + (r.pass || 0), 0);

console.log("\n" + "-".repeat(58));
console.log(
  results.length - red.length + "/" + results.length + " sviter grona · " +
  checks + " kontroller · " +
  (results.reduce((n, r) => n + r.ms, 0) / 1000).toFixed(1) + "s totalt"
);
if (red.length) {
  console.log("\nRODA:\n" + red.map((r) => "  " + r.file).join("\n"));
}
console.log("-".repeat(58) + "\n");

process.exit(red.length ? 1 : 0);
