// index.js (CommonJS)
const express = require("express");
const crypto = require("crypto");

const app = express();
app.use(express.json());

// -------- Helpers --------
const base64url = (buf) =>
  Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest();
}

// HMAC-signerat state utan serverstore
function signState(payloadObj) {
  const secret = process.env.MIRAGPT_API_KEY || "dev-secret";
  const header = base64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64url(Buffer.from(JSON.stringify(payloadObj)));
  const data = `${header}.${payload}`;
  const sig = crypto.createHmac("sha256", secret).update(data).digest("base64");
  const sigB64Url = sig.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${data}.${sigB64Url}`;
}

function verifyState(token) {
  const secret = process.env.MIRAGPT_API_KEY || "dev-secret";
  const parts = String(token).split(".");
  if (parts.length !== 3) throw new Error("bad state format");
  const [headerB64, payloadB64, sigIncoming] = parts;
  const data = `${headerB64}.${payloadB64}`;
  const sig = crypto.createHmac("sha256", secret).update(data).digest("base64");
  const sigExpected = sig.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (sigExpected !== sigIncoming) throw new Error("bad state signature");
  const json = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8"));
  return json;
}

// -------- Security middleware (protect everything except public paths) --------
const PUBLIC_PATHS = ["/health", "/ms/auth", "/ms/callback"];
app.use((req, res, next) =>
