import crypto from "node:crypto";

export const PANEL_ACCESS_LEVELS = ["round_table", "keeper", "artifact_contributor", "root"];

export const PANEL_ACCESS_LABELS = {
  round_table: "Round Table",
  keeper: "Keeper",
  artifact_contributor: "Artifact Contributor",
  root: "Root"
};

export const PANEL_ACCESS_RANKS = Object.fromEntries(PANEL_ACCESS_LEVELS.map((level, index) => [level, index]));

export function normalizePanelAccessLevel(value = "") {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const compact = normalized.replace(/\s+/g, "_");
  if (PANEL_ACCESS_LEVELS.includes(compact)) return compact;
  if (normalized === "artifact" || normalized === "contributor") return "artifact_contributor";
  if (normalized === "artifact contributor" || normalized === "artifact contributors") return "artifact_contributor";
  if (normalized === "roundtable") return "round_table";
  return "";
}

export function panelAccessLabel(level = "") {
  return PANEL_ACCESS_LABELS[normalizePanelAccessLevel(level)] || "No Access";
}

export function panelAccessAtLeast(level = "", required = "root") {
  const currentRank = PANEL_ACCESS_RANKS[normalizePanelAccessLevel(level)] ?? -1;
  const requiredRank = PANEL_ACCESS_RANKS[normalizePanelAccessLevel(required)] ?? PANEL_ACCESS_RANKS.root;
  return currentRank >= requiredRank;
}

export function panelAccessRank(level = "") {
  return PANEL_ACCESS_RANKS[normalizePanelAccessLevel(level)] ?? -1;
}

export function panelAccessCanManage(actorLevel = "", targetLevel = "", nextLevel = targetLevel) {
  const actor = normalizePanelAccessLevel(actorLevel);
  if (actor === "root") return true;
  if (actor !== "artifact_contributor") return false;
  const actorRank = panelAccessRank(actor);
  return panelAccessRank(targetLevel) < actorRank && panelAccessRank(nextLevel) < actorRank;
}

export function randomPanelPassword() {
  return crypto.randomBytes(12).toString("base64url");
}

export function randomRecoveryCode() {
  return crypto.randomBytes(10).toString("base64url").match(/.{1,5}/g).join("-");
}

export function hashPanelPassword(password = "") {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPanelPassword(password = "", storedHash = "") {
  const [scheme, salt, hash] = String(storedHash || "").split(":");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const actual = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function panelAccessUsers(config = {}) {
  return config.panelAccess?.users || {};
}

export function panelAccessUser(config = {}, userId = "") {
  const entry = panelAccessUsers(config)[String(userId || "")];
  if (!entry || entry.revokedAt) return null;
  if (entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now()) return null;
  return {
    userId: String(userId),
    username: String(entry.username || ""),
    level: normalizePanelAccessLevel(entry.level),
    grantedBy: String(entry.grantedBy || ""),
    grantedAt: String(entry.grantedAt || ""),
    expiresAt: String(entry.expiresAt || ""),
    lastLoginAt: String(entry.lastLoginAt || "")
  };
}

export function canGrantPanelAccess(config = {}, memberOrUserId) {
  const userId = typeof memberOrUserId === "string" ? memberOrUserId : memberOrUserId?.id;
  const user = panelAccessUser(config, userId);
  if (!user) return false;
  const allowed = config.panelAccess?.grantAccessLevels || ["root"];
  return allowed.map(normalizePanelAccessLevel).includes(user.level);
}
