// Smoke: sms.js — 46elks-gateway, segmenträkning och E.164.
//   node sms_smoke.mjs
import { makeSms, smsSegments, toE164 } from "./sms.js";

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log("  ✗ " + n); } };

// ── Segmenträkning (= kostnad) ──────────────────────────────────────────────
// ⚠️ Den skarpa besöksmallen MÅSTE rymmas i ett segment.
const MALL = "Din besökare Anna Lindqvist väntar i receptionen, Hötorget 3. Hälsningar Carotte";
const m = smsSegments(MALL);
ok("besöksmallen ryms i ETT segment", m.segments === 1 && m.encoding === "gsm7");
ok("svenska å/ä/ö är gratis i GSM-7 (ingen uppgradering till ucs2)", smsSegments("Hötorget är påväg åt öst").encoding === "gsm7");
ok("160 tecken = 1 segment", smsSegments("a".repeat(160)).segments === 1);
ok("161 tecken = 2 segment (153/st)", smsSegments("a".repeat(161)).segments === 2);
// ⚠️ KÄRNAN: en enda emoji dubblar kostnaden.
const emo = smsSegments("Din besökare väntar 👋");
ok("EN emoji → ucs2 (halverad kapacitet, dubbel kostnad)", emo.encoding === "ucs2");
ok("kort emoji-text blir ändå 1 segment men i ucs2", emo.segments === 1);
ok("70 tecken ucs2 = 1 segment", smsSegments("👋" + "a".repeat(68)).segments === 1);
ok("tom text = 0 segment", smsSegments("").segments === 0);
ok("GSM-7-escape (€) kostar två positioner", smsSegments("€".repeat(80)).segments === 1 && smsSegments("€".repeat(81)).segments === 2);

// ── E.164 ───────────────────────────────────────────────────────────────────
// ⚠️ Coworker.Telefon är ett NUMBER-fält → inledande nolla finns inte kvar.
ok("number-fältets 9 siffror → +46…", toE164(701785977) === "+46701785977");
ok("0701785977 → +46701785977", toE164("0701785977") === "+46701785977");
ok("formaterat 070-178 59 77 → +46701785977", toE164("070-178 59 77") === "+46701785977");
ok("redan +46 → oförändrat", toE164("+46701785977") === "+46701785977");
ok("0046-prefix → +46", toE164("0046701785977") === "+46701785977");
ok("46-prefix utan plus → +46", toE164("46701785977") === "+46701785977");
ok("skräp → null (skickar hellre inget än till fel nummer)", toE164("inte-ett-nummer") === null);
ok("tomt → null", toE164("") === null && toE164(null) === null);
ok("för kort → null", toE164("123") === null);

// ── send() ──────────────────────────────────────────────────────────────────
const calls = [];
const fakeFetch = async (url, opts) => {
  calls.push({ url, opts });
  return { ok: true, status: 200, text: async () => JSON.stringify({ id: "s123", status: "created" }) };
};
const S = makeSms({ username: "u", password: "p", from: "Carotte", fetchImpl: fakeFetch });
const r = await S.send({ to: 701785977, text: MALL });
ok("send ok → id + segment", r.ok === true && r.id === "s123" && r.segments === 1);
ok("send: numret normaliserat till E.164", r.to === "+46701785977");
ok("send: postar till 46elks", calls[0].url === "https://api.46elks.com/a1/sms");
ok("send: basic auth-header", String(calls[0].opts.headers.Authorization).startsWith("Basic "));
const sentBody = new URLSearchParams(calls[0].opts.body);
ok("send: avsändare + mottagare + text i body", sentBody.get("from") === "Carotte" && sentBody.get("to") === "+46701785977" && sentBody.get("message") === MALL);

// ── Felfall: får ALDRIG kasta ───────────────────────────────────────────────
const bad = await S.send({ to: "skräp", text: MALL });
ok("ogiltigt nummer → ok:false, ingen krasch", bad.ok === false && bad.error === "invalid_number");
const empty = await S.send({ to: 701785977, text: "  " });
ok("tom text → ok:false", empty.ok === false && empty.error === "empty_text");
const noCfg = makeSms({ username: "", password: "", fetchImpl: fakeFetch });
ok("okonfigurerad → 503, aldrig tyst 'skickat'", (await noCfg.send({ to: 701785977, text: "x" })).status === 503 && noCfg.configured === false);
const S500 = makeSms({ username: "u", password: "p", fetchImpl: async () => ({ ok: false, status: 500, text: async () => "upstream boom" }) });
const r500 = await S500.send({ to: 701785977, text: MALL });
ok("gateway 500 → ok:false med status, ingen krasch", r500.ok === false && r500.status === 500 && r500.error === "sms_failed_500");
const Sthrow = makeSms({ username: "u", password: "p", fetchImpl: async () => { throw new Error("ECONNRESET"); } });
const rthrow = await Sthrow.send({ to: 701785977, text: MALL });
ok("nätverksfel → ok:false, KASTAR INTE (besöket ska loggas ändå)", rthrow.ok === false && rthrow.error === "sms_network_error");

// Avsändarnamn kapas till 11 tecken (operatörskrav)
const Slong = makeSms({ username: "u", password: "p", from: "CarotteGroupAB", fetchImpl: fakeFetch });
ok("avsändare kapas till 11 tecken", Slong.from === "CarotteGrou");

console.log(fail ? `❌ FEL  pass=${pass} fail=${fail}` : `✅ ALLA GRÖNA  pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
