import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const CLAIM_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function claimStorePath() {
  return path.join(process.cwd(), "data", "dash-claims.json");
}

function readClaimStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(claimStorePath(), "utf8"));
    return {
      claims: { ...(parsed.claims || {}) }
    };
  } catch {
    return { claims: {} };
  }
}

function writeClaimStore(store) {
  const filePath = claimStorePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(`${filePath}.tmp`, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  fs.renameSync(`${filePath}.tmp`, filePath);
}

function normalizeCode(code = "") {
  return String(code || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 16);
}

function makeClaimCode(existingClaims = {}) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = `CK${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    if (!existingClaims[code]) return code;
  }

  return `CK${Date.now().toString(36).toUpperCase()}`;
}

function pruneClaims(store, now = Date.now()) {
  for (const [code, claim] of Object.entries(store.claims)) {
    const createdAt = Date.parse(claim.createdAt || "");
    if (claim.claimedAt || !Number.isFinite(createdAt) || now - createdAt > CLAIM_MAX_AGE_MS) {
      delete store.claims[code];
    }
  }
}

export function createDashClaim({ name = "", score = 0, bread = 0 } = {}) {
  const amount = Math.min(Math.max(Math.floor(Number(bread) || 0), 0), 100000);
  if (amount <= 0) return null;

  const store = readClaimStore();
  pruneClaims(store);

  const code = makeClaimCode(store.claims);
  store.claims[code] = {
    name: String(name || "").slice(0, 24),
    score: Math.min(Math.max(Math.floor(Number(score) || 0), 0), 100000),
    bread: amount,
    createdAt: new Date().toISOString()
  };

  writeClaimStore(store);
  return { code, bread: amount };
}

export function redeemDashClaim({ code, guildId, userId } = {}) {
  const normalizedCode = normalizeCode(code);
  if (!normalizedCode) return { ok: false, error: "Send a claim code, like `!claimdash CK123ABC`." };

  const store = readClaimStore();
  pruneClaims(store);

  const claim = store.claims[normalizedCode];
  if (!claim) return { ok: false, error: "That Dash claim code is invalid or expired." };

  delete store.claims[normalizedCode];
  writeClaimStore(store);

  return {
    ok: true,
    code: normalizedCode,
    bread: Math.max(Math.floor(Number(claim.bread) || 0), 0),
    score: Math.max(Math.floor(Number(claim.score) || 0), 0),
    name: String(claim.name || "")
  };
}
