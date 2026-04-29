import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { PermissionsBitField } from "discord.js";
import express from "express";
import session from "express-session";
import { serializeGuild } from "./bot.js";
import {
  addAuditLog,
  artifactOfTheDay,
  artifactDirectoryText,
  communitySnapshot,
  deleteAuditLog,
  derivedAchievements,
  parseArtifactDirectory,
  profileFor,
  publicMemberCards,
  topCommands,
  updateProfile,
} from "./communityFeatures.js";
import { CHIPKITTLE_LORE } from "./chipkittleLore.js";
import { createDashClaim, redeemDashClaim } from "./dashClaims.js";
import { buildPrettyEmbed } from "./embedOutput.js";
import {
  PANEL_ACCESS_LEVELS,
  hashPanelPassword,
  normalizePanelAccessLevel,
  panelAccessAtLeast,
  panelAccessCanManage,
  panelAccessLabel,
  panelAccessRank,
  panelAccessUser,
  panelAccessUsers,
  randomRecoveryCode,
  randomPanelPassword,
  verifyPanelPassword
} from "./panelAccess.js";
import {
  createEightBallRoom,
  getEightBallRoomState,
  joinEightBallRoom,
  resetEightBallRoom,
  shootEightBall
} from "./eightBallRooms.js";

const execFileAsync = promisify(execFile);
const UPDATE_STALE_MS = 10 * 60 * 1000;
const ACTIVE_UPDATE_STATUSES = new Set(["running", "updating", "restarting"]);
const MOD_MEMBER_PAGE_SIZE = 20;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 12;
const OAUTH_STATE_BYTES = 18;
const PANEL_ROLE_TEMPLATE_LEVELS = {
  moderator: "round_table",
  senior_moderator: "keeper",
  contributor: "artifact_contributor",
  administrator: "root"
};
const PANEL_SECTION_MIN_LEVEL = {
  dashboard: "round_table",
  audit: "round_table",
  commands: "round_table",
  moderation: "round_table",
  suggestions: "artifact_contributor",
  applications: "keeper",
  permissions: "artifact_contributor",
  access: "artifact_contributor",
  backups: "root",
  general: "root",
  members: "root",
  public: "root",
  ai: "root",
  economy: "root",
  games: "root",
  community: "root",
  server: "root"
};
const SETTINGS_SECTIONS = [
  { id: "dashboard", label: "Dashboard", description: "At-a-glance stats, audit activity, and quick links." },
  { id: "audit", label: "Audit Log", description: "Searchable panel and moderation history for every access tier." },
  { id: "general", label: "General", description: "Slash commands, legacy prefix, welcome, and autorole." },
  { id: "members", label: "Members", description: "Edit the public member directory and review community profiles." },
  { id: "public", label: "Public Site", description: "Quick links, exports, and live public-facing content summaries." },
  { id: "moderation", label: "Moderation", description: "Automod rules and moderation logging." },
  { id: "suggestions", label: "Suggestions", description: "Review public and Discord suggestions." },
  { id: "ai", label: "AI", description: "Chipkittle AI channels, model, cooldowns, and personality." },
  { id: "economy", label: "Economy", description: "Bread payouts, cooldowns, interest, and upgrade pricing." },
  { id: "applications", label: "Applications", description: "DM questions, review threads, roles, and cooldowns." },
  { id: "games", label: "Games", description: "Leaderboard moderation, claim limits, and public game tools." },
  { id: "community", label: "Community", description: "Artifacts, rituals, public directory extras, and archive data." },
  { id: "permissions", label: "Permissions", description: "Command role access overrides." },
  { id: "access", label: "Panel Access", description: "Revoke panel users and review access tiers." },
  { id: "backups", label: "Backups", description: "Restore exported configuration, moderation, application, or public site data." },
  { id: "commands", label: "Commands", description: "Browse the command catalog." },
  { id: "server", label: "Server", description: "Pull GitHub changes and restart the VPS bot." }
];

const SETTINGS_NAV_GROUPS = [
  { label: "Daily Ops", description: "What staff touches most", sections: ["dashboard", "audit", "moderation", "applications", "suggestions"] },
  { label: "Bot Setup", description: "Bot behavior and command access", sections: ["general", "ai", "commands", "permissions"] },
  { label: "Site & Games", description: "Public pages, members, and game controls", sections: ["public", "members", "community", "games"] },
  { label: "Root Tools", description: "Economy, access, backups, and runtime", sections: ["economy", "access", "backups", "server"] }
];

const SETTINGS_NAV_MARKS = {
  dashboard: "OV",
  audit: "AU",
  moderation: "MO",
  applications: "AP",
  suggestions: "SU",
  general: "GE",
  ai: "AI",
  commands: "CM",
  permissions: "PE",
  public: "PU",
  members: "ME",
  community: "CK",
  games: "GA",
  economy: "BR",
  access: "AC",
  backups: "BA",
  server: "RT"
};

const NON_FORM_SECTIONS = new Set(["dashboard", "audit", "public", "commands", "server", "backups", "suggestions"]);

const DEFAULT_PUBLIC_GAME_SETTINGS = {
  blockedLeaderboardWords: [],
  maxLeaderboardEntriesPerGame: 10,
  maxLeaderboardScore: 100000,
  maxLeaderboardBread: 100000,
  maxClaimBreadPerRun: 100000,
  recordAlertChannelId: ""
};
const SUGGESTION_STATUSES = ["submitted", "under_consideration", "accepted", "denied", "implemented"];
const SUGGESTION_STATUS_LABELS = {
  submitted: "Submitted",
  under_consideration: "Under consideration",
  accepted: "Accepted",
  denied: "Denied",
  implemented: "Implemented"
};
const PUBLIC_SUGGESTION_COOLDOWN_MS = 60 * 1000;
const PUBLIC_SUGGESTION_CAPTCHA_TTL_MS = 10 * 60 * 1000;

const DEFAULT_ECONOMY_SETTINGS = {
  dailyBread: 300,
  maxBreadBet: 10000,
  gamblingCooldownSeconds: 5,
  robCooldownMinutes: 180,
  casinoRobberyCooldownMinutes: 480,
  bankInterestCooldownHours: 20,
  bankInterestRatePercent: 1.5,
  maxBankInterest: 1000,
  upgradeCosts: {}
};

const DEFAULT_STARTING_BREAD = 500;
const PANEL_ECONOMY_UPGRADES = [
  { id: "daily-oven", name: "Daily Oven", maxLevel: 5, baseCost: 1500, costGrowth: 1.75, description: "Adds bread to every daily claim." },
  { id: "streak-vault", name: "Streak Vault", maxLevel: 4, baseCost: 2000, costGrowth: 1.8, description: "Raises the daily streak bonus cap." },
  { id: "interest-altar", name: "Interest Altar", maxLevel: 5, baseCost: 3000, costGrowth: 1.9, description: "Improves bank interest payouts." },
  { id: "interest-clock", name: "Interest Clock", maxLevel: 5, baseCost: 2800, costGrowth: 1.75, description: "Shortens bank interest cooldowns." },
  { id: "work-tools", name: "Work Tools", maxLevel: 5, baseCost: 1250, costGrowth: 1.65, description: "Adds bread to work payouts." },
  { id: "casino-disguise", name: "Casino Disguise", maxLevel: 4, baseCost: 4000, costGrowth: 2, description: "Improves casino robbery outcomes." },
  { id: "bread-shield", name: "Bread Shield", maxLevel: 4, baseCost: 2500, costGrowth: 1.8, description: "Protects more wallet bread from robberies." }
];

const BUILT_IN_BLOCKED_LEADERBOARD_TERMS = [
  "fuck",
  "shit",
  "bitch",
  "asshole",
  "bastard",
  "cunt",
  "dick",
  "pussy",
  "whore",
  "slut",
  "motherfucker",
  "nigger",
  "faggot",
  "retard",
  "chink",
  "spic",
  "kike",
  "tranny"
];
const STRICT_PROFILE_BLOCKED_TERMS = [
  ...BUILT_IN_BLOCKED_LEADERBOARD_TERMS,
  "heil",
  "nazi",
  "hitler",
  "kkk",
  "rape",
  "rapist",
  "porn",
  "onlyfans",
  "suicide",
  "killmyself",
  "killyourself",
  "kys",
  "dox",
  "doxx",
  "doxxed"
];

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isChecked(value) {
  return value ? "checked" : "";
}

function selected(currentValue, optionValue) {
  return currentValue === optionValue ? "selected" : "";
}

function datetimeLocalValue(value = "") {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  return new Date(time).toISOString().slice(0, 16);
}

function normalizeSettingsSection(section) {
  return SETTINGS_SECTIONS.some((item) => item.id === section) ? section : SETTINGS_SECTIONS[0].id;
}

function activeSectionMeta(activeSection) {
  return SETTINGS_SECTIONS.find((section) => section.id === activeSection) || SETTINGS_SECTIONS[0];
}

function sectionClass(sectionId, activeSection) {
  return `settings-section${sectionId === activeSection ? " is-active" : ""}`;
}

function safeEquals(a, b) {
  const first = Buffer.from(a);
  const second = Buffer.from(b);
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}

function flashFromQuery(query = {}) {
  if (query.saved) return "Configuration saved.";
  if (query.modAction === "success") return "Moderation action completed.";
  if (query.modAction === "missing-target") return "That member could not be found.";
  if (query.modAction === "bad-duration") return "Timeout duration must look like 10m, 2h, or 1d.";
  if (query.modAction === "missing-permission") return "The bot is missing the required Discord permission for that action.";
  if (query.modAction === "hierarchy") return "Discord blocked that action because of role hierarchy.";
  if (query.modAction === "actor-hierarchy") return "Panel moderation blocked: you cannot punish members with an equal or higher Discord role.";
  if (query.modAction === "failed") return "Moderation action failed. Check the bot logs for details.";
  if (query.update === "started") return "GitHub pull started.";
  if (query.update === "restart-started") return "Bot restart started.";
  if (query.update === "busy") return "An update is already running.";
  if (query.update === "failed") return "Could not start the update job.";
  if (query.update === "restart-failed") return "Could not start the restart job.";
  return "";
}

function readUpdateStatus() {
  const statusPath = path.join(process.cwd(), "data", "update-status.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    const updatedTime = Date.parse(parsed.updatedAt || "");
    const status = String(parsed.status || "unknown");
    const stale = ACTIVE_UPDATE_STATUSES.has(status) && (!Number.isFinite(updatedTime) || Date.now() - updatedTime > UPDATE_STALE_MS);
    return {
      status,
      updatedAt: String(parsed.updatedAt || ""),
      stale,
      error: String(parsed.error || ""),
      log: String(parsed.log || "").slice(-3000)
    };
  } catch {
    return null;
  }
}

async function recentCommits(limit = 25) {
  const pretty = "%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1e";
  const { stdout } = await execFileAsync(
    "git",
    ["log", `-${limit}`, `--pretty=format:${pretty}`, "--date=short"],
    {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024
    }
  );

  return stdout
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [hash, shortHash, author, date, subject] = entry.split("\x1f");
      return { hash, shortHash, author, date, subject };
    })
    .filter((commit) => !isHiddenCommitMessage(commit.subject));
}

function displayCommitAuthor(author) {
  const name = String(author || "").trim();
  return name.toLowerCase() === "elijahenglish" ? "English" : name || "Unknown";
}

function commitUrl(hash) {
  return `https://github.com/15inb/chipkittle/commit/${encodeURIComponent(hash)}`;
}

function isHiddenCommitMessage(message = "") {
  const normalized = String(message || "").toLowerCase();
  return normalized.includes("silent") || normalized.startsWith("merge branch 'main'");
}

function updateControls(guildId = "") {
  const status = readUpdateStatus();
  return `
    <section class="panel-section update-panel server-update-card">
      <div class="section-heading">
        <h2>Server Update</h2>
        <p>Pull GitHub changes or restart the PM2 bot process. Run pull first when deploying new code.</p>
      </div>
      <div class="update-actions">
        <form method="post" action="/admin/update" class="inline-form">
          <button type="submit">Pull GitHub</button>
        </form>
        <form method="post" action="/admin/restart" class="inline-form">
          <button type="submit" class="secondary-button">Restart bot</button>
        </form>
        <a class="primary-link secondary-link" href="/admin/export/config">Export config</a>
        <a class="primary-link secondary-link" href="/admin/export/community">Export community</a>
        <a class="primary-link secondary-link" href="/admin/export/moderation">Export moderation</a>
        <a class="primary-link secondary-link" href="/admin/export/applications">Export applications</a>
        <a class="primary-link secondary-link" href="/admin/export/public">Export public site</a>
        <a class="primary-link secondary-link" href="/admin/export/full">Full backup snapshot</a>
      </div>
      ${
        status
          ? `<div class="update-status">
              <strong>Status: ${escapeHtml(status.stale ? `${status.status} (stale)` : status.status)}</strong>
              ${status.updatedAt ? `<small>Updated ${escapeHtml(status.updatedAt)}</small>` : ""}
              ${status.error ? `<p class="form-error">${escapeHtml(status.error)}</p>` : ""}
              ${status.log ? `<pre>${escapeHtml(status.log)}</pre>` : ""}
            </div>`
          : '<p class="muted">No panel updates have been run yet.</p>'
      }
    </section>
  `;
}

function parsePanelDuration(input = "") {
  const match = String(input || "").trim().match(/^(\d+)(s|m|h|d|w)$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const day = 86_400_000;
  const multipliers = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: day,
    w: 7 * day
  };
  return amount > 0 ? amount * multipliers[unit] : null;
}

function formatPanelDuration(ms = 0) {
  const seconds = Math.floor(Number(ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

function serializeModerationMember(member, config = {}) {
  return {
    id: member.id,
    tag: member.user?.tag || member.user?.username || member.id,
    username: member.user?.username || member.id,
    displayName: member.displayName || member.user?.username || member.id,
    avatarUrl: member.user?.displayAvatarURL?.({ size: 64 }) || "",
    bot: Boolean(member.user?.bot),
    joinedAt: member.joinedAt?.toISOString?.() || "",
    highestRole: member.roles?.highest?.name || "",
    warningCount: (config.moderation?.warnings?.[member.id] || []).length,
    timedOutUntil: member.communicationDisabledUntil?.toISOString?.() || ""
  };
}

async function moderationMemberPage(discordGuild, config = {}, query = {}) {
  const search = String(query.search || "").trim().slice(0, 80);
  const after = String(query.after || "").trim();
  let members = [];
  let fetchError = "";
  let nextAfter = "";

  try {
    if (search) {
      if (/^\d{16,22}$/.test(search)) {
        const member = await discordGuild.members.fetch(search).catch(() => null);
        members = member ? [member] : [];
      } else {
        const results = await discordGuild.members.fetch({ query: search, limit: MOD_MEMBER_PAGE_SIZE }).catch(() => null);
        members = results ? [...results.values()] : [];
      }
    } else {
      const results = await discordGuild.members.list({
        after: after || undefined,
        limit: MOD_MEMBER_PAGE_SIZE,
        cache: true
      });
      members = [...results.values()];
      nextAfter = members.length === MOD_MEMBER_PAGE_SIZE ? members[members.length - 1].id : "";
    }
  } catch (error) {
    fetchError = "Could not load members from Discord. Make sure the bot has access to member data.";
    members = [...discordGuild.members.cache.values()].slice(0, MOD_MEMBER_PAGE_SIZE);
    console.error("Could not load moderation member page:", error);
  }

  members.sort((a, b) => String(a.user?.username || "").localeCompare(String(b.user?.username || "")));

  return {
    search,
    after,
    error: fetchError,
    nextAfter: !search ? nextAfter : "",
    members: members.map((member) => serializeModerationMember(member, config))
  };
}

async function warningMemberLabels(discordGuild, config = {}) {
  const userIds = Object.entries(config.moderation?.warnings || {})
    .filter(([, entries]) => Array.isArray(entries) && entries.length)
    .map(([userId]) => userId)
    .slice(0, 80);
  const labels = {};
  await Promise.all(userIds.map(async (userId) => {
    const member = await discordGuild.members.fetch(userId).catch(() => null);
    if (member) {
      labels[userId] = member.user?.tag || member.displayName || userId;
    }
  }));
  return labels;
}

async function sendPanelModerationLog(discordGuild, config = {}, content = "") {
  const channelId = config.moderation?.logChannelId;
  if (!channelId) return;

  const channel =
    discordGuild.channels.cache.get(channelId) ||
    (await discordGuild.channels.fetch(channelId).catch(() => null));
  if (!channel?.isTextBased?.()) return;

  await channel.send({
    embeds: [
      buildPrettyEmbed({
        title: "Moderation Log: Panel",
        description: String(content || "").slice(0, 3900),
        color: 0xef4444,
        footer: `Panel action in ${discordGuild.name}`
      })
    ]
  }).catch(() => {});
}

async function sendPanelPunishmentNotice(member, { guildName, action, reason, durationLabel = "", moderatorTag = "" }) {
  const lines = [
    `You have been ${action} in ${guildName}.`,
    durationLabel ? `Duration: ${durationLabel}` : "",
    `Reason: ${reason || "No reason provided."}`,
    moderatorTag ? `Moderator: ${moderatorTag}` : ""
  ].filter(Boolean);

  return member
    .send({
      content: lines.join("\n"),
      allowedMentions: { parse: [] }
    })
    .then(() => true)
    .catch(() => false);
}

function moderationRedirect(discordGuild, request, status = "success") {
  const params = new URLSearchParams({ section: "moderation", modAction: status });
  const search = String(request.body?.modSearch || request.query?.modSearch || "").trim();
  const after = String(request.body?.modAfter || request.query?.modAfter || "").trim();
  if (search) params.set("modSearch", search);
  if (after && !search) params.set("modAfter", after);
  return `/guilds/${discordGuild.id}?${params.toString()}`;
}

function requireBotPermission(discordGuild, permission, status) {
  const botMember = discordGuild.members.me;
  if (!botMember?.permissions?.has(permission)) {
    const error = new Error("Missing bot permission");
    error.panelStatus = status || "missing-permission";
    throw error;
  }
}

function assertModerationHierarchy(member, capability) {
  if (!member?.[capability]) {
    const error = new Error("Blocked by Discord role hierarchy");
    error.panelStatus = "hierarchy";
    throw error;
  }
}

async function assertPanelActorCanModerate(discordGuild, panelUser, targetMember) {
  if (!panelUser?.userId || panelUser.legacy || panelUser.userId === "legacy-root") {
    const error = new Error("Panel user is not linked to a Discord member");
    error.panelStatus = "actor-hierarchy";
    throw error;
  }

  if (panelUser.userId === targetMember.id) {
    const error = new Error("Panel user cannot moderate themselves");
    error.panelStatus = "actor-hierarchy";
    throw error;
  }

  if (targetMember.id === discordGuild.ownerId) {
    const error = new Error("Panel user cannot moderate the server owner");
    error.panelStatus = "actor-hierarchy";
    throw error;
  }

  if (panelUser.userId === discordGuild.ownerId) return;

  const actorMember = await discordGuild.members.fetch(panelUser.userId).catch(() => null);
  if (!actorMember || actorMember.roles.highest.comparePositionTo(targetMember.roles.highest) <= 0) {
    const error = new Error("Panel user role is not above target role");
    error.panelStatus = "actor-hierarchy";
    throw error;
  }
}

function displayRoleName(guild, roleId) {
  if (!roleId) return "Not set";
  return guild.roles.find((role) => role.id === roleId)?.name || roleId;
}

function displayChannelName(guild, channelId) {
  if (!channelId) return "Not set";
  const channel = guild.channels.find((item) => item.id === channelId);
  return channel ? `#${channel.name}` : channelId;
}

function warningReasonText(warning) {
  if (typeof warning === "string") return warning;
  if (!warning || typeof warning !== "object") return "Warning recorded";
  const reason = String(warning.reason || warning.message || warning.note || "Warning recorded");
  const moderator = warning.moderatorTag || warning.moderatorId;
  const createdAt = warning.createdAt ? ` on ${warning.createdAt}` : "";
  return `${reason}${moderator ? ` by ${moderator}` : ""}${createdAt}`;
}

function warningUserLabel(config = {}, userId = "", labels = {}) {
  const fromLabels = labels[userId];
  if (fromLabels) return fromLabels;
  const auditMatch = (Array.isArray(config.community?.auditLog) ? config.community.auditLog : [])
    .find((entry) => String(entry.targetId || "") === String(userId) && entry.targetTag);
  if (auditMatch?.targetTag) return auditMatch.targetTag;
  const profile = config.community?.profiles?.[userId];
  if (profile?.displayName) return profile.displayName;
  return "Unknown member";
}

function punishmentHistoryFor(config = {}, userId = "") {
  const warnings = Array.isArray(config.moderation?.warnings?.[userId]) ? config.moderation.warnings[userId] : [];
  const moderationLogs = (Array.isArray(config.community?.auditLog) ? config.community.auditLog : [])
    .filter((entry) => String(entry.targetId || "") === String(userId))
    .filter((entry) => String(entry.type || "") === "moderation" || ["warn", "timeout", "untimeout", "kick", "ban"].includes(String(entry.action || "")))
    .slice(0, 30);
  return { warnings, moderationLogs };
}

function moderationCenter(config = {}) {
  const warnings = Object.entries(config.moderation?.warnings || {});
  const warningTotals = warnings.reduce((sum, [, entries]) => sum + (Array.isArray(entries) ? entries.length : 0), 0);
  const warnedMembers = warnings.filter(([, entries]) => Array.isArray(entries) && entries.length).length;
  const punishments = (config.community?.auditLog || []).filter((entry) => String(entry.type || "") === "moderation").length;
  const warningHotlist = warnings
    .map(([userId, entries]) => ({
      userId,
      count: Array.isArray(entries) ? entries.length : 0,
      latest: Array.isArray(entries) && entries.length ? warningReasonText(entries[entries.length - 1]) : ""
    }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  return `
    <section class="panel-section">
      <div class="section-heading">
        <h2>Moderation Center</h2>
        <p>Quick visibility into warnings, punishments, and who is generating the most staff action.</p>
      </div>
      <div class="stats-grid">
        <article class="stat-card"><strong>${escapeHtml(punishments)}</strong><span>Punishments</span></article>
        <article class="stat-card"><strong>${escapeHtml(warningTotals)}</strong><span>Total Warnings</span></article>
        <article class="stat-card"><strong>${escapeHtml(warnedMembers)}</strong><span>Warned Members</span></article>
      </div>
      <div class="dashboard-grid">
        <div class="sub-panel">
          <div class="section-heading">
            <h2>Recent Punishments</h2>
            <p>Newest moderation actions recorded by the panel and bot.</p>
          </div>
          ${
            punishments
              ? `<div class="stack-list">${(config.community?.auditLog || []).filter((entry) => String(entry.type || "") === "moderation").slice(0, 8).map((entry) => `<div class="audit-row"><strong>${escapeHtml(entry.label || entry.action || "Moderation action")}</strong><small>${escapeHtml(entry.targetTag || entry.targetId || "Unknown target")} &middot; ${escapeHtml(entry.createdAt || "")}</small><p>${escapeHtml(entry.details || "No details recorded.")}</p></div>`).join("")}</div>`
              : '<p class="muted">No moderation actions recorded yet.</p>'
          }
        </div>
        <div class="sub-panel">
          <div class="section-heading">
            <h2>Warning Hotlist</h2>
            <p>Members with the largest warning totals in the current config.</p>
          </div>
          ${
            warningHotlist.length
              ? `<div class="stack-list">${warningHotlist.map((entry) => `<div class="list-row"><div><strong>${escapeHtml(entry.userId)}</strong><span>${escapeHtml(entry.latest || "Warning recorded")}</span></div><strong>${escapeHtml(entry.count)} warn${entry.count === 1 ? "" : "s"}</strong></div>`).join("")}</div>`
              : '<p class="muted">No warnings recorded yet.</p>'
          }
        </div>
      </div>
    </section>
  `;
}

function moderationMemberBrowser(guildId, memberPage = { members: [] }, config = {}, warningMemberLabels = {}, panelUser = null) {
  memberPage = memberPage || { members: [] };
  const members = Array.isArray(memberPage.members) ? memberPage.members : [];
  const search = memberPage.search || "";
  const after = memberPage.after || "";
  const nextAfter = memberPage.nextAfter || "";
  const preserveSearch = escapeHtml(search);
  return `
    <section class="panel-section moderation-browser">
      <div class="section-heading">
        <h2>Member Actions</h2>
        <p>Search or browse members, then run moderation actions directly from the panel.</p>
      </div>
      <form method="get" action="/guilds/${guildId}" class="moderation-search">
        <input type="hidden" name="section" value="moderation">
        <label>
          Search members
          <input name="modSearch" value="${preserveSearch}" placeholder="username, display name, or user ID">
        </label>
        <button type="submit">Search</button>
        <a class="primary-link secondary-link" href="/guilds/${guildId}?section=moderation">Reset</a>
      </form>
      ${memberPage.error ? `<p class="form-error">${escapeHtml(memberPage.error)}</p>` : ""}
      <div class="member-action-list">
        ${
          members.length
            ? members.map((member) => moderationMemberRow(guildId, member, search, after, config, warningMemberLabels, panelUser)).join("")
            : '<p class="muted">No members matched that search.</p>'
        }
      </div>
      <div class="pagination-actions">
        <a class="primary-link secondary-link" href="/guilds/${guildId}?section=moderation">First page</a>
        ${
          nextAfter
            ? `<a class="primary-link secondary-link" href="/guilds/${guildId}?section=moderation&modAfter=${encodeURIComponent(nextAfter)}">Next page</a>`
            : ""
        }
      </div>
    </section>
  `;
}

function moderationMemberRow(guildId, member, search = "", after = "", config = {}, warningMemberLabels = {}, panelUser = null) {
  const userLabel = `${member.displayName} (${member.tag})`;
  const timeoutLabel = member.timedOutUntil ? `<span class="case-status is-open">Timed out</span>` : "";
  const canAdvanced = panelAccessAtLeast(panelUser?.level || "root", "keeper");
  return `
    <article class="member-action-row">
      <div class="member-action-main">
        <span class="member-action-avatar">${member.avatarUrl ? `<img src="${escapeHtml(member.avatarUrl)}" alt="">` : escapeHtml(member.displayName[0] || "?")}</span>
        <div>
          <strong>${escapeHtml(member.displayName)} ${member.bot ? '<small class="member-bot-label">Bot</small>' : ""}</strong>
          <small>${escapeHtml(member.tag)} &middot; ${escapeHtml(member.id)}</small>
          <div class="mini-stats">
            <span>${escapeHtml(member.warningCount)} warnings</span>
            ${member.highestRole ? `<span>${escapeHtml(member.highestRole)}</span>` : ""}
            ${timeoutLabel}
          </div>
        </div>
      </div>
      <div class="member-action-controls">
        <div class="member-action-buttons">
          <a class="primary-link secondary-link" href="#punishments-member-${escapeHtml(member.id)}">View Punishments</a>
        </div>
        <details class="member-action-details">
          <summary>Moderate</summary>
          <form method="post" action="/guilds/${guildId}/moderation/action" class="member-action-form" onsubmit="return confirm('Run this moderation action?');">
            <input type="hidden" name="targetUserId" value="${escapeHtml(member.id)}">
            <input type="hidden" name="modSearch" value="${escapeHtml(search)}">
            <input type="hidden" name="modAfter" value="${escapeHtml(after)}">
            <label>
              Action
              <select name="action">
                <option value="warn">Warn</option>
                <option value="timeout">Timeout</option>
                <option value="untimeout">Remove timeout</option>
                ${canAdvanced ? '<option value="kick">Kick</option><option value="ban">Ban</option>' : ""}
              </select>
            </label>
            <label>
              Duration
              <input name="duration" placeholder="10m, 2h, 1d">
            </label>
            <label class="member-action-reason">
              Reason
              <textarea name="reason" rows="3" maxlength="500" placeholder="Reason for ${escapeHtml(userLabel)}"></textarea>
            </label>
            <button type="submit" class="danger-button">Run action</button>
          </form>
        </details>
      </div>
      ${punishmentHistoryModal(`member-${member.id}`, member.id, member.tag || member.displayName, config, warningMemberLabels)}
    </article>
  `;
}

function punishmentHistoryModal(modalKey = "", userId = "", fallbackLabel = "", config = {}, warningMemberLabels = {}) {
  modalKey = String(modalKey || userId || "").trim();
  userId = String(userId || "").trim();
  if (!userId) return "";
  const history = punishmentHistoryFor(config, userId);
  const userLabel = warningUserLabel(config, userId, warningMemberLabels) || fallbackLabel || userId;
  return `
    <div class="punishment-modal" id="punishments-${escapeHtml(modalKey)}" role="dialog" aria-modal="true" aria-labelledby="punishment-title-${escapeHtml(modalKey)}">
      <a class="punishment-modal-backdrop" href="#" aria-label="Close punishment history"></a>
      <section class="punishment-modal-card">
        <div class="case-row-head">
          <div>
            <h2 id="punishment-title-${escapeHtml(modalKey)}">Punishments for ${escapeHtml(userLabel)}</h2>
            <p class="muted">${escapeHtml(userId)} &middot; ${escapeHtml(history.warnings.length)} warning${history.warnings.length === 1 ? "" : "s"} &middot; ${escapeHtml(history.moderationLogs.length)} moderation action${history.moderationLogs.length === 1 ? "" : "s"}</p>
          </div>
          <a class="primary-link secondary-link" href="#">Close</a>
        </div>
        <div class="punishment-modal-body">
          <section class="sub-panel">
            <strong>Warnings</strong>
            ${history.warnings.length
              ? `<ul>${history.warnings.slice().reverse().map((warning) => `<li>${escapeHtml(warningReasonText(warning))}</li>`).join("")}</ul>`
              : '<p class="muted">No warnings recorded for this member.</p>'}
          </section>
          <section class="sub-panel">
            <strong>Moderation Actions</strong>
            ${history.moderationLogs.length
              ? `<div class="stack-list">${history.moderationLogs.map((entry) => `
                <div class="audit-row">
                  <strong>${escapeHtml(entry.label || entry.action || "Moderation action")}</strong>
                  <small>${escapeHtml(entry.moderatorTag || entry.actor || "Unknown moderator")} &middot; ${escapeHtml(entry.createdAt || "")}</small>
                  <p>${escapeHtml(entry.details || "No details recorded.")}</p>
                </div>
              `).join("")}</div>`
              : '<p class="muted">No moderation actions recorded for this member.</p>'}
          </section>
        </div>
      </section>
    </div>
  `;
}

function moderationWorkspace(guildId, config = {}, warningMemberLabels = {}) {
  const warnings = Object.entries(config.moderation?.warnings || {})
    .map(([userId, entries]) => ({
      userId,
      entries: Array.isArray(entries) ? entries : []
    }))
    .filter((entry) => entry.entries.length)
    .sort((a, b) => b.entries.length - a.entries.length || a.userId.localeCompare(b.userId));
  return `
    <section class="panel-section">
      <div class="section-heading">
        <h2>Warning Ledger</h2>
        <p>See every member with active warnings and clear them from the panel when needed.</p>
      </div>
      ${
        warnings.length
          ? `<div class="warning-ledger">${warnings.map((entry) => `
              <article class="warning-row">
                <div class="warning-row-main">
                  <strong>${escapeHtml(warningUserLabel(config, entry.userId, warningMemberLabels))}</strong>
                  <small>${escapeHtml(entry.userId)}</small>
                  <small>${escapeHtml(entry.entries.length)} active warning${entry.entries.length === 1 ? "" : "s"}</small>
                  <ul>${entry.entries.slice(-5).reverse().map((warning) => `<li>${escapeHtml(warningReasonText(warning))}</li>`).join("")}</ul>
                </div>
                <div class="case-row-actions">
                  <a class="primary-link secondary-link" href="#punishments-warning-${escapeHtml(entry.userId)}">View Punishments</a>
                  <button type="button" class="secondary-button" data-post-action="/guilds/${guildId}/warnings/${entry.userId}/clear?section=moderation">Clear warnings</button>
                </div>
                ${punishmentHistoryModal(`warning-${entry.userId}`, entry.userId, "", config, warningMemberLabels)}
              </article>
            `).join("")}</div>`
          : '<p class="muted">No active warnings to review.</p>'
      }
    </section>
  `;
}

function restoreCenter(guildId) {
  return `
    <section class="panel-section">
      <div class="section-heading">
        <h2>Restore Center</h2>
        <p>Paste one of the exported JSON snapshots here and restore only the scope you intend to replace.</p>
      </div>
      <form method="post" action="/admin/restore" class="stack">
        <input type="hidden" name="guildId" value="${escapeHtml(guildId)}">
        <label>
          Restore scope
          <select name="restoreScope">
            <option value="config">Full guild config</option>
            <option value="community">Community data</option>
            <option value="moderation">Moderation data</option>
            <option value="applications">Application data</option>
            <option value="public">Public site data</option>
          </select>
        </label>
        <label>
          JSON snapshot
          <textarea name="restorePayload" rows="12" placeholder='Paste a JSON export here'></textarea>
        </label>
        <p class="field-help">This merges into the current guild config instead of blanking unrelated sections.</p>
        <button type="submit" class="secondary-button">Restore selected scope</button>
      </form>
    </section>
  `;
}

function applicationsWorkspace(guildId, guild, config = {}) {
  const tickets = Object.entries(config.applications?.tickets || {})
    .map(([userId, ticket]) => ({
      userId,
      channelId: String(ticket.channelId || ""),
      parentChannelId: String(ticket.parentChannelId || ""),
      questionIndex: Math.max(Number(ticket.questionIndex) || 0, 0),
      completed: Boolean(ticket.completed),
      updatedAt: String(ticket.updatedAt || "")
    }))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const cooldowns = Object.entries(config.applications?.cooldowns || {})
    .map(([userId, cooldown]) => ({
      userId,
      lastAppliedAt: String(cooldown?.lastAppliedAt || "")
    }))
    .sort((a, b) => String(b.lastAppliedAt).localeCompare(String(a.lastAppliedAt)));
  const questions = config.applications?.questions || [];
  const reviewerRoles = (config.applications?.reviewerRoleIds || []).map((roleId) => displayRoleName(guild, roleId));
  return `
    <section class="panel-section">
      <div class="section-heading">
        <h2>Application Operations</h2>
        <p>See active applicants, routing, and cooldown state without digging through raw config.</p>
      </div>
      <div class="stats-grid">
        <article class="stat-card"><strong>${escapeHtml(tickets.length)}</strong><span>Tracked Tickets</span></article>
        <article class="stat-card"><strong>${escapeHtml(tickets.filter((ticket) => !ticket.completed).length)}</strong><span>Open Applications</span></article>
        <article class="stat-card"><strong>${escapeHtml(cooldowns.length)}</strong><span>Cooldown Entries</span></article>
        <article class="stat-card"><strong>${escapeHtml(questions.length)}</strong><span>Questions</span></article>
      </div>
      <div class="dashboard-grid">
        <div class="sub-panel">
          <div class="section-heading">
            <h2>Routing</h2>
            <p>Quick confirmation that applications are pointed at the right channels and roles.</p>
          </div>
          <div class="stack-list">
            <div class="list-row"><div><strong>Command channel</strong><span>${escapeHtml(displayChannelName(guild, config.applications?.channelId))}</span></div></div>
            <div class="list-row"><div><strong>Review thread channel</strong><span>${escapeHtml(displayChannelName(guild, config.applications?.threadChannelId || config.applications?.channelId))}</span></div></div>
            <div class="list-row"><div><strong>Approved role</strong><span>${escapeHtml(displayRoleName(guild, config.applications?.approvedRoleId))}</span></div></div>
            <div class="list-row"><div><strong>Reviewer roles</strong><span>${escapeHtml(reviewerRoles.length ? reviewerRoles.join(", ") : "None selected")}</span></div></div>
          </div>
        </div>
        <div class="sub-panel">
          <div class="section-heading">
            <h2>Current Questions</h2>
            <p>The exact prompts applicants are answering in DMs.</p>
          </div>
          ${
            questions.length
              ? `<ol class="application-question-list">${questions.map((question) => `<li>${escapeHtml(question)}</li>`).join("")}</ol>`
              : '<p class="muted">No application questions configured yet.</p>'
          }
        </div>
      </div>
    </section>
    <section class="panel-section">
      <div class="section-heading">
        <h2>Open Ticket Records</h2>
        <p>These records keep the DM bridge alive after restarts. Clear one if an applicant needs a fresh start.</p>
      </div>
      ${
        tickets.length
          ? `<div class="warning-ledger">${tickets.map((ticket) => `<article class="warning-row"><div class="warning-row-main"><strong>${escapeHtml(ticket.userId)}</strong><small>${escapeHtml(ticket.completed ? "Completed" : "In progress")} &middot; Question ${escapeHtml(Math.min(ticket.questionIndex + 1, Math.max(questions.length, 1)))}</small><ul><li>Thread: ${escapeHtml(ticket.channelId || "Missing")}</li><li>Parent: ${escapeHtml(displayChannelName(guild, ticket.parentChannelId))}</li><li>Updated: ${escapeHtml(ticket.updatedAt || "Unknown")}</li></ul></div><button type="button" class="secondary-button" data-post-action="/guilds/${guildId}/applications/${ticket.userId}/clear-ticket?section=applications">Clear ticket</button></article>`).join("")}</div>`
          : '<p class="muted">No stored application tickets right now.</p>'
      }
    </section>
    <section class="panel-section">
      <div class="section-heading">
        <h2>Cooldown Ledger</h2>
        <p>Applicants on cooldown after opening an application. Clear an entry if you want to let someone retry immediately.</p>
      </div>
      ${
        cooldowns.length
          ? `<div class="warning-ledger">${cooldowns.map((entry) => `<article class="warning-row"><div class="warning-row-main"><strong>${escapeHtml(entry.userId)}</strong><small>Last applied ${escapeHtml(entry.lastAppliedAt || "Unknown")}</small></div><button type="button" class="secondary-button" data-post-action="/guilds/${guildId}/applications/${entry.userId}/clear-cooldown?section=applications">Clear cooldown</button></article>`).join("")}</div>`
          : '<p class="muted">No active application cooldowns.</p>'
      }
    </section>
  `;
}

function publicSiteWorkspace(config = {}, commandList = []) {
  const publicMembers = publicMembersFromConfig(config);
  const artifacts = config.community?.artifacts || [];
  const rituals = config.community?.rituals || {};
  const leaderboardEntries = publicLeaderboardFileEntries(readGameLeaderboard(), publicGameSettings(config));
  const gameCounts = ["dash", "runner", "mines", "catch", "loaf", "blitz"].map((gameId) => ({
    gameId,
    label: gameLabel(gameId),
    count: publicLeaderboardEntries(leaderboardEntries, gameId, publicGameSettings(config)).length
  }));
  return `
    <section class="panel-section">
      <div class="section-heading">
        <h2>Public Site Overview</h2>
        <p>Quick visibility into what visitors see across the public Chipkittle pages.</p>
      </div>
      <div class="stats-grid">
        <article class="stat-card"><strong>${escapeHtml(publicMembers.length)}</strong><span>Public Members</span></article>
        <article class="stat-card"><strong>${escapeHtml(artifacts.length)}</strong><span>Artifacts</span></article>
        <article class="stat-card"><strong>${escapeHtml(commandList.length)}</strong><span>Published Commands</span></article>
        <article class="stat-card"><strong>${escapeHtml(leaderboardEntries.length)}</strong><span>Saved Game Scores</span></article>
      </div>
      <div class="dashboard-grid">
        <div class="sub-panel">
          <div class="section-heading">
            <h2>Quick Links</h2>
            <p>Jump straight to the public pages from the panel.</p>
          </div>
          <div class="link-grid">
            <a class="primary-link secondary-link" href="https://chipkittle.com/" target="_blank" rel="noreferrer">Home</a>
            <a class="primary-link secondary-link" href="https://chipkittle.com/members" target="_blank" rel="noreferrer">Members</a>
            <a class="primary-link secondary-link" href="https://chipkittle.com/commands" target="_blank" rel="noreferrer">Commands</a>
            <a class="primary-link secondary-link" href="https://chipkittle.com/archive" target="_blank" rel="noreferrer">Archive</a>
            <a class="primary-link secondary-link" href="https://chipkittle.com/commits" target="_blank" rel="noreferrer">Commits</a>
            <a class="primary-link secondary-link" href="https://chipkittle.com/status" target="_blank" rel="noreferrer">Status</a>
            <a class="primary-link secondary-link" href="https://chipkittle.com/game" target="_blank" rel="noreferrer">Games</a>
            <a class="primary-link secondary-link" href="https://chipkittle.com/8ball" target="_blank" rel="noreferrer">8 Ball</a>
            <a class="primary-link secondary-link" href="https://chipkittle.com/loaf" target="_blank" rel="noreferrer">Loaf Hopper</a>
            <a class="primary-link secondary-link" href="https://chipkittle.com/blitz" target="_blank" rel="noreferrer">Bread Blitz</a>
          </div>
        </div>
        <div class="sub-panel">
          <div class="section-heading">
            <h2>Live Public Copy</h2>
            <p>The ritual text and status snippets currently exposed on the website.</p>
          </div>
          <div class="stack-list">
            <div class="audit-row"><strong>Current event</strong><p>${escapeHtml(rituals.currentEvent || "No public event set.")}</p></div>
            <div class="audit-row"><strong>Seasonal message</strong><p>${escapeHtml(rituals.seasonalMessage || "No seasonal message set.")}</p></div>
            <div class="audit-row"><strong>Next trial</strong><p>${escapeHtml(rituals.nextTrial || "No next trial scheduled.")}</p></div>
          </div>
        </div>
      </div>
    </section>
    <section class="panel-section">
      <div class="section-heading">
        <h2>Game Leaderboard Snapshot</h2>
        <p>A quick count of how much public score data each game is carrying right now.</p>
      </div>
      <div class="dashboard-grid">
        ${gameCounts.map((entry) => `<div class="sub-panel"><strong>${escapeHtml(entry.label)}</strong><p class="muted">${escapeHtml(entry.count)} saved leaderboard entr${entry.count === 1 ? "y" : "ies"}.</p></div>`).join("")}
      </div>
    </section>
  `;
}

function suggestionsWorkspace(guild, config = {}, panelUser = null) {
  const suggestions = storedSuggestions(config);
  const counts = Object.fromEntries(SUGGESTION_STATUSES.map((status) => [status, suggestions.filter((entry) => String(entry.status || "submitted") === status).length]));
  const canSetStaffUser = panelAccessAtLeast(panelUser?.level || "root", "root");
  const currentStaffUserId = suggestionStaffUserId(config);
  return `
    <section class="panel-section">
      <div class="section-heading">
        <h2>Suggestion Queue</h2>
        <p>Ideas submitted from Discord and the public website. Mark what staff is reviewing, accepting, denying, and shipping.</p>
      </div>
      <div class="stats-grid">
        <article class="stat-card"><strong>${escapeHtml(suggestions.length)}</strong><span>Total Suggestions</span></article>
        <article class="stat-card"><strong>${escapeHtml(counts.under_consideration || 0)}</strong><span>Under Consideration</span></article>
        <article class="stat-card"><strong>${escapeHtml(counts.accepted || 0)}</strong><span>Accepted</span></article>
        <article class="stat-card"><strong>${escapeHtml(counts.implemented || 0)}</strong><span>Implemented</span></article>
      </div>
    </section>
    ${
      canSetStaffUser
        ? `<section class="panel-section">
            <div class="section-heading">
              <h2>Staff DM Forwarding</h2>
              <p>Only root users can decide which Discord user receives a DM when new suggestions arrive.</p>
            </div>
            <form method="post" action="/guilds/${guild.id}/suggestions/staff-dm" class="compact-form">
              <label>
                Staff Discord user ID
                <input name="suggestionStaffUserId" value="${escapeHtml(currentStaffUserId)}" maxlength="22" placeholder="203025242753335296">
              </label>
              <button type="submit">Save DM User</button>
            </form>
          </section>`
        : ""
    }
    <section class="panel-section">
      <div class="section-heading">
        <h2>Review List</h2>
        <p>Newest suggestions appear first. Status changes are logged in the audit log.</p>
      </div>
      ${
        suggestions.length
          ? `<div class="suggestion-ledger">${suggestions.map((suggestion) => `
              <article class="suggestion-row">
                <div class="suggestion-row-main">
                  <div class="suggestion-row-top">
                    <strong>${escapeHtml(suggestion.title || suggestion.body || "Suggestion").slice(0, 90)}</strong>
                    <span class="${suggestionStatusClass(suggestion.status)}">${escapeHtml(suggestionStatusLabel(suggestion.status))}</span>
                  </div>
                  <small>${escapeHtml(suggestion.source === "website" ? "Website" : "Discord")} &middot; ${escapeHtml(suggestion.authorTag || suggestion.authorName || "Anonymous")}${suggestion.authorId ? ` &middot; ${escapeHtml(suggestion.authorId)}` : ""} &middot; ${escapeHtml(suggestion.createdAt || "Unknown")}</small>
                  ${suggestion.title ? `<p class="muted">${escapeHtml(suggestion.body || "")}</p>` : `<p>${escapeHtml(suggestion.body || "")}</p>`}
                  ${suggestion.updatedBy ? `<small>Last updated by ${escapeHtml(suggestion.updatedBy)} at ${escapeHtml(suggestion.updatedAt || "")}</small>` : ""}
                </div>
                <form method="post" action="/guilds/${guild.id}/suggestions/${encodeURIComponent(suggestion.id)}/status" class="inline-action-form">
                  <select name="status" aria-label="Suggestion status">
                    ${SUGGESTION_STATUSES.map((status) => `<option value="${status}" ${String(suggestion.status || "submitted") === status ? "selected" : ""}>${escapeHtml(suggestionStatusLabel(status))}</option>`).join("")}
                  </select>
                  <button type="submit">Update</button>
                </form>
              </article>
            `).join("")}</div>`
          : '<p class="muted">No suggestions have been submitted yet.</p>'
      }
    </section>
  `;
}

function communityWorkspace(guildId, config = {}) {
  const snapshot = communitySnapshot(config);
  const artifacts = (config.community?.artifacts || []).slice(0, 8);
  const artifact = artifactOfTheDay(config);
  const staffNotes = Object.entries(config.community?.staffNotes || {})
    .map(([userId, notes]) => ({
      userId,
      notes: Array.isArray(notes) ? notes : []
    }))
    .filter((entry) => entry.notes.length)
    .sort((a, b) => b.notes.length - a.notes.length || a.userId.localeCompare(b.userId))
    .slice(0, 12);
  const rituals = config.community?.rituals || {};
  return `
    <section class="panel-section">
      <div class="section-heading">
        <h2>Community Operations</h2>
        <p>Track registry health, staff notes, and the public ritual state from one place.</p>
      </div>
      <div class="stats-grid">
        <article class="stat-card"><strong>${escapeHtml(snapshot.artifacts)}</strong><span>Artifacts</span></article>
        <article class="stat-card"><strong>${escapeHtml(snapshot.profiles)}</strong><span>Profiles</span></article>
        <article class="stat-card"><strong>${escapeHtml(Object.keys(config.community?.staffNotes || {}).length)}</strong><span>Members With Notes</span></article>
        <article class="stat-card"><strong>${escapeHtml(snapshot.artifactsRegistered)}</strong><span>Artifacts Registered</span></article>
      </div>
      <div class="dashboard-grid">
        <div class="sub-panel">
          <div class="section-heading">
            <h2>Artifact Of The Day</h2>
            <p>The featured artifact currently shown by the bot rotation.</p>
          </div>
          ${
            artifact
              ? `<div class="audit-row"><strong>${escapeHtml(artifact.name)}</strong><small>${escapeHtml(artifact.rarity)} &middot; ${escapeHtml(artifact.keeper)}</small><p>${escapeHtml(artifact.summary)}</p></div>`
              : '<p class="muted">No artifact is available right now.</p>'
          }
        </div>
        <div class="sub-panel">
          <div class="section-heading">
            <h2>Public Ritual Preview</h2>
            <p>This is the archive/status copy the website is currently working with.</p>
          </div>
          <div class="stack-list">
            <div class="audit-row"><strong>Current event</strong><p>${escapeHtml(rituals.currentEvent || "No current event set.")}</p></div>
            <div class="audit-row"><strong>Seasonal message</strong><p>${escapeHtml(rituals.seasonalMessage || "No seasonal message set.")}</p></div>
            <div class="audit-row"><strong>Next trial</strong><p>${escapeHtml(rituals.nextTrial || "No next trial set.")}</p></div>
          </div>
        </div>
      </div>
    </section>
    <section class="panel-section">
      <div class="section-heading">
        <h2>Artifact Registry Snapshot</h2>
        <p>The first few artifacts in the registry so you can sanity-check names, keepers, and summaries.</p>
      </div>
      ${
        artifacts.length
          ? `<div class="stack-list">${artifacts.map((item) => `<div class="audit-row"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.rarity)} &middot; ${escapeHtml(item.keeper)}</small><p>${escapeHtml(item.summary)}</p></div>`).join("")}</div>`
          : '<p class="muted">No artifacts are registered yet.</p>'
      }
    </section>
    <section class="panel-section">
      <div class="section-heading">
        <h2>Staff Note Ledger</h2>
        <p>Review private member notes and clear a member's note history from the panel if needed.</p>
      </div>
      ${
        staffNotes.length
          ? `<div class="warning-ledger">${staffNotes.map((entry) => `<article class="warning-row"><div class="warning-row-main"><strong>${escapeHtml(entry.userId)}</strong><small>${escapeHtml(entry.notes.length)} stored note${entry.notes.length === 1 ? "" : "s"}</small><ul>${entry.notes.slice(0, 3).map((note) => `<li>${escapeHtml(note.author || "Staff")}: ${escapeHtml(note.note || "")}</li>`).join("")}</ul></div><button type="button" class="secondary-button" data-post-action="/guilds/${guildId}/community/staff-notes/${entry.userId}/clear?section=community">Clear notes</button></article>`).join("")}</div>`
          : '<p class="muted">No staff notes are stored right now.</p>'
      }
    </section>
  `;
}

function dashboardCards(guild, config = {}) {
  const snapshot = communitySnapshot(config);
  const top = topCommands(config, 5);
  const auditLog = (config.community?.auditLog || []).slice(0, 8);
  const recentPunishments = (config.community?.auditLog || []).filter((entry) => String(entry.type || "") === "moderation").slice(0, 6);
  return `
    <section class="panel-section">
      <div class="section-heading">
        <h2>Overview</h2>
        <p>Live server and community stats pulled from the bot runtime.</p>
      </div>
      <div class="stats-grid">
        <article class="stat-card"><strong>${escapeHtml(guild.memberCount)}</strong><span>Members</span></article>
        <article class="stat-card"><strong>${escapeHtml(snapshot.commandsRun)}</strong><span>Commands Run</span></article>
        <article class="stat-card"><strong>${escapeHtml(snapshot.aiReplies)}</strong><span>AI Replies</span></article>
        <article class="stat-card"><strong>${escapeHtml(snapshot.applicationsOpened)}</strong><span>Applications</span></article>
        <article class="stat-card"><strong>${escapeHtml(recentPunishments.length)}</strong><span>Recent Punishments</span></article>
        <article class="stat-card"><strong>${escapeHtml(snapshot.artifacts)}</strong><span>Artifacts</span></article>
        <article class="stat-card"><strong>${escapeHtml(snapshot.shopPurchases)}</strong><span>Shop Purchases</span></article>
      </div>
    </section>
    <div class="dashboard-grid">
      <section class="panel-section">
        <div class="section-heading">
          <h2>Top Commands</h2>
          <p>The commands members are using most often.</p>
        </div>
        ${top.length
          ? `<div class="stack-list">${top.map((item) => `<div class="list-row"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.count)} uses</span></div>`).join("")}</div>`
          : '<p class="muted">No command activity yet.</p>'}
      </section>
      <section class="panel-section">
        <div class="section-heading">
          <h2>Recent Punishments</h2>
          <p>Newest moderation actions recorded by the bot and panel.</p>
        </div>
        ${recentPunishments.length
          ? `<div class="stack-list">${recentPunishments.map((entry) => `<div class="audit-row"><strong>${escapeHtml(entry.label || entry.action || "Moderation action")}</strong><small>${escapeHtml(entry.targetTag || entry.targetId || "Unknown target")} &middot; ${escapeHtml(entry.createdAt || "")}</small><p>${escapeHtml(entry.details || "No details recorded.")}</p></div>`).join("")}</div>`
          : '<p class="muted">No moderation actions yet.</p>'}
      </section>
      <section class="panel-section">
        <div class="section-heading">
          <h2>Activity Feed</h2>
          <p>Recent application, moderation, shop, and profile events.</p>
        </div>
        ${auditLog.length
          ? `<div class="stack-list">${auditLog.map((entry) => `<div class="audit-row"><strong>${escapeHtml(entry.label)}</strong><small>${escapeHtml(entry.actor || "System")} &middot; ${escapeHtml(entry.createdAt || "")}</small><p>${escapeHtml(entry.details || "")}</p></div>`).join("")}</div>`
          : '<p class="muted">No audit activity yet.</p>'}
      </section>
    </div>
  `;
}

function auditEntryKey(entry = {}, index = 0) {
  return String(entry.id || `legacy-${index}`);
}

function auditActionLabel(entry = {}) {
  return String(entry.action || entry.label || entry.type || "event")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function auditLogWorkspace(guildId, config = {}, panelUser = null) {
  const auditLog = Array.isArray(config.community?.auditLog) ? config.community.auditLog : [];
  const canDelete = panelAccessAtLeast(panelUser?.level || "root", "root");
  const rows = auditLog
    .map((entry, index) => {
      const key = auditEntryKey(entry, index);
      const actor = entry.moderatorTag || entry.actor || "System";
      const target = entry.targetTag || entry.targetId || "No target";
      const label = entry.label || auditActionLabel(entry);
      return `
        <article class="audit-log-row">
          <div class="audit-log-main">
            <div class="audit-log-title">
              <span>${escapeHtml(label)}</span>
              <strong>${escapeHtml(auditActionLabel(entry))}</strong>
            </div>
            <div class="audit-log-meta">
              <span>By ${escapeHtml(actor)}</span>
              <span>Target ${escapeHtml(target)}</span>
              <span>${escapeHtml(entry.createdAt || "")}</span>
            </div>
            <p>${escapeHtml(entry.details || "No details recorded.")}</p>
          </div>
          ${canDelete
            ? `<form method="post" action="/guilds/${guildId}/audit/${encodeURIComponent(key)}/delete" onsubmit="return confirm('Delete this audit log entry?');">
                <button type="submit" class="danger-button compact-button">Delete</button>
              </form>`
            : ""}
        </article>
      `;
    })
    .join("");

  return `
    <section class="panel-section audit-log-panel">
      <div class="section-heading">
        <h2>Audit Log</h2>
        <p>Every panel tier can review actions here. Root can remove stale or noisy entries.</p>
      </div>
      <a class="primary-link secondary-link" href="/admin/export/audit">Export audit log</a>
      ${auditLog.length
        ? `<div class="audit-log-list">${rows}</div>`
        : '<p class="muted">No audit activity has been recorded yet.</p>'}
    </section>
  `;
}

function arrayFromFormValue(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function parseMemberDirectory(value = "") {
  return String(value || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name = "", role = "", bio = "", title = "", badges = ""] = line.split("|").map((part) => part.trim());
      return {
        name: name.slice(0, 80),
        role: role.slice(0, 80),
        bio: bio.slice(0, 220),
        title: title.slice(0, 80),
        badges: badges
          .split(",")
          .map((badge) => badge.trim())
          .filter(Boolean)
          .slice(0, 8)
      };
    })
    .filter((member) => member.name)
    .slice(0, 60);
}

function memberDirectoryText(members = []) {
  return members
    .map((member) => [member.name, member.role, member.bio, member.title, (member.badges || []).join(", ")].filter((part) => part !== undefined).join(" | "))
    .join("\n");
}

function parseAiChannelPersonalities(value = "") {
  return Object.fromEntries(
    String(value || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [channelId = "", ...parts] = line.split("|");
        return [
          channelId.replace(/\D/g, "").slice(0, 24),
          parts.join("|").trim().slice(0, 600)
        ];
      })
      .filter(([channelId, text]) => channelId && text)
  );
}

function aiChannelPersonalitiesText(personalities = {}) {
  return Object.entries(personalities || {})
    .map(([channelId, text]) => `${channelId} | ${String(text || "").replace(/\s+/g, " ").trim()}`)
    .join("\n");
}

function memberDirectoryRows(members = []) {
  return members
    .map(
      (member) => `
        <div class="member-editor-row" data-member-row>
          <div class="member-editor-fields">
            <label>Name<input data-member-name value="${escapeHtml(member.name || "")}" maxlength="80"></label>
            <label>Role<input data-member-role value="${escapeHtml(member.role || "")}" maxlength="80"></label>
            <label>Title<input data-member-title value="${escapeHtml(member.title || "")}" maxlength="80"></label>
            <label>Badges<input data-member-badges value="${escapeHtml(Array.isArray(member.badges) ? member.badges.join(", ") : "")}" maxlength="180"></label>
            <label class="member-editor-bio">Bio<textarea data-member-bio rows="3" maxlength="220">${escapeHtml(member.bio || "")}</textarea></label>
          </div>
          <button type="button" class="secondary-button member-editor-remove" data-remove-member>Remove</button>
        </div>
      `
    )
    .join("");
}

function memberDirectoryEditor(members = []) {
  return `
    <section class="panel-section" data-member-directory-editor>
      <div class="section-heading">
        <h2>Public Member Directory</h2>
        <p>Manage the member cards shown on the public website without hand-editing a giant block of text.</p>
      </div>
      <div class="member-editor-toolbar">
        <strong data-member-count>${escapeHtml(members.length)} member${members.length === 1 ? "" : "s"}</strong>
        <button type="button" data-add-member>Add member</button>
      </div>
      <div class="member-editor-list" data-member-rows>
        ${memberDirectoryRows(members) || '<p class="muted member-editor-empty">No public members yet. Add the first one here.</p>'}
      </div>
      <textarea name="publicMembers" hidden>${escapeHtml(memberDirectoryText(members))}</textarea>
      <details class="advanced-note">
        <summary>Advanced raw format</summary>
        <p class="field-help">Saved as <code>Name | Role | Bio | Title | Badge, Badge</code> behind the scenes.</p>
      </details>
    </section>
  `;
}

function profileEditPreviewCard(userId, entry = {}, guildId = "") {
  const draft = entry.draft || {};
  return `
    <article class="member-mini-card profile-approval-card">
      <strong>${escapeHtml(draft.displayName || entry.username || userId)}</strong>
      <small>${escapeHtml(draft.title || "No title")} &middot; ${escapeHtml(entry.username || userId)}</small>
      <p>${escapeHtml(draft.bio || "No bio submitted.")}</p>
      ${draft.favoriteArtifact ? `<p><strong>Artifact:</strong> ${escapeHtml(draft.favoriteArtifact)}</p>` : ""}
      ${draft.quote ? `<p><strong>Quote:</strong> ${escapeHtml(draft.quote)}</p>` : ""}
      <div class="mini-stats"><span>${entry.submittedAt ? `Submitted ${escapeHtml(entry.submittedAt)}` : "Pending"}</span><span>${draft.publicVisible ? "Public requested" : "Hidden requested"}</span></div>
      <div class="inline-controls">
        <form method="post" action="/guilds/${encodeURIComponent(guildId)}/profiles/${encodeURIComponent(userId)}/approve" class="inline-form">
          <button type="submit">Approve</button>
        </form>
        <form method="post" action="/guilds/${encodeURIComponent(guildId)}/profiles/${encodeURIComponent(userId)}/reject" class="inline-form">
          <button type="submit" class="danger-button">Reject</button>
        </form>
      </div>
    </article>
  `;
}

function profileApprovalQueue(config = {}, guildId = "", panelUser = null) {
  const pending = Object.entries(config.community?.profileEdits || {})
    .filter(([, entry]) => entry?.status === "pending")
    .sort((a, b) => String(b[1]?.submittedAt || "").localeCompare(String(a[1]?.submittedAt || "")));
  const canApprove = panelAccessAtLeast(panelUser?.level || "", "root");
  return `
    <section class="panel-section">
      <div class="section-heading">
        <h2>Profile Approval Queue</h2>
        <p>Website profile edits wait here until root approves them. Approved versions are the only ones shown publicly.</p>
      </div>
      ${
        pending.length
          ? canApprove
            ? `<div class="member-chip-grid">${pending.map(([userId, entry]) => profileEditPreviewCard(userId, entry, guildId)).join("")}</div>`
            : '<p class="muted">There are pending profile edits, but only root can review them.</p>'
          : '<p class="muted">No profile edits are waiting for approval.</p>'
      }
    </section>
  `;
}

function profileDirectoryCards(config = {}) {
  const profiles = Object.entries(config.community?.profiles || {})
    .map(([userId, profile]) => ({
      userId,
      displayName: String(profile.displayName || userId),
      title: String(profile.title || "Unranked Observer"),
      reputation: Math.max(Number(profile.reputation) || 0, 0),
      badges: Array.isArray(profile.badges) ? profile.badges : [],
      vouches: Array.isArray(profile.vouches) ? profile.vouches : [],
      bio: String(profile.bio || "").trim()
    }))
    .sort((a, b) => b.reputation - a.reputation || a.displayName.localeCompare(b.displayName))
    .slice(0, 24);
  return `
    <section class="panel-section">
      <div class="section-heading">
        <h2>Community Profiles</h2>
        <p>Live profile data earned through the bot. This gives you a quick read on active members and titles.</p>
      </div>
      ${
        profiles.length
          ? `<div class="member-chip-grid">${profiles.map((profile) => `<article class="member-mini-card"><strong>${escapeHtml(profile.displayName)}</strong><small>${escapeHtml(profile.title)}</small><p>${escapeHtml(profile.bio || "No profile bio set.")}</p><div class="mini-stats"><span>${escapeHtml(profile.reputation)} rep</span><span>${escapeHtml(profile.vouches.length)} vouches</span><span>${escapeHtml(profile.badges.length)} badges</span></div></article>`).join("")}</div>`
          : '<p class="muted">No profile activity has been recorded yet.</p>'
      }
    </section>
  `;
}

function profileEditorSettings(config = {}, roles = []) {
  const settings = config.publicSite?.profileEditor || {};
  const fallbackRoleId = config.applications?.approvedRoleId || "";
  return `
    <section class="panel-section">
      <div class="section-heading">
        <h2>Member Profile Self-Edit</h2>
        <p>Let approved Discord members sign in with OAuth and edit their own public member card.</p>
      </div>
      <label class="toggle">
        <input type="checkbox" name="profileEditorEnabled" ${isChecked(settings.enabled !== false)}>
        <span>Enable public profile editor</span>
      </label>
      <p class="field-help">Profile editor URL: <code>/profile/edit</code>. Add <code>/auth/discord/profile/callback</code> as a Discord OAuth redirect too.</p>
      <div class="permission-rule-block">
        <p class="field-help">Allowed member roles. If none are selected, the application approved role is used${fallbackRoleId ? `: <code>${escapeHtml(fallbackRoleId)}</code>` : "."}</p>
        <div class="checkbox-grid compact">
          ${roleCheckboxes(roles, settings.allowedRoleIds || [], "profileEditorAllowedRoleIds")}
        </div>
      </div>
    </section>
  `;
}

function publicMembersFromConfig(config = {}) {
  const manualMembers = publicMemberCards(config).map((member) => ({
    ...member,
    source: member.source || "panel"
  }));
  const profileMembers = Object.entries(config.community?.profiles || {})
    .map(([userId, storedProfile]) => {
      const profile = profileFor(config, userId, storedProfile.displayName || userId);
      if (!profile.publicVisible) return null;
      const achievements = derivedAchievements(config, userId, profile.displayName);
      return {
        id: userId,
        name: profile.displayName,
        role: profile.title || "Member",
        title: profile.pronouns || "",
        bio: profile.bio,
        quote: profile.quote,
        favoriteArtifact: profile.favoriteArtifact,
        badges: [...new Set([...(profile.badges || []), ...achievements.slice(0, 5)])].slice(0, 8),
        source: "profile"
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...manualMembers, ...profileMembers].slice(0, 120);
}

function writePublicMembersFile(members = []) {
  const filePath = path.join(process.cwd(), "public", "members.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(`${filePath}.tmp`, `${JSON.stringify(members, null, 2)}\n`, "utf8");
  fs.renameSync(`${filePath}.tmp`, filePath);
}

function leaderboardPath() {
  return path.join(process.cwd(), "data", "game-leaderboard.json");
}

function downloadJson(response, filename, payload) {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  response.send(`${JSON.stringify(payload, null, 2)}\n`);
}

function cloneForExport(value) {
  return structuredClone(value);
}

function sanitizePanelAccessForExport(panelAccess = {}) {
  const users = Object.fromEntries(
    Object.entries(panelAccess?.users || {}).map(([userId, entry]) => [
      userId,
      {
        ...entry,
        passwordHash: undefined,
        lastLoginIp: undefined,
        hasPassword: Boolean(entry?.passwordHash),
        passwordResetRequired: true
      }
    ])
  );

  return {
    ...panelAccess,
    recoveryCodes: Array.isArray(panelAccess?.recoveryCodes)
      ? panelAccess.recoveryCodes.map((entry) => ({
          createdAt: entry?.createdAt || "",
          createdBy: entry?.createdBy || "",
          hasHash: Boolean(entry?.hash || entry)
        }))
      : [],
    users
  };
}

function sanitizeConfigForExport(config = {}) {
  return {
    ...cloneForExport(config),
    panelAccess: sanitizePanelAccessForExport(config.panelAccess || {})
  };
}

function sanitizeStoreDataForExport(data = {}) {
  return {
    ...cloneForExport(data),
    guilds: Object.fromEntries(
      Object.entries(data?.guilds || {}).map(([guildEntryId, config]) => [
        guildEntryId,
        sanitizeConfigForExport(config)
      ])
    )
  };
}

function sanitizeConfigForRestore(config = {}) {
  const nextConfig = cloneForExport(config);
  const users = Object.fromEntries(
    Object.entries(nextConfig?.panelAccess?.users || {}).filter(([, entry]) => Boolean(entry?.passwordHash))
  );

  if (nextConfig.panelAccess) {
    nextConfig.panelAccess = {
      ...nextConfig.panelAccess,
      users
    };
  }

  return nextConfig;
}

function cleanGameId(value = "") {
  const gameId = String(value || "dash").toLowerCase().replace(/[^a-z0-9-]/g, "");
  return ["dash", "runner", "mines", "catch", "loaf", "blitz"].includes(gameId) ? gameId : "dash";
}

function cleanLeaderboardName(value = "") {
  return String(value || "")
    .replace(/[^\w .#-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24) || "Anonymous Chipkittle";
}

function normalizeBlockedWordList(value = "") {
  return String(value || "")
    .split(/[\n,]+/)
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 100);
}

function blockedWordListText(words = []) {
  return (Array.isArray(words) ? words : []).join(", ");
}

function publicGameSettings(config = {}) {
  const games = config?.publicSite?.games || {};
  const blockedLeaderboardWords = Array.isArray(games.blockedLeaderboardWords)
    ? games.blockedLeaderboardWords.map((word) => String(word || "").trim().toLowerCase()).filter(Boolean).slice(0, 100)
    : normalizeBlockedWordList(games.blockedLeaderboardWords);
  return {
    blockedLeaderboardWords,
    maxLeaderboardEntriesPerGame: Math.min(Math.max(Number(games.maxLeaderboardEntriesPerGame) || DEFAULT_PUBLIC_GAME_SETTINGS.maxLeaderboardEntriesPerGame, 1), 50),
    maxLeaderboardScore: Math.min(Math.max(Number(games.maxLeaderboardScore) || DEFAULT_PUBLIC_GAME_SETTINGS.maxLeaderboardScore, 1), 1000000),
    maxLeaderboardBread: Math.min(Math.max(Number(games.maxLeaderboardBread) || DEFAULT_PUBLIC_GAME_SETTINGS.maxLeaderboardBread, 0), 1000000),
    maxClaimBreadPerRun: Math.min(Math.max(Number(games.maxClaimBreadPerRun) || DEFAULT_PUBLIC_GAME_SETTINGS.maxClaimBreadPerRun, 0), 1000000),
    recordAlertChannelId: String(games.recordAlertChannelId || "")
  };
}

function clampPanelNumber(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(numeric, min), max);
}

function economyPanelSettings(config = {}) {
  const settings = config?.economy?.settings || {};
  const upgradeCosts = settings.upgradeCosts || config?.economy?.upgradeCosts || {};
  return {
    dailyBread: Math.floor(clampPanelNumber(settings.dailyBread, DEFAULT_ECONOMY_SETTINGS.dailyBread, 0, 1000000)),
    maxBreadBet: Math.floor(clampPanelNumber(settings.maxBreadBet, DEFAULT_ECONOMY_SETTINGS.maxBreadBet, 1, 1000000)),
    gamblingCooldownSeconds: Math.floor(clampPanelNumber(settings.gamblingCooldownSeconds, DEFAULT_ECONOMY_SETTINGS.gamblingCooldownSeconds, 0, 3600)),
    robCooldownMinutes: Math.floor(clampPanelNumber(settings.robCooldownMinutes, DEFAULT_ECONOMY_SETTINGS.robCooldownMinutes, 1, 10080)),
    casinoRobberyCooldownMinutes: Math.floor(clampPanelNumber(settings.casinoRobberyCooldownMinutes, DEFAULT_ECONOMY_SETTINGS.casinoRobberyCooldownMinutes, 1, 10080)),
    bankInterestCooldownHours: Math.floor(clampPanelNumber(settings.bankInterestCooldownHours, DEFAULT_ECONOMY_SETTINGS.bankInterestCooldownHours, 1, 168)),
    bankInterestRatePercent: clampPanelNumber(settings.bankInterestRatePercent, DEFAULT_ECONOMY_SETTINGS.bankInterestRatePercent, 0, 100),
    maxBankInterest: Math.floor(clampPanelNumber(settings.maxBankInterest, DEFAULT_ECONOMY_SETTINGS.maxBankInterest, 0, 1000000)),
    upgradeCosts: Object.fromEntries(
      PANEL_ECONOMY_UPGRADES.map((upgrade) => {
        const override = upgradeCosts[upgrade.id] || {};
        return [
          upgrade.id,
          {
            baseCost: Math.floor(clampPanelNumber(override.baseCost, upgrade.baseCost, 0, 10000000)),
            costGrowth: clampPanelNumber(override.costGrowth, upgrade.costGrowth, 1, 10)
          }
        ];
      })
    )
  };
}

function parseEconomySettings(body = {}) {
  const upgradeCosts = Object.fromEntries(
    PANEL_ECONOMY_UPGRADES.map((upgrade) => [
      upgrade.id,
      {
        baseCost: Math.floor(clampPanelNumber(body[`upgradeBaseCost_${upgrade.id}`], upgrade.baseCost, 0, 10000000)),
        costGrowth: clampPanelNumber(body[`upgradeCostGrowth_${upgrade.id}`], upgrade.costGrowth, 1, 10)
      }
    ])
  );

  return {
    dailyBread: Math.floor(clampPanelNumber(body.dailyBread, DEFAULT_ECONOMY_SETTINGS.dailyBread, 0, 1000000)),
    maxBreadBet: Math.floor(clampPanelNumber(body.maxBreadBet, DEFAULT_ECONOMY_SETTINGS.maxBreadBet, 1, 1000000)),
    gamblingCooldownSeconds: Math.floor(clampPanelNumber(body.gamblingCooldownSeconds, DEFAULT_ECONOMY_SETTINGS.gamblingCooldownSeconds, 0, 3600)),
    robCooldownMinutes: Math.floor(clampPanelNumber(body.robCooldownMinutes, DEFAULT_ECONOMY_SETTINGS.robCooldownMinutes, 1, 10080)),
    casinoRobberyCooldownMinutes: Math.floor(clampPanelNumber(body.casinoRobberyCooldownMinutes, DEFAULT_ECONOMY_SETTINGS.casinoRobberyCooldownMinutes, 1, 10080)),
    bankInterestCooldownHours: Math.floor(clampPanelNumber(body.bankInterestCooldownHours, DEFAULT_ECONOMY_SETTINGS.bankInterestCooldownHours, 1, 168)),
    bankInterestRatePercent: clampPanelNumber(body.bankInterestRatePercent, DEFAULT_ECONOMY_SETTINGS.bankInterestRatePercent, 0, 100),
    maxBankInterest: Math.floor(clampPanelNumber(body.maxBankInterest, DEFAULT_ECONOMY_SETTINGS.maxBankInterest, 0, 1000000)),
    upgradeCosts
  };
}

function economySettingsWorkspace(config = {}) {
  const settings = economyPanelSettings(config);
  const balances = config.economy?.balances || {};
  const bankBalances = config.economy?.bankBalances || {};
  const trackedUsers = new Set([...Object.keys(balances), ...Object.keys(bankBalances)]);
  const walletTotal = Object.values(balances).reduce((sum, amount) => sum + Math.max(Math.floor(Number(amount) || 0), 0), 0);
  const bankTotal = Object.values(bankBalances).reduce((sum, amount) => sum + Math.max(Math.floor(Number(amount) || 0), 0), 0);
  return `
    <section class="panel-section">
      <div class="section-heading">
        <h2>Bread Economy</h2>
        <p>Root-only controls for global bread payouts, gambling limits, robbery cooldowns, bank interest, and upgrade pricing.</p>
      </div>
      <div class="stat-grid compact-stat-grid">
        <div><span>Tracked users</span><strong>${trackedUsers.size.toLocaleString()}</strong></div>
        <div><span>Wallet bread</span><strong>${walletTotal.toLocaleString()}</strong></div>
        <div><span>Bank bread</span><strong>${bankTotal.toLocaleString()}</strong></div>
        <div><span>Transactions</span><strong>${(config.economy?.transactions || []).length.toLocaleString()}</strong></div>
      </div>
    </section>
    <section class="panel-section">
      <div class="section-heading">
        <h2>Global Tuning</h2>
        <p>These settings apply immediately after saving and do not erase balances, cooldowns, upgrades, or logs.</p>
      </div>
      <div class="field-pair">
        <label>
          Daily bread base
          <input type="number" name="dailyBread" min="0" max="1000000" value="${escapeHtml(settings.dailyBread)}">
        </label>
        <label>
          Max gambling bet
          <input type="number" name="maxBreadBet" min="1" max="1000000" value="${escapeHtml(settings.maxBreadBet)}">
        </label>
        <label>
          Gambling cooldown seconds
          <input type="number" name="gamblingCooldownSeconds" min="0" max="3600" value="${escapeHtml(settings.gamblingCooldownSeconds)}">
        </label>
        <label>
          Member robbery cooldown minutes
          <input type="number" name="robCooldownMinutes" min="1" max="10080" value="${escapeHtml(settings.robCooldownMinutes)}">
        </label>
        <label>
          Casino robbery cooldown minutes
          <input type="number" name="casinoRobberyCooldownMinutes" min="1" max="10080" value="${escapeHtml(settings.casinoRobberyCooldownMinutes)}">
        </label>
        <label>
          Bank interest cooldown hours
          <input type="number" name="bankInterestCooldownHours" min="1" max="168" value="${escapeHtml(settings.bankInterestCooldownHours)}">
        </label>
        <label>
          Base bank interest percent
          <input type="number" name="bankInterestRatePercent" min="0" max="100" step="0.01" value="${escapeHtml(settings.bankInterestRatePercent)}">
        </label>
        <label>
          Max base bank interest
          <input type="number" name="maxBankInterest" min="0" max="1000000" value="${escapeHtml(settings.maxBankInterest)}">
        </label>
      </div>
    </section>
    <section class="panel-section">
      <div class="section-heading">
        <h2>Upgrade Costs</h2>
        <p>Base cost is level 0 to 1. Growth multiplies each next level's cost.</p>
      </div>
      <div class="permission-list">
        ${PANEL_ECONOMY_UPGRADES.map((upgrade) => {
          const cost = settings.upgradeCosts[upgrade.id] || {};
          return `
            <details class="permission-category-card" open>
              <summary>
                <span>
                  <strong>${escapeHtml(upgrade.name)}</strong>
                  <small>${escapeHtml(upgrade.id)} - ${escapeHtml(upgrade.description)}</small>
                </span>
              </summary>
              <div class="field-pair">
                <label>
                  Base cost
                  <input type="number" name="upgradeBaseCost_${escapeHtml(upgrade.id)}" min="0" max="10000000" value="${escapeHtml(cost.baseCost)}">
                </label>
                <label>
                  Cost growth
                  <input type="number" name="upgradeCostGrowth_${escapeHtml(upgrade.id)}" min="1" max="10" step="0.01" value="${escapeHtml(cost.costGrowth)}">
                </label>
              </div>
            </details>
          `;
        }).join("")}
      </div>
    </section>
  `;
}

function economyUserSnapshot(config = {}, userId = "") {
  const economy = config.economy || {};
  const stats = economy.stats?.[userId] || {};
  return {
    wallet: Math.max(Math.floor(Number(economy.balances?.[userId] ?? DEFAULT_STARTING_BREAD) || 0), 0),
    bank: Math.max(Math.floor(Number(economy.bankBalances?.[userId] || 0) || 0), 0),
    upgrades: { ...(economy.upgrades?.[userId] || {}) },
    stats: {
      gamesPlayed: Math.max(Math.floor(Number(stats.gamesPlayed) || 0), 0),
      gamesWon: Math.max(Math.floor(Number(stats.gamesWon) || 0), 0),
      wagered: Math.max(Math.floor(Number(stats.wagered) || 0), 0),
      profit: Math.floor(Number(stats.profit) || 0),
      biggestWin: Math.max(Math.floor(Number(stats.biggestWin) || 0), 0)
    }
  };
}

function economyMemberBrowser(guildId, memberPage = { members: [] }, config = {}) {
  memberPage = memberPage || { members: [] };
  const members = Array.isArray(memberPage.members) ? memberPage.members : [];
  const search = memberPage.search || "";
  const after = memberPage.after || "";
  return `
    <section class="panel-section moderation-browser">
      <div class="section-heading">
        <h2>User Economy Editor</h2>
        <p>Search or browse members, then edit wallet, bank, and upgrade levels. Root-only.</p>
      </div>
      <form method="get" action="/guilds/${guildId}" class="moderation-search">
        <input type="hidden" name="section" value="economy">
        <label>
          Search members
          <input name="econSearch" value="${escapeHtml(search)}" placeholder="username, display name, or user ID">
        </label>
        <button type="submit">Search</button>
        <a class="primary-link secondary-link" href="/guilds/${guildId}?section=economy">Reset</a>
      </form>
      ${memberPage.error ? `<p class="form-error">${escapeHtml(memberPage.error)}</p>` : ""}
      <div class="member-action-list">
        ${
          members.length
            ? members.map((member) => economyMemberRow(guildId, member, search, after, config)).join("")
            : '<p class="muted">No members matched that search.</p>'
        }
      </div>
      <div class="pagination-actions">
        <a class="primary-link secondary-link" href="/guilds/${guildId}?section=economy">First page</a>
        ${
          memberPage.nextAfter
            ? `<a class="primary-link" href="/guilds/${guildId}?section=economy&econAfter=${encodeURIComponent(memberPage.nextAfter)}">Next page</a>`
            : ""
        }
      </div>
    </section>
  `;
}

function economyMemberRow(guildId, member, search = "", after = "", config = {}) {
  const snapshot = economyUserSnapshot(config, member.id);
  const netWorth = snapshot.wallet + snapshot.bank;
  return `
    <article class="member-action-row">
      <div class="member-action-main">
        <span class="member-action-avatar">${member.avatarUrl ? `<img src="${escapeHtml(member.avatarUrl)}" alt="">` : escapeHtml(member.displayName[0] || "?")}</span>
        <div>
          <strong>${escapeHtml(member.displayName)} ${member.bot ? '<small class="member-bot-label">Bot</small>' : ""}</strong>
          <small>${escapeHtml(member.tag)} &middot; ${escapeHtml(member.id)}</small>
          <div class="mini-stats">
            <span>Wallet ${snapshot.wallet.toLocaleString()}</span>
            <span>Bank ${snapshot.bank.toLocaleString()}</span>
            <span>Net ${netWorth.toLocaleString()}</span>
          </div>
        </div>
      </div>
      <details class="member-action-details">
        <summary>Edit economy</summary>
        <form method="post" action="/guilds/${guildId}/economy/${escapeHtml(member.id)}/update" class="member-action-form" onsubmit="return confirm('Save economy changes for this member?');">
          <input type="hidden" name="econSearch" value="${escapeHtml(search)}">
          <input type="hidden" name="econAfter" value="${escapeHtml(after)}">
          <div class="field-pair">
            <label>
              Wallet bread
              <input type="number" name="wallet" min="0" max="1000000000000" value="${escapeHtml(snapshot.wallet)}">
            </label>
            <label>
              Bank bread
              <input type="number" name="bank" min="0" max="1000000000000" value="${escapeHtml(snapshot.bank)}">
            </label>
          </div>
          <div class="field-pair">
            ${PANEL_ECONOMY_UPGRADES.map((upgrade) => `
              <label>
                ${escapeHtml(upgrade.name)}
                <input type="number" name="economyUpgrade_${escapeHtml(upgrade.id)}" min="0" max="${escapeHtml(upgrade.maxLevel)}" value="${escapeHtml(Math.max(Math.floor(Number(snapshot.upgrades[upgrade.id]) || 0), 0))}">
              </label>
            `).join("")}
          </div>
          <div class="inline-controls">
            <label class="toggle">
              <input type="checkbox" name="resetDailyClaim">
              <span>Reset daily claim cooldown</span>
            </label>
            <label class="toggle">
              <input type="checkbox" name="resetDailyStreak">
              <span>Reset daily streak</span>
            </label>
            <label class="toggle">
              <input type="checkbox" name="clearEconomyCooldowns">
              <span>Clear gambling, rob, interest, and heist cooldowns</span>
            </label>
          </div>
          <p class="field-help">Stats: ${snapshot.stats.gamesPlayed.toLocaleString()} games, ${snapshot.stats.gamesWon.toLocaleString()} wins, ${snapshot.stats.wagered.toLocaleString()} bread wagered, ${snapshot.stats.profit.toLocaleString()} net profit.</p>
          <button type="submit">Save user economy</button>
        </form>
      </details>
    </article>
  `;
}

async function sendGameRecordAlert(client, channelId, entry, previousTop = null) {
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;

  const description = previousTop
    ? [
        `**${entry.name}** just broke the **${gameLabel(entry.game)}** record.`,
        `New score: **${entry.score.toLocaleString()}**`,
        `Previous record: **${Number(previousTop.score || 0).toLocaleString()}** by **${previousTop.name || "Unknown"}**`,
        `Bread from run: **${Math.floor(Number(entry.bread) || 0).toLocaleString()}**`
      ].join("\n")
    : [
        `**${entry.name}** set the first public **${gameLabel(entry.game)}** record.`,
        `Opening score: **${entry.score.toLocaleString()}**`,
        `Bread from run: **${Math.floor(Number(entry.bread) || 0).toLocaleString()}**`
      ].join("\n");

  const embed = buildPrettyEmbed({
    title: `${gameLabel(entry.game)} Record Broken`,
    description,
    color: 0x14b8a6,
    footer: "Chipkittle game records"
  });

  await channel.send({
    embeds: [embed],
    allowedMentions: { parse: [], roles: [], users: [] }
  }).catch(() => {});
}

function suggestionStaffUserId(config = {}) {
  return String(config.publicSite?.suggestions?.staffUserId || "203025242753335296").replace(/\D/g, "");
}

function suggestionStatusLabel(status = "submitted") {
  return SUGGESTION_STATUS_LABELS[String(status || "submitted")] || SUGGESTION_STATUS_LABELS.submitted;
}

function suggestionStatusClass(status = "submitted") {
  return `suggestion-status suggestion-status-${SUGGESTION_STATUSES.includes(status) ? status : "submitted"}`;
}

function suggestionId() {
  return `sug-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createSuggestionRecord({ source = "website", authorId = "", authorTag = "", authorName = "", title = "", body = "" } = {}) {
  const now = new Date().toISOString();
  return {
    id: suggestionId(),
    source,
    authorId: String(authorId || "").replace(/\D/g, "").slice(0, 22),
    authorTag: String(authorTag || "").trim().slice(0, 80),
    authorName: String(authorName || authorTag || "Anonymous").replace(/\s+/g, " ").trim().slice(0, 80) || "Anonymous",
    title: String(title || "").replace(/\s+/g, " ").trim().slice(0, 90),
    body: String(body || "").replace(/\s+/g, " ").trim().slice(0, 1000),
    status: "submitted",
    createdAt: now,
    updatedAt: now
  };
}

function storedSuggestions(config = {}) {
  return Array.isArray(config.community?.suggestions) ? config.community.suggestions : [];
}

function publicSuggestionPayload(suggestion = {}) {
  return {
    id: suggestion.id,
    source: suggestion.source || "website",
    authorName: suggestion.authorName || suggestion.authorTag || "Anonymous",
    title: suggestion.title || "",
    body: suggestion.body || "",
    status: suggestion.status || "submitted",
    statusLabel: suggestionStatusLabel(suggestion.status),
    createdAt: suggestion.createdAt || ""
  };
}

function buildSuggestionEmbed(suggestion = {}) {
  const description = [
    suggestion.title ? `**${suggestion.title}**` : "",
    suggestion.body || "No suggestion body provided.",
    "",
    `Source: **${suggestion.source === "website" ? "Website" : "Discord"}**`,
    `Status: **${suggestionStatusLabel(suggestion.status)}**`,
    `Author: **${suggestion.authorTag || suggestion.authorName || "Anonymous"}**`
  ].filter(Boolean).join("\n");

  return buildPrettyEmbed({
    title: "New Chipkittle Suggestion",
    description: description.slice(0, 3900),
    color: 0x22c55e,
    footer: `Suggestion ${suggestion.id || "unknown"}`
  });
}

async function sendSuggestionStaffDm(client, config = {}, suggestion = {}) {
  const userId = suggestionStaffUserId(config);
  if (!userId) return null;
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) return null;
  return user.send({
    embeds: [buildSuggestionEmbed(suggestion)],
    allowedMentions: { parse: [], roles: [], users: [] }
  }).catch(() => null);
}

function buildSuggestionStatusEmbed(suggestion = {}, previousStatus = "submitted") {
  return buildPrettyEmbed({
    title: "Suggestion Status Updated",
    description: [
      suggestion.title ? `**${suggestion.title}**` : "**Your suggestion**",
      suggestion.body || "",
      "",
      `Status changed from **${suggestionStatusLabel(previousStatus)}** to **${suggestionStatusLabel(suggestion.status)}**.`
    ].filter(Boolean).join("\n").slice(0, 3900),
    color: 0x22c55e,
    footer: `Suggestion ${suggestion.id || "unknown"}`
  });
}

async function sendSuggestionAuthorStatusDm(client, suggestion = {}, previousStatus = "submitted") {
  const userId = String(suggestion.authorId || "").replace(/\D/g, "");
  if (!userId) return null;
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) return null;
  return user.send({
    embeds: [buildSuggestionStatusEmbed(suggestion, previousStatus)],
    allowedMentions: { parse: [], roles: [], users: [] }
  }).catch(() => null);
}

function normalizeNameModerationText(value = "") {
  const substitutions = {
    "0": "o",
    "1": "i",
    "!": "i",
    "3": "e",
    "4": "a",
    "@": "a",
    "5": "s",
    "$": "s",
    "7": "t"
  };

  return String(value || "")
    .toLowerCase()
    .split("")
    .map((character) => substitutions[character] || character)
    .join("")
    .replace(/[^a-z0-9]/g, "");
}

function blockedLeaderboardTerm(name = "", config = {}) {
  const normalized = normalizeNameModerationText(name);
  if (!normalized) return "";
  const settings = publicGameSettings(config);
  const blockedTerms = [...BUILT_IN_BLOCKED_LEADERBOARD_TERMS, ...settings.blockedLeaderboardWords];
  return blockedTerms.find((term) => normalized.includes(normalizeNameModerationText(term))) || "";
}

function blockedSuggestionTerm(payload = {}, config = {}) {
  return ["name", "title", "body", "suggestion"]
    .map((key) => blockedLeaderboardTerm(payload?.[key], config))
    .find(Boolean) || "";
}

function blockedProfileTerm(payload = {}, config = {}) {
  const values = ["displayName", "title", "pronouns", "favoriteArtifact", "quote", "bio"]
    .map((key) => String(payload?.[key] || ""));
  const normalizedValues = values.map(normalizeNameModerationText);
  const configuredTerms = publicGameSettings(config).blockedLeaderboardWords || [];
  const blockedTerms = [...new Set([...STRICT_PROFILE_BLOCKED_TERMS, ...configuredTerms])];
  const matchedTerm = blockedTerms.find((term) => normalizedValues.some((value) => value.includes(normalizeNameModerationText(term))));
  if (matchedTerm) return matchedTerm;
  if (values.some((value) => /https?:\/\/|discord\.gg|discord\.com\/invite/i.test(value))) return "links";
  if (values.some((value) => /@everyone|@here|<@&?\d+>|<#\d+>/i.test(value))) return "mentions";
  if (values.some((value) => /(.)\1{9,}/i.test(value))) return "spam";
  if (values.some((value) => {
    const letters = value.replace(/[^a-z]/gi, "");
    return letters.length >= 18 && letters === letters.toUpperCase();
  })) return "excessive caps";
  return "";
}

function readGameLeaderboard() {
  try {
    const parsed = JSON.parse(fs.readFileSync(leaderboardPath(), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function allPublicLeaderboardEntries(entries = []) {
  const grouped = new Map();
  return entries
    .map((entry) => ({
      game: cleanGameId(entry.game),
      name: cleanLeaderboardName(entry.name),
      score: Math.max(Math.floor(Number(entry.score) || 0), 0),
      bread: Math.max(Math.floor(Number(entry.bread) || 0), 0),
      createdAt: String(entry.createdAt || "")
    }))
    .filter((entry) => entry.score > 0)
    .reduce((accumulator, entry) => {
      const bucket = accumulator.get(entry.game) || [];
      bucket.push(entry);
      accumulator.set(entry.game, bucket);
      return accumulator;
    }, grouped);
}

function publicLeaderboardEntries(entries = [], gameId = "dash", settings = DEFAULT_PUBLIC_GAME_SETTINGS) {
  const grouped = allPublicLeaderboardEntries(entries);
  return (grouped.get(cleanGameId(gameId)) || [])
    .sort((a, b) => b.score - a.score || b.bread - a.bread)
    .slice(0, publicGameSettings({ publicSite: { games: settings } }).maxLeaderboardEntriesPerGame);
}

function publicLeaderboardFileEntries(entries = [], settings = DEFAULT_PUBLIC_GAME_SETTINGS) {
  return [...allPublicLeaderboardEntries(entries).values()]
    .flatMap((bucket) => bucket.sort((a, b) => b.score - a.score || b.bread - a.bread));
}

function writeGameLeaderboard(entries = [], settings = DEFAULT_PUBLIC_GAME_SETTINGS) {
  const filePath = leaderboardPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(`${filePath}.tmp`, `${JSON.stringify(publicLeaderboardFileEntries(entries, settings), null, 2)}\n`, "utf8");
  fs.renameSync(`${filePath}.tmp`, filePath);
}

function gameLabel(gameId = "") {
  const labels = {
    dash: "Chipkittle Dash",
    runner: "Ritual Runner",
    mines: "Bread Mines",
    catch: "Bread Catch",
    loaf: "Loaf Hopper",
    blitz: "Bread Blitz"
  };
  return labels[cleanGameId(gameId)] || "Chipkittle Dash";
}

function deleteGameLeaderboardEntry(index, gameId = "dash", settings = DEFAULT_PUBLIC_GAME_SETTINGS) {
  const entries = publicLeaderboardFileEntries(readGameLeaderboard(), settings);
  const target = publicLeaderboardEntries(entries, gameId, settings)[index];
  if (!target) return entries;
  const targetIndex = entries.findIndex((entry) =>
    entry.game === target.game &&
    entry.name === target.name &&
    entry.score === target.score &&
    entry.bread === target.bread &&
    entry.createdAt === target.createdAt
  );
  if (targetIndex >= 0) entries.splice(targetIndex, 1);
  writeGameLeaderboard(entries, settings);
  return entries;
}

function gameLeaderboardControls(guildId = "", settings = DEFAULT_PUBLIC_GAME_SETTINGS) {
  const fileEntries = publicLeaderboardFileEntries(readGameLeaderboard(), settings);
  const gameIds = ["dash", "runner", "mines", "catch", "loaf", "blitz"];
  return `
    <section class="panel-section leaderboard-admin">
      <div class="section-heading">
        <h2>Game Leaderboards</h2>
        <p>Remove saved scores from each public game leaderboard.</p>
      </div>
      ${
        fileEntries.length
          ? gameIds
              .map((gameId) => {
                const entries = publicLeaderboardEntries(fileEntries, gameId, settings);
                if (!entries.length) return "";
                return `
                  <div class="leaderboard-admin-group">
                    <h3>${escapeHtml(gameLabel(gameId))}</h3>
                    <div class="leaderboard-admin-list">
                      ${entries
                        .map(
                          (entry, index) => `
                            <div class="leaderboard-admin-row">
                              <div>
                                <strong>${escapeHtml(entry.name)}</strong>
                                <small>Score ${escapeHtml(entry.score)} / Bread ${escapeHtml(entry.bread)}</small>
                              </div>
                              <form method="post" action="/admin/game-leaderboard/delete?guildId=${encodeURIComponent(guildId)}&game=${encodeURIComponent(gameId)}" class="inline-form">
                                <input type="hidden" name="index" value="${index}">
                                <button type="submit" class="danger-button">Remove</button>
                              </form>
                            </div>`
                        )
                        .join("")}
                    </div>
                  </div>
                `;
              })
              .join("")
          : '<p class="muted">No game scores are saved yet.</p>'
      }
    </section>
  `;
}

function parseConfigForm(body, section = "general") {
  const currentSection = normalizeSettingsSection(section);
  const aiChannelIds = arrayFromFormValue(body.aiChannelIds);
  const aiBlacklistedChannelIds = arrayFromFormValue(body.aiBlacklistedChannelIds);
  const aiAllowedRoleIds = arrayFromFormValue(body.aiAllowedRoleIds);
  const reviewerRoleIds = arrayFromFormValue(body.applicationReviewerRoleIds);
  const blockedRoleIds = arrayFromFormValue(body.applicationBlockedRoleIds);
  const commandOverrides = Object.fromEntries(
    Object.entries(body)
      .filter(([key]) => key.startsWith("commandRole_"))
      .map(([key, value]) => [key.replace("commandRole_", ""), arrayFromFormValue(value).map(String)])
      .filter(([, roleIds]) => roleIds.length)
  );
  const commandDisabled = Object.fromEntries(
    Object.entries(body)
      .filter(([key, value]) => key.startsWith("commandDisabled_") && value === "on")
      .map(([key]) => [key.replace("commandDisabled_", ""), true])
  );
  const commandChannelAllowlist = Object.fromEntries(
    Object.entries(body)
      .filter(([key]) => key.startsWith("commandChannel_"))
      .map(([key, value]) => [key.replace("commandChannel_", ""), arrayFromFormValue(value).map(String)])
      .filter(([, channelIds]) => channelIds.length)
  );
  const disabledCategories = Object.fromEntries(
    Object.entries(body)
      .filter(([key, value]) => key.startsWith("commandCategoryDisabled_") && value === "on")
      .map(([key]) => [key.replace("commandCategoryDisabled_", ""), true])
  );
  const channelCommandAllowlist = Object.fromEntries(
    Object.entries(body)
      .filter(([key]) => key.startsWith("channelOnlyCommand_"))
      .map(([key, value]) => [key.replace("channelOnlyCommand_", ""), arrayFromFormValue(value).map(String)])
      .filter(([, commandNames]) => commandNames.length)
  );
  const channelCategoryAllowlist = Object.fromEntries(
    Object.entries(body)
      .filter(([key]) => key.startsWith("channelOnlyCategory_"))
      .map(([key, value]) => [key.replace("channelOnlyCategory_", ""), arrayFromFormValue(value).map(String)])
      .filter(([, categories]) => categories.length)
  );
  switch (currentSection) {
    case "general":
      return {
        prefix: String(body.prefix || "!").trim().slice(0, 5) || "!",
        welcome: {
          enabled: body.welcomeEnabled === "on",
          channelId: String(body.welcomeChannelId || ""),
          message: String(body.welcomeMessage || "").trim().slice(0, 500)
        },
        autoRoleId: String(body.autoRoleId || "")
      };
    case "members":
      return {
        publicSite: {
          members: parseMemberDirectory(body.publicMembers),
          profileEditor: {
            enabled: body.profileEditorEnabled === "on",
            allowedRoleIds: arrayFromFormValue(body.profileEditorAllowedRoleIds).map(String)
          }
        }
      };
    case "moderation":
      return {
        automod: {
          enabled: body.automodEnabled === "on",
          blockedWords: String(body.blockedWords || "")
            .split(",")
            .map((word) => word.trim())
            .filter(Boolean)
            .slice(0, 50),
          deleteInvites: body.deleteInvites === "on",
          deleteLinks: body.deleteLinks === "on"
        },
        moderation: {
          logChannelId: String(body.logChannelId || "")
        }
      };
    case "ai":
      return {
        ai: {
          enabled: body.aiEnabled === "on",
          channelIds: aiChannelIds.map(String),
          blacklistedChannelIds: aiBlacklistedChannelIds.map(String),
          mode: String(body.aiMode || "").toLowerCase() === "evil" ? "evil" : "normal",
          model: String(body.aiModel || "").trim().slice(0, 80),
          apiCooldownSeconds: Math.min(Math.max(Number(body.aiApiCooldownSeconds) || 0, 0), 3600),
          imageCooldownSeconds: Math.min(Math.max(Number(body.aiImageCooldownSeconds) || 0, 0), 7200),
          allowedRoleIds: aiAllowedRoleIds.map(String),
          channelPersonalities: parseAiChannelPersonalities(body.aiChannelPersonalities),
          chaosLevel: Math.min(Math.max(Math.floor(Number(body.aiChaosLevel) || 3), 1), 10),
          loreStrictness: ["loose", "balanced", "strict"].includes(String(body.aiLoreStrictness || "").toLowerCase())
            ? String(body.aiLoreStrictness).toLowerCase()
            : "balanced",
          responseLength: ["short", "normal", "long"].includes(String(body.aiResponseLength || "").toLowerCase())
            ? String(body.aiResponseLength).toLowerCase()
            : "normal",
          monthlyBudget: Math.min(Math.max(Math.floor(Number(body.aiMonthlyBudget) || 0), 0), 50000000),
          replyToMentions: body.aiReplyToMentions === "on",
          personality: String(body.aiPersonality || "").trim().slice(0, 1200)
        }
      };
    case "applications":
      return {
        applications: {
          enabled: body.applicationsEnabled === "on",
          channelId: String(body.applicationChannelId || ""),
          threadChannelId: String(body.applicationThreadChannelId || ""),
          categoryId: String(body.applicationCategoryId || ""),
          reviewerRoleIds: reviewerRoleIds.map(String),
          approvedRoleId: String(body.applicationApprovedRoleId || ""),
          blockedRoleIds: blockedRoleIds.map(String),
          cooldownMinutes: Math.min(Math.max(Number(body.applicationCooldownMinutes) || 0, 0), 10080),
          questions: String(body.applicationQuestions || "")
            .split("\n")
            .map((question) => question.trim())
            .filter(Boolean)
            .slice(0, 10)
        }
      };
    case "games":
      return {
        publicSite: {
          games: {
            blockedLeaderboardWords: normalizeBlockedWordList(body.blockedLeaderboardWords),
            maxLeaderboardEntriesPerGame: Math.min(Math.max(Number(body.maxLeaderboardEntriesPerGame) || DEFAULT_PUBLIC_GAME_SETTINGS.maxLeaderboardEntriesPerGame, 1), 50),
            maxLeaderboardScore: Math.min(Math.max(Number(body.maxLeaderboardScore) || DEFAULT_PUBLIC_GAME_SETTINGS.maxLeaderboardScore, 1), 1000000),
            maxLeaderboardBread: Math.min(Math.max(Number(body.maxLeaderboardBread) || DEFAULT_PUBLIC_GAME_SETTINGS.maxLeaderboardBread, 0), 1000000),
            maxClaimBreadPerRun: Math.min(Math.max(Number(body.maxClaimBreadPerRun) || DEFAULT_PUBLIC_GAME_SETTINGS.maxClaimBreadPerRun, 0), 1000000),
            recordAlertChannelId: String(body.recordAlertChannelId || "")
          }
        }
      };
    case "economy":
      return {
        economy: {
          settings: parseEconomySettings(body)
        }
      };
    case "community":
      return {
        community: {
          artifacts: parseArtifactDirectory(body.communityArtifacts),
          rituals: {
            currentEvent: String(body.currentEvent || "").trim().slice(0, 220),
            seasonalMessage: String(body.seasonalMessage || "").trim().slice(0, 220),
            nextTrial: String(body.nextTrial || "").trim().slice(0, 120)
          }
        }
      };
    case "permissions":
      return {
        commandRoles: {
          overrides: commandOverrides,
          disabled: commandDisabled,
          channelAllowlist: commandChannelAllowlist,
          disabledCategories,
          channelCommandAllowlist,
          channelCategoryAllowlist
        }
      };
    default:
      return {};
  }
}

function resolveRestoreGuildPayload(payload, guildId) {
  if (!payload || typeof payload !== "object") return payload;
  if (payload.guilds && typeof payload.guilds === "object") {
    return payload.guilds[guildId] || Object.values(payload.guilds)[0] || {};
  }
  if (payload[guildId] && typeof payload[guildId] === "object") {
    return payload[guildId];
  }
  return payload;
}

function definedEntries(object = {}) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function restorePartialForScope(scope, payload, guildId) {
  const source = sanitizeConfigForRestore(resolveRestoreGuildPayload(payload, guildId) || {});
  switch (String(scope || "").toLowerCase()) {
    case "config":
      return source;
    case "community":
      return {
        community: source.community || source
      };
    case "moderation":
      return definedEntries({
        moderation: source.moderation || source,
        community: source.community ? { ...(source.community || {}) } : undefined
      });
    case "applications":
      return {
        applications: source.applications || source
      };
    case "public":
      return definedEntries({
        publicSite: source.publicSite || source,
        community: definedEntries({
          artifacts: source.artifacts || source.community?.artifacts,
          rituals: source.rituals || source.community?.rituals
        })
      });
    default:
      return null;
  }
}

function layout({ title, body, user, flash = "" }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <script>
    (() => {
      const readSetting = (key, fallback) => {
        try {
          return localStorage.getItem(key) || fallback;
        } catch {
          return fallback;
        }
      };
      const theme = readSetting("chipkittlePanelTheme", "green");
      const storedMode = readSetting("chipkittlePanelMode", "");
      let mode = storedMode || "dark";
      try {
        if (localStorage.getItem("chipkittlePanelModeVersion") !== "2" && storedMode === "light") {
          mode = "dark";
        }
      } catch {}
      document.documentElement.dataset.panelTheme = theme;
      document.documentElement.dataset.panelMode = mode;
    })();
  </script>
  <link rel="icon" type="image/png" href="/notativelogotransparent.png">
  <link rel="stylesheet" href="/styles.css">
</head>
<body class="panel-ui">
  <div class="app-shell">
    <header class="topbar">
      <div class="topbar-brand">
        <a class="brand brand-inline" href="https://chipkittle.com" target="_blank" rel="noreferrer">
          <span class="brand-mark"><img src="/chipkittle-logo.svg" alt="Chipkittle logo"></span>
          <span>
            <strong>Chipkittle Panel</strong>
            <small>Private control room</small>
          </span>
        </a>
        <div class="topbar-status">
          <span class="status-dot"></span>
          <span>Live</span>
        </div>
      </div>
      <nav class="topbar-nav">
        <label class="theme-picker">
          <span>Theme</span>
          <select data-theme-picker aria-label="Panel color theme">
            <option value="green">Green</option>
            <option value="blue">Blue</option>
            <option value="red">Red</option>
            <option value="purple">Purple</option>
            <option value="gold">Gold</option>
          </select>
        </label>
        <button type="button" class="mode-toggle" data-mode-toggle aria-label="Toggle panel light or dark mode">Dark mode</button>
        <a href="/">Panel</a>
        <a href="https://chipkittle.com" target="_blank" rel="noreferrer">Website</a>
        ${user ? '<a href="/account">My account</a>' : ""}
        ${user ? '<a href="/commits">Commits</a>' : ""}
        ${user ? '<a href="/logout">Sign out</a>' : '<a href="/login">Sign in</a>'}
      </nav>
    </header>
    <main class="content content-wide panel-content">
      ${flash ? `<div class="flash">${escapeHtml(flash)}</div>` : ""}
      ${body}
    </main>
  </div>
  <script>
    (() => {
      const picker = document.querySelector("[data-theme-picker]");
      if (!picker) return;
      const current = document.documentElement.dataset.panelTheme || "green";
      picker.value = current;
      picker.addEventListener("change", () => {
        const next = picker.value || "green";
        document.documentElement.dataset.panelTheme = next;
        try {
          localStorage.setItem("chipkittlePanelTheme", next);
        } catch {}
      });
    })();
    (() => {
      const button = document.querySelector("[data-mode-toggle]");
      if (!button) return;
      const setMode = (mode) => {
        const next = mode === "dark" ? "dark" : "light";
        document.documentElement.dataset.panelMode = next;
        try {
          localStorage.setItem("chipkittlePanelMode", next);
          localStorage.setItem("chipkittlePanelModeVersion", "2");
        } catch {}
        button.textContent = next === "dark" ? "Light mode" : "Dark mode";
        button.setAttribute("aria-pressed", next === "dark" ? "true" : "false");
      };
      setMode(document.documentElement.dataset.panelMode || "dark");
      button.addEventListener("click", () => {
        setMode(document.documentElement.dataset.panelMode === "dark" ? "light" : "dark");
      });
    })();
    (() => {
      const filter = document.querySelector("[data-nav-filter]");
      const links = [...document.querySelectorAll("[data-nav-link]")];
      if (!filter || !links.length) return;
      const groups = [...document.querySelectorAll("[data-nav-group]")];
      filter.addEventListener("input", () => {
        const query = filter.value.trim().toLowerCase();
        links.forEach((link) => {
          const haystack = String(link.dataset.navText || link.textContent || "").toLowerCase();
          link.hidden = Boolean(query) && !haystack.includes(query);
        });
        groups.forEach((group) => {
          group.hidden = !group.querySelector("[data-nav-link]:not([hidden])");
        });
      });
    })();
  </script>
</body>
</html>`;
}

function oauthExpectedRedirect(publicUrl = "") {
  const base = publicUrl || "https://panel.chipkittle.com";
  try {
    return new URL("/auth/discord/callback", base).toString();
  } catch {
    return "https://panel.chipkittle.com/auth/discord/callback";
  }
}

function oauthConfigRows({ publicUrl = "", clientId = "", discordClientSecret = "", redirectUri = "" } = {}) {
  const rows = [
    ["PUBLIC_URL", publicUrl || "missing"],
    ["CLIENT_ID", clientId || "missing"],
    ["DISCORD_CLIENT_SECRET", discordClientSecret ? "set" : "missing"],
    ["Discord redirect URI", redirectUri || oauthExpectedRedirect(publicUrl)]
  ];
  return rows.map(([label, value]) => `
    <div class="oauth-check-row">
      <span>${escapeHtml(label)}</span>
      <code>${escapeHtml(value)}</code>
    </div>
  `).join("");
}

function loginPage(error = "", discordUrl = "", oauthInfo = {}) {
  const redirectUri = oauthInfo.redirectUri || oauthExpectedRedirect(oauthInfo.publicUrl);
  return layout({
    title: "Sign in",
    body: `
      <section class="login-panel">
        <div>
          <p class="eyebrow">Discord access</p>
          <h1>Sign in with Discord.</h1>
          <p class="muted">The panel now uses Discord OAuth only. Your Discord account must already have a Chipkittle panel access grant.</p>
        </div>
        <div class="stack">
          ${error ? `<p class="form-error">${escapeHtml(error)}</p>` : ""}
          ${discordUrl
            ? `<a class="primary-link oauth-login-button" href="${escapeHtml(discordUrl)}">Continue with Discord</a>`
            : '<p class="form-error">Discord OAuth is not configured. Set DISCORD_CLIENT_SECRET and restart the panel.</p>'}
          <p class="field-help">If you were granted access before, sign in with the same Discord account. Password logins are disabled.</p>
          <a class="primary-link secondary-link" href="/recovery">Use root recovery code</a>
        </div>
      </section>
      <section class="panel-section oauth-diagnostics">
        <div class="section-heading">
          <h2>OAuth Setup Check</h2>
          <p>Discord must have this exact redirect URI saved in the Developer Portal. Tiny differences count.</p>
        </div>
        <div class="oauth-redirect-copy">
          <code>${escapeHtml(redirectUri)}</code>
        </div>
        <div class="oauth-check-list">
          ${oauthConfigRows({ ...oauthInfo, redirectUri })}
        </div>
        <p class="field-help">Developer Portal path: Application &rarr; OAuth2 &rarr; Redirects. Save the redirect above, then restart the panel after changing <code>.env</code>.</p>
      </section>
    `
  });
}

function inviteUrl(clientId) {
  if (!clientId) return "";

  const permissions = "361048837200";
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&permissions=${permissions}&scope=bot%20applications.commands`;
}

function accountFlash(code = "") {
  const messages = {
    "password-invalid": "Password must be at least 12 characters and match the confirmation.",
    "password-updated": "Recovery password updated. Discord OAuth is still the only normal sign-in method.",
    "session-revoked": "Session revoked.",
    "all-sessions-revoked": "All other panel sessions were signed out."
  };
  return messages[String(code || "")] || "";
}

function formatAccessExpiry(expiresAt = "") {
  if (!expiresAt) return { label: "Never", warning: "" };
  const time = Date.parse(expiresAt);
  if (!Number.isFinite(time)) return { label: expiresAt, warning: "" };
  const ms = time - Date.now();
  if (ms <= 0) return { label: expiresAt, warning: "Expired" };
  const days = Math.ceil(ms / (24 * 60 * 60 * 1000));
  return {
    label: expiresAt,
    warning: days <= 7 ? `Expires in ${days} day${days === 1 ? "" : "s"}` : ""
  };
}

function recoveryPage(error = "", success = "") {
  return layout({
    title: "Root recovery",
    body: `
      <section class="login-panel">
        <div>
          <p class="eyebrow">Emergency access</p>
          <h1>Use a backup root recovery code.</h1>
          <p class="muted">This grants root access to the Discord ID below, then you still sign in with Discord OAuth.</p>
        </div>
        <form method="post" action="/recovery" class="stack">
          ${error ? `<p class="form-error">${escapeHtml(error)}</p>` : ""}
          ${success ? `<p class="flash">${escapeHtml(success)}</p>` : ""}
          <label>
            Discord user ID
            <input name="discordId" inputmode="numeric" autocomplete="off" required>
          </label>
          <label>
            Recovery code
            <input name="code" autocomplete="one-time-code" required>
          </label>
          <button type="submit">Redeem Recovery Code</button>
          <a class="primary-link secondary-link" href="/login">Back to Discord sign in</a>
        </form>
      </section>
    `
  });
}

function accountPage({ panelUser, sessions = [], currentSessionId = "", flash = "", isRoot = false }) {
  const expiry = formatAccessExpiry(panelUser.expiresAt || "");
  return layout({
    title: "My account",
    user: true,
    flash,
    body: `
      <section class="panel-section">
        <div class="section-heading">
          <h2>My Account</h2>
          <p>Discord OAuth is the required sign-in method. Recovery passwords are kept only for account administration and future recovery workflows.</p>
        </div>
        ${expiry.warning ? `<p class="form-error">${escapeHtml(expiry.warning)}. Ask a root user to extend access if you still need the panel.</p>` : ""}
        <div class="stats-grid">
          <article class="stat-card"><strong>${escapeHtml(panelUser.username || panelUser.userId)}</strong><span>Discord account</span></article>
          <article class="stat-card"><strong>${escapeHtml(panelAccessLabel(panelUser.level))}</strong><span>Access level</span></article>
          <article class="stat-card"><strong>${escapeHtml(panelUser.lastLoginAt || "Unknown")}</strong><span>Last login</span></article>
          <article class="stat-card"><strong>${escapeHtml(expiry.label)}</strong><span>Access expires</span></article>
          <article class="stat-card"><strong>${sessions.length}</strong><span>Tracked sessions</span></article>
        </div>
      </section>
      <section class="panel-section">
        <div class="section-heading">
          <h2>Change Recovery Password</h2>
          <p>This does not enable password login. Sign-in remains Discord-only.</p>
        </div>
        <form method="post" action="/account/password" class="field-pair">
          <label>
            New recovery password
            <input type="password" name="password" autocomplete="new-password" minlength="12" required>
          </label>
          <label>
            Confirm password
            <input type="password" name="confirmPassword" autocomplete="new-password" minlength="12" required>
          </label>
          <button type="submit">Update Password</button>
        </form>
      </section>
      <section class="panel-section">
        <div class="section-heading">
          <h2>Sessions</h2>
          <p>Review active browser sessions for your account.</p>
        </div>
        ${isRoot ? `<form method="post" action="/admin/sessions/logout-all" onsubmit="return confirm('Sign out every other panel session?');"><button type="submit" class="danger-button">Log out all sessions</button></form>` : ""}
        <div class="member-action-list">
          ${sessions.map((sessionEntry) => `
            <article class="access-user-row">
              <div>
                <strong>${sessionEntry.id === currentSessionId ? "Current session" : "Panel session"}</strong>
                <small>${escapeHtml(sessionEntry.userAgent || "unknown browser")}</small>
                <small>Created ${escapeHtml(sessionEntry.createdAt || "unknown")} &middot; Last seen ${escapeHtml(sessionEntry.lastSeenAt || "unknown")}</small>
              </div>
              ${sessionEntry.id !== currentSessionId
                ? `<form method="post" action="/account/sessions/${encodeURIComponent(sessionEntry.id)}/revoke"><button type="submit" class="secondary-button">Revoke</button></form>`
                : '<span class="muted">Active now</span>'}
            </article>
          `).join("") || '<p class="muted">No active sessions are currently tracked.</p>'}
        </div>
      </section>
    `
  });
}

function dashboardPage({ guilds, client, clientId, ai, commandList, flash }) {
  const botInviteUrl = inviteUrl(clientId);

  return layout({
    title: "Bot status",
    user: true,
    flash,
    body: `
      <section class="page-heading">
        <p class="eyebrow">Control room</p>
        <h1>Bot Status</h1>
        <p class="muted">This panel is set up for one Discord server. Invite the bot, then refresh this page to configure it.</p>
        ${botInviteUrl ? `<a class="primary-link" href="${botInviteUrl}" target="_blank" rel="noreferrer">Invite bot</a>` : ""}
      </section>
      <section class="metrics">
        <div>
          <span>${escapeHtml(client.user?.tag || "Offline")}</span>
          <strong>Bot identity</strong>
        </div>
        <div>
          <span>${guilds.length}</span>
          <strong>Connected server</strong>
        </div>
        <div>
          <span>${Math.round(process.uptime() / 60)}m</span>
          <strong>Panel uptime</strong>
        </div>
        <div>
          <span>${commandList.length}</span>
          <strong>Bot commands</strong>
        </div>
        <div>
          <span>${ai.enabled ? "Ready" : "No key"}</span>
          <strong>Chipkittle AI</strong>
        </div>
      </section>
      ${updateControls()}
      <section class="guild-list">
        <p class="empty">The bot is not connected to a Discord server yet, or it is still starting up.</p>
      </section>
    `
  });
}

function commitsPage({ commits, error = "" }) {
  return layout({
    title: "Commits",
    user: true,
    body: `
      <section class="page-heading">
        <p class="eyebrow">GitHub history</p>
        <h1>Recent Commits</h1>
        <p class="muted">Latest changes available in this VPS checkout.</p>
      </section>
      <section class="panel-section">
        ${
          error
            ? `<p class="form-error">${escapeHtml(error)}</p>`
            : commits.length
              ? `<div class="commit-list">
                  ${commits
                    .map(
                      (commit) => `
                        <a class="commit-row" href="${commitUrl(commit.hash)}" target="_blank" rel="noreferrer">
                          <div>
                            <strong>${escapeHtml(commit.subject)}</strong>
                            <small>${escapeHtml(displayCommitAuthor(commit.author))} on ${escapeHtml(commit.date)}</small>
                          </div>
                          <code>${escapeHtml(commit.shortHash)}</code>
                        </a>`
                    )
                    .join("")}
                </div>`
              : '<p class="empty">No commits found.</p>'
        }
      </section>
    `
  });
}

function optionList(options, currentValue, emptyLabel) {
  return [
    `<option value="">${escapeHtml(emptyLabel)}</option>`,
    ...options.map(
      (option) =>
        `<option value="${option.id}" ${selected(currentValue, option.id)}>${escapeHtml(option.name)}</option>`
    )
  ].join("");
}

function commandCatalog(commandList, prefix) {
  const byCategory = new Map();
  for (const command of commandList) {
    const category = command.category || "Other";
    byCategory.set(category, [...(byCategory.get(category) || []), command]);
  }

  return [...byCategory.entries()]
    .map(
      ([category, commands]) => `
        <details class="command-group">
          <summary>${escapeHtml(category)} <span>${commands.length}</span></summary>
          <div class="command-list">
            ${commands
              .map(
                (command) => `
                  <div>
                    <strong>/${escapeHtml(command.name)}</strong>
                    <small>${escapeHtml(command.description)} Legacy text: ${escapeHtml(prefix)}${escapeHtml(command.name)}</small>
                  </div>`
              )
              .join("")}
          </div>
        </details>`
    )
    .join("");
}

function commandCategories(commandList) {
  return [...new Set(commandList.map((command) => command.category || "Other"))].sort((a, b) => a.localeCompare(b));
}

function channelCheckboxes(channels, selectedIds, name = "aiChannelIds") {
  const selectedSet = new Set(selectedIds || []);
  return channels
    .map(
      (channel) => `
        <label class="toggle">
          <input type="checkbox" name="${name}" value="${channel.id}" ${isChecked(selectedSet.has(channel.id))}>
          <span>#${escapeHtml(channel.name)}</span>
        </label>`
    )
    .join("");
}

function commandCheckboxes(commandList, selectedNames, name, panelUser = null) {
  const canEditGrantAccess = panelAccessAtLeast(panelUser?.level || "root", "root");
  const selectedSet = new Set((selectedNames || []).map(String));
  return commandList
    .filter((command) => canEditGrantAccess || command.name !== "grantaccess")
    .map(
      (command) => `
        <label class="toggle">
          <input type="checkbox" name="${name}" value="${command.name}" ${isChecked(selectedSet.has(command.name))}>
          <span>${escapeHtml(command.name)}</span>
        </label>`
    )
    .join("");
}

function categoryCheckboxes(categories, selectedCategories, name) {
  const selectedSet = new Set((selectedCategories || []).map(String));
  return categories
    .map(
      (category) => `
        <label class="toggle">
          <input type="checkbox" name="${name}" value="${escapeHtml(category)}" ${isChecked(selectedSet.has(category))}>
          <span>${escapeHtml(category)}</span>
        </label>`
    )
    .join("");
}

function roleCheckboxes(roles, selectedIds, name) {
  const selectedSet = new Set(selectedIds || []);
  return roles
    .map(
      (role) => `
        <label class="toggle">
          <input type="checkbox" name="${name}" value="${role.id}" ${isChecked(selectedSet.has(role.id))}>
          <span>${escapeHtml(role.name)}</span>
        </label>`
    )
    .join("");
}

function categoryAccessRules(commandList, commandRoles = {}) {
  const disabledCategories = commandRoles?.disabledCategories || {};
  return commandCategories(commandList)
    .map(
      (category) => `
        <label class="toggle">
          <input type="checkbox" name="commandCategoryDisabled_${escapeHtml(category)}" ${isChecked(Boolean(disabledCategories[category]))}>
          <span>Disable <strong>${escapeHtml(category)}</strong> commands</span>
        </label>`
    )
    .join("");
}

function channelCommandRules(commandList, channels, commandRoles = {}, panelUser = null) {
  const allowedCommandsByChannel = commandRoles?.channelCommandAllowlist || {};
  const allowedCategoriesByChannel = commandRoles?.channelCategoryAllowlist || {};
  const categories = commandCategories(commandList);

  return channels
    .map(
      (channel) => `
        <details class="permission-row">
          <summary>
            <span>#${escapeHtml(channel.name)}</span>
            <small>Only selected commands and categories can run here. Leave both empty to allow all commands.</small>
          </summary>
          <div class="permission-rule-block">
            <p class="field-help">Allowed commands in #${escapeHtml(channel.name)}</p>
            <div class="checkbox-grid compact">
              ${commandCheckboxes(commandList, allowedCommandsByChannel[channel.id] || [], `channelOnlyCommand_${channel.id}`, panelUser)}
            </div>
          </div>
          <div class="permission-rule-block">
            <p class="field-help">Allowed categories in #${escapeHtml(channel.name)}</p>
            <div class="checkbox-grid compact">
              ${categoryCheckboxes(categories, allowedCategoriesByChannel[channel.id] || [], `channelOnlyCategory_${channel.id}`)}
            </div>
          </div>
        </details>`
    )
    .join("");
}

function commandRoleAccess(commandList, roles, channels, commandRoles = {}, panelUser = null) {
  const canEditGrantAccess = panelAccessAtLeast(panelUser?.level || "root", "root");
  const overrides = commandRoles?.overrides || {};
  const disabled = commandRoles?.disabled || {};
  const channelAllowlist = commandRoles?.channelAllowlist || {};
  const byCategory = new Map();
  for (const command of commandList) {
    if (command.name === "grantaccess" && !canEditGrantAccess) continue;
    const category = command.category || "Other";
    byCategory.set(category, [...(byCategory.get(category) || []), command]);
  }

  return [...byCategory.entries()]
    .map(
      ([category, commands]) => `
        <details class="permission-category">
          <summary>
            <span>${escapeHtml(category)}</span>
            <small>${commands.length} command${commands.length === 1 ? "" : "s"}</small>
          </summary>
          <div class="permission-category-body">
            ${commands
              .map(
                (command) => `
                  <details class="permission-row">
                    <summary>
                      <span>${escapeHtml(command.name)}</span>
                      <small>${escapeHtml(command.description || "No description.")}</small>
                    </summary>
                    <div class="permission-rule-block">
                      <label class="toggle">
                        <input type="checkbox" name="commandDisabled_${command.name}" ${isChecked(Boolean(disabled[command.name]))}>
                        <span>Disable this command entirely</span>
                      </label>
                    </div>
                    <div class="permission-rule-block">
                      <p class="field-help">If no channels are selected below, this command can run anywhere. If you select channels, it will only run there.</p>
                      <div class="checkbox-grid compact">
                        ${channelCheckboxes(channels, channelAllowlist[command.name] || [], `commandChannel_${command.name}`)}
                      </div>
                    </div>
                    <div class="permission-rule-block">
                      <p class="field-help">Role overrides bypass the Discord permission check for this command.</p>
                      <div class="checkbox-grid compact">
                        ${roleCheckboxes(roles, overrides[command.name] || [], `commandRole_${command.name}`)}
                      </div>
                    </div>
                  </details>`
              )
              .join("")}
          </div>
        </details>`
    )
    .join("");
}

function panelAccessWorkspace(guildId, config = {}, panelUser = null) {
  const users = Object.entries(panelAccessUsers(config))
    .filter(([, entry]) => !entry?.revokedAt)
    .sort((a, b) => String(a[1]?.username || "").localeCompare(String(b[1]?.username || "")));
  const actorLevel = panelUser?.level || "root";
  const canRoot = panelAccessAtLeast(panelUser?.level || "root", "root");
  return `
    <section class="panel-section">
      <div class="section-heading">
        <h2>Panel Users</h2>
        <p>Panel access is granted from Discord with <code>!grantaccess @user accesslevel</code>. Sign-in is Discord OAuth only.</p>
      </div>
      <div class="access-tier-grid">
        ${PANEL_ACCESS_LEVELS.map((level) => `
          <article class="access-tier-card">
            <strong>${escapeHtml(panelAccessLabel(level))}</strong>
            <p>${escapeHtml(panelTierDescription(level))}</p>
          </article>
        `).join("")}
      </div>
      ${canRoot ? `
        <div class="dashboard-grid">
          <form method="post" action="/guilds/${guildId}/panel-access/emergency-lockout" class="sub-panel">
            <div class="section-heading">
              <h2>Emergency Lockout</h2>
              <p>When enabled, only root users can sign in.</p>
            </div>
            <label class="toggle">
              <input type="checkbox" name="emergencyLockout" ${isChecked(Boolean(config.panelAccess?.emergencyLockout))}>
              <span>Root-only emergency lockout</span>
            </label>
            <button type="submit">Save Lockout</button>
          </form>
          <form method="post" action="/guilds/${guildId}/panel-access/recovery-codes" class="sub-panel" onsubmit="return confirm('Generate new backup root recovery codes?');">
            <div class="section-heading">
              <h2>Backup Root Recovery Codes</h2>
              <p>Generate one-time emergency codes. Store the revealed codes somewhere private.</p>
            </div>
            <p class="muted">${escapeHtml((config.panelAccess?.recoveryCodes || []).length)} recovery code hash${(config.panelAccess?.recoveryCodes || []).length === 1 ? "" : "es"} saved.</p>
            <button type="submit">Generate Codes</button>
          </form>
        </div>
        <form method="post" action="/guilds/${guildId}/panel-access/grant-levels" class="sub-panel">
          <div class="section-heading">
            <h2>Grant Command Access</h2>
            <p>Only root can decide which panel ranks may use <code>!grantaccess</code>.</p>
          </div>
          <div class="checkbox-grid compact">
            ${PANEL_ACCESS_LEVELS.map((level) => `
              <label class="toggle">
                <input type="checkbox" name="grantAccessLevels" value="${level}" ${isChecked((config.panelAccess?.grantAccessLevels || ["root"]).includes(level))}>
                <span>${escapeHtml(panelAccessLabel(level))}</span>
              </label>
            `).join("")}
          </div>
          <button type="submit">Save Grant Access</button>
        </form>
        <form method="post" action="/guilds/${guildId}/panel-access/templates" class="sub-panel">
          <div class="section-heading">
            <h2>Panel Role Templates</h2>
            <p>Templates are defaults for temporary grants and access reviews.</p>
          </div>
          <div class="field-pair">
            ${Object.entries(PANEL_ROLE_TEMPLATE_LEVELS).map(([templateId, defaultLevel]) => {
              const template = config.panelAccess?.roleTemplates?.[templateId] || {};
              return `
                <label>
                  ${escapeHtml(templateId.replace(/_/g, " "))}
                  <select name="template_${templateId}">
                    ${PANEL_ACCESS_LEVELS.map((level) => `<option value="${level}" ${selected(template.level || defaultLevel, level)}>${escapeHtml(panelAccessLabel(level))}</option>`).join("")}
                  </select>
                </label>
                <label>
                  ${escapeHtml(templateId.replace(/_/g, " "))} expiration days
                  <input type="number" name="templateDays_${templateId}" min="0" max="365" value="${escapeHtml(template.days ?? "")}" placeholder="0 = never">
                </label>
              `;
            }).join("")}
          </div>
          <button type="submit">Save Templates</button>
        </form>
      ` : ""}
      <section class="sub-panel">
        <div class="section-heading">
          <h2>Permission Matrix</h2>
          <p>Preview what each access rank can open.</p>
        </div>
        ${permissionMatrixViewer(panelUser)}
      </section>
      <div class="member-action-list">
        ${
          users.length
            ? users.map(([userId, entry]) => panelAccessUserRow(guildId, userId, entry, actorLevel)).join("")
            : '<p class="muted">No panel users have been granted yet. Create one from Discord before exposing the panel publicly.</p>'
        }
      </div>
    </section>
  `;
}

function permissionMatrixViewer(panelUser = null) {
  const actorLevel = panelUser?.level || "root";
  return `
    <div class="permission-matrix">
      <table>
        <thead>
          <tr>
            <th>Section</th>
            ${PANEL_ACCESS_LEVELS.map((level) => `<th>${escapeHtml(panelAccessLabel(level))}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          ${SETTINGS_SECTIONS.map((section) => `
            <tr>
              <td>${escapeHtml(section.label)}</td>
              ${PANEL_ACCESS_LEVELS.map((level) => `<td>${canAccessPanelSection(level, section.id) ? "Yes" : "No"}</td>`).join("")}
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    <div class="access-tier-grid">
      ${PANEL_ACCESS_LEVELS
        .filter((level) => panelAccessAtLeast(actorLevel, level) || panelAccessAtLeast(actorLevel, "root"))
        .map((level) => `<a class="primary-link secondary-link" href="?section=${SETTINGS_SECTIONS.find((section) => canAccessPanelSection(level, section.id))?.id || "dashboard"}&viewAs=${level}">View as ${escapeHtml(panelAccessLabel(level))}</a>`)
        .join("")}
    </div>
  `;
}

function panelAccessUserRow(guildId, userId, entry, actorLevel = "root") {
  const targetLevel = normalizePanelAccessLevel(entry.level);
  const manageable = panelAccessCanManage(actorLevel, targetLevel, targetLevel);
  const options = PANEL_ACCESS_LEVELS
    .filter((level) => panelAccessCanManage(actorLevel, targetLevel, level))
    .map((level) => `<option value="${level}" ${selected(targetLevel, level)}>${escapeHtml(panelAccessLabel(level))}</option>`)
    .join("");
  return `
    <article class="access-user-row">
      <div>
        <strong>${escapeHtml(entry.username || userId)}</strong>
        <small>${escapeHtml(userId)} &middot; ${escapeHtml(panelAccessLabel(entry.level))}</small>
        <small>Granted ${escapeHtml(entry.grantedAt || "unknown")} by ${escapeHtml(entry.grantedBy || "unknown")}</small>
        <small>Last login ${escapeHtml(entry.lastLoginAt || "never")} &middot; Expires ${escapeHtml(entry.expiresAt || "never")}</small>
      </div>
      ${manageable
        ? `<div class="access-user-actions">
            <form method="post" action="/guilds/${guildId}/panel-access/${userId}/level">
              <label>
                Access level
                <select name="level">${options}</select>
              </label>
              <button type="submit">Update</button>
            </form>
            <form method="post" action="/guilds/${guildId}/panel-access/${userId}/expiration">
              <label>
                Expiration
                <input type="datetime-local" name="expiresAt" value="${escapeHtml(datetimeLocalValue(entry.expiresAt))}">
              </label>
              <button type="submit">Save Expiration</button>
            </form>
            <form method="post" action="/guilds/${guildId}/panel-access/${userId}/reset-password" onsubmit="return confirm('Reset this panel recovery password and DM the user?');">
              <button type="submit" class="secondary-button">Reset password</button>
            </form>
            <form method="post" action="/guilds/${guildId}/panel-access/${userId}/revoke" onsubmit="return confirm('Revoke this panel user?');">
              <button type="submit" class="danger-button">Revoke</button>
            </form>
          </div>`
        : '<span class="muted">Protected</span>'}
    </article>
  `;
}

function panelTierDescription(level = "") {
  switch (normalizePanelAccessLevel(level)) {
    case "round_table":
      return "Basic moderation access: dashboard, commands, warnings, timeouts, punishment history, and routine member actions.";
    case "keeper":
      return "Advanced moderation access: includes kick, ban, applications, and higher-risk moderation actions.";
    case "artifact_contributor":
      return "Can manage command role permissions and revoke non-root panel users.";
    case "root":
      return "Full panel control, including AI rate limits, site config, games, exports, restore, updates, and restart.";
    default:
      return "";
  }
}

function sectionStatusLabel(sectionId) {
  return NON_FORM_SECTIONS.has(sectionId) ? "Live view" : "Saved config";
}

function canAccessPanelSection(accessLevel = "root", sectionId = "dashboard") {
  return panelAccessAtLeast(accessLevel, PANEL_SECTION_MIN_LEVEL[sectionId] || "root");
}

function allowedPanelSection(sectionId = "dashboard", accessLevel = "root") {
  const normalized = normalizeSettingsSection(sectionId);
  if (canAccessPanelSection(accessLevel, normalized)) return normalized;
  return SETTINGS_SECTIONS.find((section) => canAccessPanelSection(accessLevel, section.id))?.id || "dashboard";
}

function panelUserLabel(panelUser = null) {
  if (!panelUser) return "Legacy Root";
  return `${panelUser.username || panelUser.userId} (${panelAccessLabel(panelUser.level)})`;
}

function panelAccessDenied(response, message = "You do not have permission to manage that panel user.") {
  response.status(403).send(layout({ title: "Forbidden", user: true, body: `<p class="empty">${escapeHtml(message)}</p>` }));
}

function settingsNav(guild, config, activeSection, currentMeta, panelUser = null) {
  const community = communitySnapshot(config);
  const accessLevel = panelUser?.level || "root";
  const visibleGroups = SETTINGS_NAV_GROUPS.map((group) => ({
    ...group,
    sections: group.sections.filter((sectionId) => {
      const section = SETTINGS_SECTIONS.find((entry) => entry.id === sectionId);
      return section && canAccessPanelSection(accessLevel, section.id);
      })
    })).filter((group) => group.sections.length);
    const totalVisibleSections = visibleGroups.reduce((sum, group) => sum + group.sections.length, 0);
    return `
      <section class="mission-control" aria-label="Panel launcher">
        <div class="mission-hero">
          <div class="mission-identity">
            <span class="mission-emblem">${guild.iconUrl ? `<img src="${guild.iconUrl}" alt="">` : escapeHtml(guild.name[0] || "?")}</span>
            <div>
              <p class="eyebrow">Chipkittle Mission Control</p>
              <h1>${escapeHtml(guild.name)}</h1>
              <p>One place for staff tools, applications, AI, games, site content, bread economy, command access, and runtime control.</p>
            </div>
          </div>
          <div class="mission-search-card">
            <label class="nav-search-label">
              Search panel modules
              <input data-nav-filter type="search" autocomplete="off" placeholder="Type to filter ${escapeHtml(String(totalVisibleSections))} areas">
            </label>
            <span>${escapeHtml(panelUserLabel(panelUser))}</span>
          </div>
        </div>
        <div class="mission-readouts">
          <article><span>Members</span><strong>${escapeHtml(guild.memberCount ?? 0)}</strong></article>
          <article><span>Commands</span><strong>${escapeHtml(community.commandsRun)}</strong></article>
          <article><span>AI replies</span><strong>${escapeHtml(community.aiReplies)}</strong></article>
          <article><span>Punishments</span><strong>${escapeHtml((config.community?.auditLog || []).filter((entry) => String(entry.type || "") === "moderation").length)}</strong></article>
          <article><span>Applications</span><strong>${escapeHtml(community.applicationsOpened)}</strong></article>
          <article><span>Prefix</span><strong>${escapeHtml(config.prefix)}</strong></article>
        </div>
        <nav class="mission-modules" aria-label="Panel sections">
          ${visibleGroups.map((group) => `
            <section class="mission-module-shelf" data-nav-group>
              <div class="mission-shelf-title">
                <strong>${escapeHtml(group.label)}</strong>
                <span>${escapeHtml(group.description || "")}</span>
              </div>
              <div class="mission-module-list">
              ${group.sections.map((sectionId) => {
                const section = SETTINGS_SECTIONS.find((entry) => entry.id === sectionId);
                if (!section) return "";
                return `
                  <a class="mission-module ${section.id === activeSection ? "active" : ""}" href="/guilds/${guild.id}?section=${section.id}" data-nav-link data-nav-text="${escapeHtml(`${section.label} ${section.description} ${group.label}`)}">
                    <b>${escapeHtml(SETTINGS_NAV_MARKS[section.id] || section.label.slice(0, 2).toUpperCase())}</b>
                    <span>
                      <strong>${escapeHtml(section.label)}</strong>
                      <small>${escapeHtml(section.description)}</small>
                    </span>
                    <em>${sectionStatusLabel(section.id)}</em>
                  </a>`;
              }).join("")}
              </div>
            </section>
          `).join("")}
        </nav>
      </section>
    `;
  }

function mobileSectionSelect(guild, activeSection, panelUser = null) {
  const accessLevel = panelUser?.level || "root";
  const options = SETTINGS_SECTIONS
    .filter((section) => canAccessPanelSection(accessLevel, section.id))
    .map((section) => `<option value="/guilds/${guild.id}?section=${section.id}" ${section.id === activeSection ? "selected" : ""}>${escapeHtml(section.label)}</option>`)
    .join("");
  return `
    <label class="mobile-section-switcher">
      Section
      <select onchange="if (this.value) window.location.href = this.value">
        ${options}
      </select>
    </label>
  `;
}

function sectionForm(guildId, currentSection, currentMeta, innerHtml) {
  return `
    <form method="post" action="/guilds/${guildId}/config?section=${currentSection}" class="section-form">
      <div class="settings-stack">
        ${innerHtml}
      </div>
      <div class="form-actions">
        <button type="submit">Save ${escapeHtml(currentMeta.label)}</button>
      </div>
    </form>
  `;
}

function guildSummaryStrip(guild, config = {}) {
  const snapshot = communitySnapshot(config);
  return `
    <section class="guild-summary-strip">
      <article class="summary-chip"><strong>${escapeHtml(guild.memberCount ?? 0)}</strong><span>Members</span></article>
      <article class="summary-chip"><strong>${escapeHtml(snapshot.commandsRun)}</strong><span>Commands Run</span></article>
      <article class="summary-chip"><strong>${escapeHtml(snapshot.aiReplies)}</strong><span>AI Replies</span></article>
      <article class="summary-chip"><strong>${escapeHtml(snapshot.applicationsOpened)}</strong><span>Applications</span></article>
      <article class="summary-chip"><strong>${escapeHtml((config.community?.auditLog || []).filter((entry) => String(entry.type || "") === "moderation").length)}</strong><span>Punishments</span></article>
      <article class="summary-chip"><strong>${escapeHtml(snapshot.artifacts)}</strong><span>Artifacts</span></article>
    </section>
  `;
}

function sectionWorkspace({ guild, config, commandList, defaultAiModel, ai, currentSection, currentMeta, gameSettings, moderationMembers, economyMembers, warningMemberLabels, panelUser }) {
  switch (currentSection) {
    case "dashboard":
      return dashboardCards(guild, config);
    case "audit":
      return auditLogWorkspace(guild.id, config, panelUser);
    case "general":
      return sectionForm(
        guild.id,
        currentSection,
        currentMeta,
        `
          <section class="panel-section">
            <div class="section-heading">
              <h2>Command Settings</h2>
              <p>Slash commands use Discord's built-in / menu. This only changes the legacy text-command prefix.</p>
            </div>
            <label>
              Legacy text prefix
              <input name="prefix" maxlength="5" value="${escapeHtml(config.prefix)}" required>
            </label>
          </section>
          <section class="panel-section">
            <div class="section-heading">
              <h2>Welcome</h2>
              <p>Send a message and optionally assign a role when someone joins.</p>
            </div>
            <label class="toggle">
              <input type="checkbox" name="welcomeEnabled" ${isChecked(config.welcome.enabled)}>
              <span>Enable welcome messages</span>
            </label>
            <label>
              Welcome channel
              <select name="welcomeChannelId">
                ${optionList(guild.channels, config.welcome.channelId, "No channel selected")}
              </select>
            </label>
            <label>
              Welcome message
              <textarea name="welcomeMessage" rows="4">${escapeHtml(config.welcome.message)}</textarea>
            </label>
            <label>
              Auto role
              <select name="autoRoleId">
                ${optionList(guild.roles, config.autoRoleId, "No role selected")}
              </select>
            </label>
          </section>
        `
      );
    case "members":
      return sectionForm(
        guild.id,
        currentSection,
        currentMeta,
        `
          ${memberDirectoryEditor(config.publicSite.members)}
          ${profileEditorSettings(config, guild.roles)}
          ${profileApprovalQueue(config, guild.id, panelUser)}
          ${profileDirectoryCards(config)}
        `
      );
    case "public":
      return publicSiteWorkspace(config, commandList);
    case "moderation":
      return `
        ${moderationCenter(config)}
        ${moderationMemberBrowser(guild.id, moderationMembers, config, warningMemberLabels, panelUser)}
        ${moderationWorkspace(guild.id, config, warningMemberLabels)}
        ${panelAccessAtLeast(panelUser?.level || "root", "keeper")
          ? sectionForm(
              guild.id,
              currentSection,
              currentMeta,
              `
                <section class="panel-section">
                  <div class="section-heading">
                    <h2>Automod</h2>
                    <p>Remove messages that match simple server rules.</p>
                  </div>
                  <label class="toggle">
                    <input type="checkbox" name="automodEnabled" ${isChecked(config.automod.enabled)}>
                    <span>Enable automod</span>
                  </label>
                  <label>
                    Blocked words
                    <textarea name="blockedWords" rows="4">${escapeHtml(config.automod.blockedWords.join(", "))}</textarea>
                  </label>
                  <div class="inline-controls">
                    <label class="toggle">
                      <input type="checkbox" name="deleteInvites" ${isChecked(config.automod.deleteInvites)}>
                      <span>Delete invite links</span>
                    </label>
                    <label class="toggle">
                      <input type="checkbox" name="deleteLinks" ${isChecked(config.automod.deleteLinks)}>
                      <span>Delete web links</span>
                    </label>
                  </div>
                </section>
                <section class="panel-section">
                  <div class="section-heading">
                    <h2>Moderation Logs</h2>
                    <p>Choose where automod and moderation output should be posted.</p>
                  </div>
                  <label>
                    Log channel
                    <select name="logChannelId">
                      ${optionList(guild.channels, config.moderation.logChannelId, "No channel selected")}
                    </select>
                  </label>
                </section>
              `
            )
          : ""}
      `;
    case "suggestions":
      return suggestionsWorkspace(guild, config, panelUser);
    case "ai":
      return sectionForm(
        guild.id,
        currentSection,
        currentMeta,
        `
          <section class="panel-section">
            <div class="section-heading">
              <h2>Chipkittle AI</h2>
              <p>Configure the lore-aware AI chat bot for this server.</p>
            </div>
            <div class="ai-status-line">
              <span class="status-dot"></span>
              API key: ${ai.enabled ? "configured" : "missing"}
            </div>
            <label class="toggle">
              <input type="checkbox" name="aiEnabled" ${isChecked(config.ai.enabled)}>
              <span>Enable AI replies</span>
            </label>
            <label class="toggle">
              <input type="checkbox" name="aiReplyToMentions" ${isChecked(config.ai.replyToMentions)}>
              <span>Reply when mentioned</span>
            </label>
            <div class="field-pair">
              <label>
                AI mode
                <select name="aiMode">
                  <option value="normal" ${config.ai.mode === "evil" ? "" : "selected"}>Normal Chipkittle</option>
                  <option value="evil" ${config.ai.mode === "evil" ? "selected" : ""}>Evil Chipkittle</option>
                </select>
              </label>
              <label>
                Model
                <input name="aiModel" value="${escapeHtml(config.ai.model || defaultAiModel)}">
              </label>
              <label>
                API cooldown seconds
                <input type="number" name="aiApiCooldownSeconds" min="0" max="3600" value="${escapeHtml(config.ai.apiCooldownSeconds)}">
              </label>
              <label>
                Image cooldown seconds
                <input type="number" name="aiImageCooldownSeconds" min="0" max="7200" value="${escapeHtml(config.ai.imageCooldownSeconds)}">
              </label>
              <label>
                Chaos level
                <input type="number" name="aiChaosLevel" min="1" max="10" value="${escapeHtml(config.ai.chaosLevel || 3)}">
              </label>
              <label>
                Lore strictness
                <select name="aiLoreStrictness">
                  <option value="loose" ${config.ai.loreStrictness === "loose" ? "selected" : ""}>Loose</option>
                  <option value="balanced" ${!config.ai.loreStrictness || config.ai.loreStrictness === "balanced" ? "selected" : ""}>Balanced</option>
                  <option value="strict" ${config.ai.loreStrictness === "strict" ? "selected" : ""}>Strict</option>
                </select>
              </label>
              <label>
                Response length
                <select name="aiResponseLength">
                  <option value="short" ${config.ai.responseLength === "short" ? "selected" : ""}>Short</option>
                  <option value="normal" ${!config.ai.responseLength || config.ai.responseLength === "normal" ? "selected" : ""}>Normal</option>
                  <option value="long" ${config.ai.responseLength === "long" ? "selected" : ""}>Long</option>
                </select>
              </label>
              <label>
                Monthly token budget
                <input type="number" name="aiMonthlyBudget" min="0" max="50000000" value="${escapeHtml(config.ai.monthlyBudget || 0)}">
              </label>
            </div>
            <div class="stat-grid compact-stat-grid">
              <div><span>This month</span><strong>${escapeHtml(config.ai.usage?.month || "none")}</strong></div>
              <div><span>Requests</span><strong>${escapeHtml(config.ai.usage?.requests || 0)}</strong></div>
              <div><span>Est. tokens</span><strong>${escapeHtml((config.ai.usage?.estimatedTokens || 0).toLocaleString())}</strong></div>
            </div>
            <label>
              Extra personality
              <textarea name="aiPersonality" rows="5">${escapeHtml(config.ai.personality)}</textarea>
            </label>
            <div>
              <p class="field-label">AI allowed roles</p>
              <p class="field-help">Leave empty to allow everyone. This applies to AI commands and passive AI replies.</p>
              <div class="checkbox-grid">
                ${roleCheckboxes(guild.roles, config.ai.allowedRoleIds || [], "aiAllowedRoleIds")}
              </div>
            </div>
            <label>
              Channel personalities
              <textarea name="aiChannelPersonalities" rows="5">${escapeHtml(aiChannelPersonalitiesText(config.ai.channelPersonalities || {}))}</textarea>
              <span class="field-help">One per line: <code>channelId | extra personality rules</code>. These are layered on top of the global personality.</span>
            </label>
            <div>
              <p class="field-label">AI chat channels</p>
              <div class="checkbox-grid">
                ${channelCheckboxes(guild.channels, config.ai.channelIds)}
              </div>
            </div>
            <div>
              <p class="field-label">AI blacklisted channels</p>
              <p class="field-help">AI will not answer mentions or direct ask commands in these channels.</p>
              <div class="checkbox-grid">
                ${channelCheckboxes(guild.channels, config.ai.blacklistedChannelIds, "aiBlacklistedChannelIds")}
              </div>
            </div>
          </section>
        `
      );
    case "applications":
      return sectionForm(
        guild.id,
        currentSection,
        currentMeta,
        `
          ${applicationsWorkspace(guild.id, guild, config)}
          <section class="panel-section">
            <div class="section-heading">
              <h2>Membership Applications</h2>
              <p>DM applicants the questions and create private staff review threads.</p>
            </div>
            <label class="toggle">
              <input type="checkbox" name="applicationsEnabled" ${isChecked(config.applications.enabled)}>
              <span>Enable application threads</span>
            </label>
            <div class="field-pair">
              <label>
                Application command channel
                <select name="applicationChannelId">
                  ${optionList(guild.channels, config.applications.channelId, "Allow applications from any channel")}
                </select>
              </label>
              <label>
                Review thread channel
                <select name="applicationThreadChannelId">
                  ${optionList(guild.channels, config.applications.threadChannelId, "Use the application command channel")}
                </select>
              </label>
              <label>
                Approved membership role
                <select name="applicationApprovedRoleId">
                  ${optionList(guild.roles, config.applications.approvedRoleId, "No role selected")}
                </select>
              </label>
              <label>
                Application cooldown minutes
                <input type="number" name="applicationCooldownMinutes" min="0" max="10080" value="${escapeHtml(config.applications.cooldownMinutes)}">
              </label>
            </div>
            <div>
              <p class="field-label">Roles blocked from applying</p>
              <p class="field-help">Members with any of these roles cannot open an application.</p>
              <div class="checkbox-grid">
                ${roleCheckboxes(guild.roles, config.applications.blockedRoleIds, "applicationBlockedRoleIds")}
              </div>
            </div>
            <div>
              <p class="field-label">Application reviewer roles</p>
              <p class="field-help">These roles can view threads and use reply, approve, deny, or close commands.</p>
              <div class="checkbox-grid">
                ${roleCheckboxes(guild.roles, config.applications.reviewerRoleIds, "applicationReviewerRoleIds")}
              </div>
            </div>
            <label>
              Application questions
              <textarea name="applicationQuestions" rows="7">${escapeHtml(config.applications.questions.join("\n"))}</textarea>
            </label>
          </section>
        `
      );
    case "games":
      return `
        ${sectionForm(
          guild.id,
          currentSection,
          currentMeta,
          `
            <section class="panel-section">
              <div class="section-heading">
                <h2>Game Moderation</h2>
                <p>Filter public game names and tune how much each run can save or claim.</p>
              </div>
              <label>
                Blocked leaderboard words or names
                <textarea name="blockedLeaderboardWords" rows="4" placeholder="comma, separated, words">${escapeHtml(blockedWordListText(gameSettings.blockedLeaderboardWords))}</textarea>
              </label>
              <p class="field-help">Built-in slur and profanity blocking is always on. Add extra names or words here.</p>
              <div class="field-pair">
                <label>
                  Max leaderboard entries per game
                  <input type="number" name="maxLeaderboardEntriesPerGame" min="1" max="50" value="${escapeHtml(gameSettings.maxLeaderboardEntriesPerGame)}">
                </label>
                <label>
                  Max saved score per run
                  <input type="number" name="maxLeaderboardScore" min="1" max="1000000" value="${escapeHtml(gameSettings.maxLeaderboardScore)}">
                </label>
                <label>
                  Max saved bread per run
                  <input type="number" name="maxLeaderboardBread" min="0" max="1000000" value="${escapeHtml(gameSettings.maxLeaderboardBread)}">
                </label>
                <label>
                  Max claim bread per run
                  <input type="number" name="maxClaimBreadPerRun" min="0" max="1000000" value="${escapeHtml(gameSettings.maxClaimBreadPerRun)}">
                </label>
                <label>
                  Record alert channel
                  <select name="recordAlertChannelId">
                    ${optionList(guild.channels, gameSettings.recordAlertChannelId, "No alert channel selected")}
                  </select>
                </label>
              </div>
            </section>
          `
        )}
        ${gameLeaderboardControls(guild.id, gameSettings)}
      `;
    case "economy":
      return `
        ${sectionForm(
          guild.id,
          currentSection,
          currentMeta,
          economySettingsWorkspace(config)
        )}
        ${economyMemberBrowser(guild.id, economyMembers, config)}
      `;
    case "community":
      return sectionForm(
        guild.id,
        currentSection,
        currentMeta,
        `
          ${communityWorkspace(guild.id, config)}
          <section class="panel-section">
            <div class="section-heading">
              <h2>Artifact Registry</h2>
              <p>One artifact per line: <code>Name | Rarity | Keeper | Summary</code></p>
            </div>
            <label>
              Artifacts
              <textarea name="communityArtifacts" rows="8">${escapeHtml(artifactDirectoryText(config.community?.artifacts || []))}</textarea>
            </label>
          </section>
          <section class="panel-section">
            <div class="section-heading">
              <h2>Ritual Status</h2>
              <p>Public-facing status text for the archive and website.</p>
            </div>
            <div class="field-pair">
              <label>
                Current event
                <input name="currentEvent" value="${escapeHtml(config.community?.rituals?.currentEvent || "")}">
              </label>
              <label>
                Seasonal message
                <input name="seasonalMessage" value="${escapeHtml(config.community?.rituals?.seasonalMessage || "")}">
              </label>
              <label>
                Next trial
                <input name="nextTrial" value="${escapeHtml(config.community?.rituals?.nextTrial || "")}">
              </label>
            </div>
          </section>
        `
      );
    case "permissions":
      return sectionForm(
        guild.id,
        currentSection,
        currentMeta,
        `
          <section class="panel-section">
            <div class="section-heading">
              <h2>Command Access Rules</h2>
              <p>Disable whole categories, lock channels to specific commands, or grant role overrides without the matching Discord permission.</p>
            </div>
            <p class="field-help">Use category toggles for broad shutdowns, channel rules for places like #welcome where only one command should work, and per-command rules for finer control.</p>
            <div class="permission-rule-block standalone">
              <p class="field-help">Disabled categories</p>
              <div class="checkbox-grid compact">
                ${categoryAccessRules(commandList, config.commandRoles)}
              </div>
            </div>
          </section>
          <section class="panel-section">
            <div class="section-heading">
              <h2>Channel-Only Commands</h2>
              <p>Pick the commands or categories allowed in each channel. If both lists are empty for a channel, every command is still allowed there.</p>
            </div>
            <div class="permission-list">
              ${channelCommandRules(commandList, guild.channels, config.commandRoles, panelUser)}
            </div>
          </section>
          <section class="panel-section">
            <div class="section-heading">
              <h2>Per-Command Rules</h2>
              <p>Open a command to manage its disable switch, allowed channels, and role overrides.</p>
            </div>
            <div class="permission-list">
              ${commandRoleAccess(commandList, guild.roles, guild.channels, config.commandRoles, panelUser)}
            </div>
          </section>
        `
      );
    case "access":
      return panelAccessWorkspace(guild.id, config, panelUser);
    case "backups":
      return restoreCenter(guild.id);
    case "commands":
      return `
        <section class="panel-section command-catalog">
          <div class="section-heading">
            <h2>Command Catalog</h2>
            <p>${commandList.length} slash commands are available. Legacy text commands still use this server's prefix.</p>
          </div>
          ${commandCatalog(commandList, config.prefix)}
        </section>
      `;
    case "server":
      return updateControls(guild.id);
    default:
      return dashboardCards(guild, config);
  }
}

function guildPage({ guild, config, commandList, defaultAiModel, ai, flash, activeSection = "general", moderationMembers = null, economyMembers = null, warningMemberLabels = {}, panelUser = null }) {
  const currentSection = allowedPanelSection(activeSection, panelUser?.level || "root");
  const currentMeta = activeSectionMeta(currentSection);
  const gameSettings = publicGameSettings(config);
  const panelClientScript = `
    <script>
      (() => {
        const editor = document.querySelector("[data-member-directory-editor]");
        const actionButtons = document.querySelectorAll("[data-post-action]");

        actionButtons.forEach((button) => {
          button.addEventListener("click", () => {
            const form = document.createElement("form");
            form.method = "post";
            form.action = button.getAttribute("data-post-action");
            form.style.display = "none";
            document.body.appendChild(form);
            form.submit();
          });
        });

        if (!editor) return;
        const list = editor.querySelector("[data-member-rows]");
        const count = editor.querySelector("[data-member-count]");
        const hidden = editor.querySelector('textarea[name="publicMembers"]');
        const addButton = editor.querySelector("[data-add-member]");

        function sanitize(value) {
          return String(value || "").replace(/\\|/g, "/").replace(/\\r?\\n/g, " ").replace(/\\s+/g, " ").trim();
        }

        function updateEmptyState() {
          const rows = list.querySelectorAll("[data-member-row]");
          const empty = list.querySelector(".member-editor-empty");
          if (!rows.length && !empty) {
            const message = document.createElement("p");
            message.className = "muted member-editor-empty";
            message.textContent = "No public members yet. Add the first one here.";
            list.appendChild(message);
          }
          if (rows.length && empty) empty.remove();
          count.textContent = rows.length + " member" + (rows.length === 1 ? "" : "s");
        }

        function serialize() {
          const rows = [...list.querySelectorAll("[data-member-row]")];
          const lines = rows
            .map((row) => {
              const name = sanitize(row.querySelector("[data-member-name]")?.value);
              if (!name) return "";
              const role = sanitize(row.querySelector("[data-member-role]")?.value);
              const bio = sanitize(row.querySelector("[data-member-bio]")?.value);
              const title = sanitize(row.querySelector("[data-member-title]")?.value);
              const badges = sanitize(row.querySelector("[data-member-badges]")?.value);
              return [name, role, bio, title, badges].join(" | ");
            })
            .filter(Boolean);
          hidden.value = lines.join("\\n");
          updateEmptyState();
        }

        function attachRow(row) {
          row.querySelectorAll("input, textarea").forEach((field) => {
            field.addEventListener("input", serialize);
          });
          row.querySelector("[data-remove-member]")?.addEventListener("click", () => {
            row.remove();
            serialize();
          });
        }

        function createRow() {
          const row = document.createElement("div");
          row.className = "member-editor-row";
          row.setAttribute("data-member-row", "");
          row.innerHTML = \`
            <div class="member-editor-fields">
              <label>Name<input data-member-name maxlength="80"></label>
              <label>Role<input data-member-role maxlength="80"></label>
              <label>Title<input data-member-title maxlength="80"></label>
              <label>Badges<input data-member-badges maxlength="180"></label>
              <label class="member-editor-bio">Bio<textarea data-member-bio rows="3" maxlength="220"></textarea></label>
            </div>
            <button type="button" class="secondary-button member-editor-remove" data-remove-member>Remove</button>
          \`;
          attachRow(row);
          list.appendChild(row);
          row.querySelector("[data-member-name]")?.focus();
          serialize();
        }

        list.querySelectorAll("[data-member-row]").forEach(attachRow);
        addButton?.addEventListener("click", createRow);
        editor.closest("form")?.addEventListener("submit", serialize);
        serialize();
      })();
    </script>
  `;
  return layout({
    title: guild.name,
    user: true,
    flash,
    body: `
      <section class="mission-panel">
        ${settingsNav(guild, config, currentSection, currentMeta, panelUser)}
        <div class="mission-workbench">
          <aside class="mission-context-card">
            <span class="mission-context-kicker">${NON_FORM_SECTIONS.has(currentSection) ? "Live workspace" : "Config workspace"}</span>
            <h2>${escapeHtml(currentMeta.label)}</h2>
            <p>${escapeHtml(currentMeta.description)}</p>
            <dl>
              <div>
                <dt>Mode</dt>
                <dd>${escapeHtml(sectionStatusLabel(currentSection))}</dd>
              </div>
              <div>
                <dt>Access</dt>
                <dd>${escapeHtml(panelUserLabel(panelUser))}</dd>
              </div>
              <div>
                <dt>Prefix</dt>
                <dd>${escapeHtml(config.prefix)}</dd>
              </div>
            </dl>
            <div class="mission-context-actions">
              ${mobileSectionSelect(guild, currentSection, panelUser)}
              <a class="secondary-button" href="https://chipkittle.com" target="_blank" rel="noreferrer">Website</a>
              <a class="secondary-button" href="/commits">Commits</a>
            </div>
          </aside>
          <section class="mission-work-surface">
            <div class="mission-work-surface-head">
              <div>
                <p class="eyebrow">Open workspace</p>
                <h1>${escapeHtml(currentMeta.label)}</h1>
              </div>
              <div class="workspace-breadcrumb">
                <a href="/guilds/${guild.id}?section=dashboard">${escapeHtml(guild.name)}</a>
                <span>/</span>
                <strong>${escapeHtml(currentMeta.label)}</strong>
              </div>
            </div>
            <div class="settings-main workspace-main">
            ${sectionWorkspace({
              guild,
              config,
              commandList,
              defaultAiModel,
              ai,
              currentSection,
              currentMeta,
              gameSettings,
              moderationMembers,
              economyMembers,
              warningMemberLabels,
              panelUser
            })}
            </div>
          </section>
          </div>
      </section>${panelClientScript}
    `
  });
}

export function createPanel({
  client,
  store,
  panelPassword,
  allowLegacyPanelPasswordLogin,
  sessionSecret,
  clientId,
  discordClientSecret,
  guildId,
  ai,
  publicUrl,
  defaultAiModel,
  commandList
}) {
  const app = express();
  const panelStatic = express.static("public", { index: false });
  const useSecureCookies = String(publicUrl || "").startsWith("https://");
  const loginAttempts = new Map();
  const activePanelSessions = new Map();
  const oauthStates = new Map();
  const profileOAuthStates = new Map();
  const sessionStore = new session.MemoryStore();
  const publicSuggestionCooldowns = new Map();
  const publicSuggestionCaptchas = new Map();

  app.disable("x-powered-by");
  if (useSecureCookies) {
    app.set("trust proxy", 1);
  }
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use((request, response, next) => {
    if (request.path === "/styles.css" || request.path === "/chipkittle-logo.svg" || request.path === "/notativelogotransparent.png") {
      panelStatic(request, response, next);
      return;
    }

    next();
  });
  app.use(
    session({
      store: sessionStore,
      name: "bot_panel.sid",
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: useSecureCookies,
        maxAge: SESSION_MAX_AGE_MS
      }
    })
  );

  app.use((request, _response, next) => {
    if (request.session?.authenticated) {
      activePanelSessions.set(request.sessionID, {
        id: request.sessionID,
        userId: request.session.panelUserId || "",
        username: request.session.panelUsername || "",
        guildId: request.session.panelGuildId || currentPanelGuildId(),
        createdAt: request.session.createdAt || new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        userAgent: String(request.get("user-agent") || "").slice(0, 180)
      });
      request.session.lastSeenAt = new Date().toISOString();
    }
    next();
  });

  function requireAuth(request, response, next) {
    if (!request.session.authenticated) {
      response.redirect("/login");
      return;
    }
    const targetGuildId = request.params.guildId || request.body?.guildId || request.session.panelGuildId || currentPanelGuildId();
    const config = targetGuildId ? store.getGuild(targetGuildId) : null;
    const user = currentPanelUser(request, targetGuildId);
    const revokedBefore = Date.parse(config?.panelAccess?.sessionsRevokedBefore || "");
    const sessionCreated = Date.parse(request.session.createdAt || "");
    if (Number.isFinite(revokedBefore) && Number.isFinite(sessionCreated) && sessionCreated < revokedBefore) {
      request.session.destroy(() => response.redirect("/login?error=session-revoked"));
      return;
    }
    if (config?.panelAccess?.emergencyLockout && !panelAccessAtLeast(user?.level || "", "root")) {
      request.session.destroy(() => response.redirect("/login?error=lockout"));
      return;
    }
    if (!user) {
      request.session.destroy(() => response.redirect("/login?error=access-expired"));
      return;
    }
    next();
  }

  function currentPanelGuildId() {
    return guildId || client.guilds.cache.first()?.id || Object.keys(store.data?.guilds || {})[0] || "";
  }

  function currentPanelUser(request, targetGuildId = currentPanelGuildId()) {
    if (request.session.panelLegacyRoot) {
      return null;
    }
    const sessionUserId = String(request.session.panelUserId || "");
    if (!sessionUserId || !targetGuildId) return null;
    return panelAccessUser(store.getGuild(targetGuildId), sessionUserId);
  }

  function oauthRedirectUri(request) {
    const base = publicUrl || `${request.protocol}://${request.get("host")}`;
    return new URL("/auth/discord/callback", base).toString();
  }

  function oauthDiagnosticInfo(request) {
    return {
      publicUrl,
      clientId,
      discordClientSecret,
      redirectUri: oauthRedirectUri(request)
    };
  }

  function discordOAuthUrl(request) {
    if (!clientId || !discordClientSecret) return "";
    const state = crypto.randomBytes(OAUTH_STATE_BYTES).toString("base64url");
    oauthStates.set(state, {
      createdAt: Date.now()
    });
    const url = new URL("https://discord.com/oauth2/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", oauthRedirectUri(request));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "identify");
    url.searchParams.set("state", state);
    url.searchParams.set("prompt", "none");
    return url.toString();
  }

  function profileOAuthRedirectUri(request) {
    const base = publicUrl || `${request.protocol}://${request.get("host")}`;
    return new URL("/auth/discord/profile/callback", base).toString();
  }

  function discordProfileOAuthUrl(request) {
    if (!clientId || !discordClientSecret) return "";
    const state = crypto.randomBytes(OAUTH_STATE_BYTES).toString("base64url");
    profileOAuthStates.set(state, {
      createdAt: Date.now()
    });
    const url = new URL("https://discord.com/oauth2/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", profileOAuthRedirectUri(request));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "identify");
    url.searchParams.set("state", state);
    url.searchParams.set("prompt", "none");
    return url.toString();
  }

  async function exchangeDiscordOAuthCode(code, redirectUri) {
    const tokenBody = new URLSearchParams({
      client_id: clientId,
      client_secret: discordClientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri
    });
    const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody
    });
    if (!tokenResponse.ok) {
      const body = await tokenResponse.text().catch(() => "");
      const error = new Error(`Token exchange failed: ${tokenResponse.status} ${body}`);
      error.oauthRedirectProblem = /redirect_uri|invalid_grant/i.test(body);
      throw error;
    }
    const token = await tokenResponse.json();
    const userResponse = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${token.access_token}` }
    });
    if (!userResponse.ok) throw new Error(`User fetch failed: ${userResponse.status}`);
    return userResponse.json();
  }

  function profileEditorRoleIds(config = {}) {
    const configured = Array.isArray(config.publicSite?.profileEditor?.allowedRoleIds)
      ? config.publicSite.profileEditor.allowedRoleIds.map(String).filter(Boolean)
      : [];
    if (configured.length) return configured;
    return config.applications?.approvedRoleId ? [String(config.applications.approvedRoleId)] : [];
  }

  async function verifyProfileEditorMember(userId = "") {
    const targetGuildId = currentPanelGuildId();
    const config = store.getGuild(targetGuildId);
    if (!config.publicSite?.profileEditor?.enabled) {
      return { ok: false, reason: "The member profile editor is disabled right now." };
    }
    const requiredRoleIds = profileEditorRoleIds(config);
    if (!requiredRoleIds.length) {
      return { ok: false, reason: "Profile editor roles are not configured yet." };
    }
    const guild = client.guilds.cache.get(targetGuildId);
    if (!guild) return { ok: false, reason: "The bot is not connected to the configured Discord server." };
    const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
    if (!member) return { ok: false, reason: "You must be in the Chipkittle Discord to edit a public profile." };
    const hasAllowedRole = member.id === guild.ownerId || requiredRoleIds.some((roleId) => member.roles.cache.has(roleId));
    if (!hasAllowedRole) {
      return { ok: false, reason: "Your Discord account does not have the role required to edit a public profile." };
    }
    return { ok: true, guild, guildId: targetGuildId, config, member };
  }

  function profileLoginPage(error = "", discordUrl = "") {
    const redirectUri = (() => {
      try {
        return profileOAuthRedirectUri({
          protocol: "https",
          get: () => new URL(publicUrl || "https://panel.chipkittle.com").host
        });
      } catch {
        return "https://panel.chipkittle.com/auth/discord/profile/callback";
      }
    })();
    return layout({
      title: "Edit Chipkittle Profile",
      user: false,
      body: `
        <section class="login-panel">
          <div>
            <p class="eyebrow">Member profiles</p>
            <h1>Edit your public Chipkittle card.</h1>
            <p class="muted">Sign in with Discord. You must already be in the #CK Discord and have the configured member role.</p>
          </div>
          <div class="stack">
            ${error ? `<p class="form-error">${escapeHtml(error)}</p>` : ""}
            ${discordUrl
              ? `<a class="primary-link oauth-login-button" href="${escapeHtml(discordUrl)}">Continue with Discord</a>`
              : '<p class="form-error">Discord OAuth is not configured yet.</p>'}
            <p class="field-help">Profile OAuth redirect: <code>${escapeHtml(redirectUri)}</code></p>
            <a class="primary-link secondary-link" href="https://chipkittle.com/members">Back to members</a>
          </div>
        </section>
      `
    });
  }

  function profileEditPage({ config, member, message = "", error = "" }) {
    const profile = profileFor(config, member.id, member.displayName);
    const pendingEdit = config.community?.profileEdits?.[member.id]?.status === "pending"
      ? config.community.profileEdits[member.id]
      : null;
    const formProfile = pendingEdit?.draft ? { ...profile, ...pendingEdit.draft } : profile;
    const achievements = derivedAchievements(config, member.id, member.displayName);
    return layout({
      title: "Edit Chipkittle Profile",
      user: false,
      flash: message,
      body: `
        <section class="panel-hero">
          <div>
            <p class="eyebrow">Member profile</p>
            <h1>${escapeHtml(member.displayName)}</h1>
            <p class="muted">This edits the public member directory card tied to your Discord account.</p>
          </div>
          <form method="post" action="/profile/logout">
            <button type="submit" class="secondary-button">Sign out</button>
          </form>
        </section>
        ${error ? `<p class="form-error">${escapeHtml(error)}</p>` : ""}
        ${pendingEdit ? `<p class="flash">Your latest edit is waiting for root approval. The public site still shows the last approved version.</p>` : ""}
        <form method="post" action="/profile/edit" class="panel-form">
          <section class="panel-section">
            <div class="section-heading">
              <h2>Public Card</h2>
              <p>Keep it personal. The artifact dislikes corporate bios.</p>
            </div>
            <label>
              Display name
              <input name="displayName" maxlength="80" value="${escapeHtml(formProfile.displayName)}">
            </label>
            <label>
              Title
              <input name="title" maxlength="80" value="${escapeHtml(formProfile.title)}">
            </label>
            <label>
              Pronouns or short tag
              <input name="pronouns" maxlength="40" value="${escapeHtml(formProfile.pronouns)}">
            </label>
            <label>
              Favorite artifact
              <input name="favoriteArtifact" maxlength="80" value="${escapeHtml(formProfile.favoriteArtifact)}">
            </label>
            <label>
              Tiny quote
              <input name="quote" maxlength="140" value="${escapeHtml(formProfile.quote)}">
            </label>
            <label>
              Bio
              <textarea name="bio" rows="5" maxlength="260">${escapeHtml(formProfile.bio)}</textarea>
            </label>
            <label class="toggle">
              <input type="checkbox" name="publicVisible" ${isChecked(formProfile.publicVisible)}>
              <span>Request showing my profile on the public member directory</span>
            </label>
            <button type="submit">Submit for approval</button>
          </section>
          <section class="panel-section">
            <div class="section-heading">
              <h2>Earned Achievements</h2>
              <p>These are calculated from your bot profile, bread economy, shop items, and public profile state.</p>
            </div>
            <div class="member-badges">
              ${achievements.length ? achievements.map((badge) => `<span>${escapeHtml(badge)}</span>`).join("") : '<span>No achievements yet</span>'}
            </div>
          </section>
        </form>
      `
    });
  }

  function loginErrorMessage(code = "") {
    const messages = {
      denied: "That Discord account does not have panel access.",
      oauth: "Discord sign-in failed. Try again in a moment.",
      "oauth-redirect": "Discord rejected the OAuth redirect URI. Copy the exact redirect below into the Discord Developer Portal.",
      state: "That sign-in session expired. Please try again.",
      lockout: "Emergency lockout is active. Only root users can sign in.",
      "access-expired": "Your panel access is expired or revoked.",
      "session-revoked": "Your session was signed out by root."
    };
    return messages[String(code || "")] || "";
  }

  function findPanelAccessForDiscordUser(userId = "") {
    for (const [storedGuildId, config] of Object.entries(store.data?.guilds || {})) {
      const entry = config.panelAccess?.users?.[userId];
      const user = panelAccessUser(config, userId);
      if (user) return { guildId: storedGuildId, user, entry };
    }
    return null;
  }

  function fallbackOwnerRoot(userId = "") {
    const ownedGuild = client.guilds.cache.find((guild) => guild.ownerId === userId);
    if (!ownedGuild) return null;
    const config = store.getGuild(ownedGuild.id);
    const activeRoot = Object.entries(config.panelAccess?.users || {})
      .some(([, entry]) => !entry.revokedAt && normalizePanelAccessLevel(entry.level) === "root");
    if (activeRoot) return null;
    return {
      guildId: ownedGuild.id,
      user: {
        userId,
        username: "Server Owner Recovery",
        level: "root",
        grantedAt: new Date().toISOString(),
        grantedBy: "owner-fallback"
      },
      entry: null,
      ownerFallback: true
    };
  }

  async function auditPanelLogin(guildId, label, details, actor = "Panel Auth", extra = {}) {
    if (!guildId) return;
    await addAuditLog(store, guildId, {
      type: "panel-auth",
      label,
      details,
      actor,
      ...extra
    }).catch(() => {});
  }

  async function finishPanelLogin(request, response, access, discordUser = {}) {
    const config = store.getGuild(access.guildId);
    if (config.panelAccess?.emergencyLockout && !panelAccessAtLeast(access.user.level, "root")) {
      await auditPanelLogin(access.guildId, "Panel OAuth blocked by lockout", `${discordUser.username || access.user.username || access.user.userId} tried to sign in during emergency lockout.`, "Panel Auth", { targetId: access.user.userId });
      response.redirect("/login?error=lockout");
      return;
    }

    const now = new Date().toISOString();
    const memberUsername = discordUser.username || access.user.username || access.user.userId;
    const entry = config.panelAccess?.users?.[access.user.userId] || {};
    await store.updateGuild(access.guildId, {
      panelAccess: {
        ...config.panelAccess,
        users: {
          ...config.panelAccess.users,
          [access.user.userId]: {
            ...entry,
            username: memberUsername,
            level: access.user.level,
            grantedAt: entry.grantedAt || access.user.grantedAt || now,
            grantedBy: entry.grantedBy || access.user.grantedBy || "oauth",
            lastLoginAt: now
          }
        }
      }
    });

    request.session.regenerate((error) => {
      if (error) {
        response.redirect("/login?error=oauth");
        return;
      }
      request.session.authenticated = true;
      request.session.panelUserId = access.user.userId;
      request.session.panelGuildId = access.guildId;
      request.session.panelUsername = memberUsername;
      request.session.panelLegacyRoot = false;
      request.session.createdAt = now;
      request.session.lastSeenAt = now;
      activePanelSessions.set(request.sessionID, {
        id: request.sessionID,
        userId: access.user.userId,
        username: memberUsername,
        guildId: access.guildId,
        createdAt: now,
        lastSeenAt: now,
        userAgent: String(request.get("user-agent") || "").slice(0, 180)
      });
      auditPanelLogin(access.guildId, "Panel OAuth login", `${memberUsername} signed in with Discord OAuth.`, panelAccessLabel(access.user.level), { targetId: access.user.userId }).catch(() => {});
      response.redirect("/");
    });
  }

  function requirePanelLevel(requiredLevel) {
    return (request, response, next) => {
      const user = currentPanelUser(request, request.params.guildId || request.body?.guildId || currentPanelGuildId());
      if (user && panelAccessAtLeast(user.level, requiredLevel)) {
        next();
        return;
      }
      response.status(403).send(layout({ title: "Forbidden", user: true, body: '<p class="empty">You do not have access to this panel area.</p>' }));
    };
  }

  function authenticatePanelUser(username = "", password = "") {
    const normalizedUsername = String(username || "").trim().toLowerCase();
    if (!normalizedUsername) return null;
    for (const [storedGuildId, config] of Object.entries(store.data?.guilds || {})) {
      for (const [userId, entry] of Object.entries(config.panelAccess?.users || {})) {
        if (entry?.revokedAt) continue;
        if (String(entry.username || "").toLowerCase() !== normalizedUsername) continue;
        if (!verifyPanelPassword(password, entry.passwordHash)) continue;
        return {
          guildId: storedGuildId,
          userId,
          username: entry.username,
          level: normalizePanelAccessLevel(entry.level)
        };
      }
    }
    return null;
  }

  function loginThrottleKey(request, username = "") {
    return `${request.ip}:${String(username || "").trim().toLowerCase()}`;
  }

  function readLoginThrottle(request, username = "") {
    const key = loginThrottleKey(request, username);
    const now = Date.now();
    const entry = loginAttempts.get(key);
    if (!entry) return { key, attempts: 0, limited: false };
    if (entry.expiresAt <= now) {
      loginAttempts.delete(key);
      return { key, attempts: 0, limited: false };
    }
    return {
      key,
      attempts: entry.attempts,
      limited: entry.attempts >= LOGIN_MAX_ATTEMPTS
    };
  }

  function recordFailedLogin(request, username = "") {
    const { key, attempts } = readLoginThrottle(request, username);
    loginAttempts.set(key, {
      attempts: attempts + 1,
      expiresAt: Date.now() + LOGIN_WINDOW_MS
    });
  }

  function clearFailedLogins(request, username = "") {
    loginAttempts.delete(loginThrottleKey(request, username));
  }

  function updateRedirectTarget(request) {
    const referrer = request.get("referer") || "/";
    try {
      const url = new URL(referrer, `${request.protocol}://${request.get("host")}`);
      const params = new URLSearchParams(url.search);
      params.delete("saved");
      params.delete("update");
      const prefix = params.toString();
      return `${url.pathname}?${prefix ? `${prefix}&` : ""}update=`;
    } catch {
      return "/?update=";
    }
  }

  function setPublicApiHeaders(response) {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Cache-Control", "no-store");
  }

  function getPublicGuildConfig() {
    const configuredGuildId = guildId || client.guilds.cache.first()?.id;
    if (configuredGuildId) {
      return store.getGuild(configuredGuildId);
    }

    const storedGuildId = Object.keys(store.data?.guilds || {})[0];
    return storedGuildId ? store.getGuild(storedGuildId) : null;
  }

  function getPublicGuildId() {
    return guildId || client.guilds.cache.first()?.id || Object.keys(store.data?.guilds || {})[0] || "";
  }

  function publicSuggestionThrottleKey(request) {
    return String(request.headers["x-forwarded-for"] || request.socket?.remoteAddress || request.ip || "unknown")
      .split(",")[0]
      .trim()
      .slice(0, 80);
  }

  function sweepSuggestionCaptchas() {
    const now = Date.now();
    for (const [id, captcha] of publicSuggestionCaptchas.entries()) {
      if (!captcha || captcha.expiresAt <= now) {
        publicSuggestionCaptchas.delete(id);
      }
    }
  }

  function createSuggestionCaptcha() {
    sweepSuggestionCaptchas();
    const left = Math.floor(Math.random() * 8) + 2;
    const right = Math.floor(Math.random() * 8) + 2;
    const id = crypto.randomUUID();
    publicSuggestionCaptchas.set(id, {
      answer: left + right,
      expiresAt: Date.now() + PUBLIC_SUGGESTION_CAPTCHA_TTL_MS
    });
    return {
      id,
      question: `${left} + ${right}`
    };
  }

  function verifySuggestionCaptcha(id = "", answer = "") {
    sweepSuggestionCaptchas();
    const captcha = publicSuggestionCaptchas.get(String(id || ""));
    publicSuggestionCaptchas.delete(String(id || ""));
    if (!captcha) return false;
    return Number(answer) === captcha.answer;
  }

  app.options("/api/public/members", (_request, response) => {
    setPublicApiHeaders(response);
    response.sendStatus(204);
  });

  app.options("/api/public/status", (_request, response) => {
    setPublicApiHeaders(response);
    response.sendStatus(204);
  });

  app.options("/api/public/commands", (_request, response) => {
    setPublicApiHeaders(response);
    response.sendStatus(204);
  });

  app.options("/api/public/archive", (_request, response) => {
    setPublicApiHeaders(response);
    response.sendStatus(204);
  });

  app.options("/api/public/suggestions", (_request, response) => {
    setPublicApiHeaders(response);
    response.sendStatus(204);
  });

  app.options("/api/public/suggestions/captcha", (_request, response) => {
    setPublicApiHeaders(response);
    response.sendStatus(204);
  });

  app.options("/api/public/game-leaderboard", (_request, response) => {
    setPublicApiHeaders(response);
    response.sendStatus(204);
  });

  app.options("/api/public/dash-claim", (_request, response) => {
    setPublicApiHeaders(response);
    response.sendStatus(204);
  });

  app.options("/api/public/dash-claim/redeem", (_request, response) => {
    setPublicApiHeaders(response);
    response.sendStatus(204);
  });

  app.options("/api/public/eight-ball/*", (_request, response) => {
    setPublicApiHeaders(response);
    response.sendStatus(204);
  });

  app.options("/api/public/eight-ball", (_request, response) => {
    setPublicApiHeaders(response);
    response.sendStatus(204);
  });

  app.get("/api/public/members", (_request, response) => {
    setPublicApiHeaders(response);
    const config = getPublicGuildConfig();
    response.json({
      members: publicMembersFromConfig(config),
      updatedAt: new Date().toISOString()
    });
  });

  app.get("/api/public/status", (_request, response) => {
    setPublicApiHeaders(response);
    const configuredGuild = guildId ? client.guilds.cache.get(guildId) : client.guilds.cache.first();
    const config = getPublicGuildConfig();
    response.json({
      ready: client.isReady(),
      botTag: client.user?.tag || "",
      guildCount: client.guilds.cache.size,
      memberCount: configuredGuild?.memberCount || 0,
      uptimeSeconds: Math.round(process.uptime()),
      aiConfigured: ai.enabled,
      applicationsEnabled: Boolean(config?.applications?.enabled),
      currentEvent: config?.community?.rituals?.currentEvent || "",
      seasonalMessage: config?.community?.rituals?.seasonalMessage || "",
      snapshot: communitySnapshot(config),
      updatedAt: new Date().toISOString()
    });
  });

  app.get("/api/public/commands", (_request, response) => {
    setPublicApiHeaders(response);
    response.json({
      commands: commandList.map((command) => ({
        name: command.name,
        category: command.category || "Other",
        description: command.description || "",
        usage: command.usage || command.name,
        aliases: command.aliases || []
      })),
      updatedAt: new Date().toISOString()
    });
  });

  app.get("/api/public/archive", (_request, response) => {
    setPublicApiHeaders(response);
    const config = getPublicGuildConfig();
    response.json({
      lore: CHIPKITTLE_LORE,
      rituals: config?.community?.rituals || {},
      artifacts: config?.community?.artifacts || [],
      updatedAt: new Date().toISOString()
    });
  });

  app.get("/api/public/suggestions", (_request, response) => {
    setPublicApiHeaders(response);
    const config = getPublicGuildConfig();
    response.json({
      suggestions: storedSuggestions(config || {})
        .filter((suggestion) => String(suggestion.status || "submitted") !== "denied")
        .slice(0, 12)
        .map(publicSuggestionPayload),
      staffDmConfigured: Boolean(suggestionStaffUserId(config || {})),
      updatedAt: new Date().toISOString()
    });
  });

  app.get("/api/public/suggestions/captcha", (_request, response) => {
    setPublicApiHeaders(response);
    response.json(createSuggestionCaptcha());
  });

  app.post("/api/public/suggestions", async (request, response) => {
    try {
      setPublicApiHeaders(response);
      const throttleKey = publicSuggestionThrottleKey(request);
      const now = Date.now();
      const previousSubmission = publicSuggestionCooldowns.get(throttleKey) || 0;
      if (now - previousSubmission < PUBLIC_SUGGESTION_COOLDOWN_MS) {
        response.status(429).json({ error: "Please wait a minute before sending another suggestion." });
        return;
      }

      const targetGuildId = getPublicGuildId();
      const config = targetGuildId ? store.getGuild(targetGuildId) : getPublicGuildConfig();
      if (!targetGuildId || !config) {
        response.status(503).json({ error: "The suggestion box is not ready yet." });
        return;
      }

      const blockedTerm = blockedSuggestionTerm(request.body, config);
      if (blockedTerm) {
        response.status(400).json({ error: "That suggestion contains blocked language." });
        return;
      }

      if (!verifySuggestionCaptcha(request.body?.captchaId, request.body?.captchaAnswer)) {
        response.status(400).json({ error: "Captcha failed. Please answer the new question and try again." });
        return;
      }

      const suggestion = createSuggestionRecord({
        source: "website",
        authorId: request.body?.discordId,
        authorName: request.body?.name,
        title: request.body?.title,
        body: request.body?.body || request.body?.suggestion
      });
      if (suggestion.body.length < 8) {
        response.status(400).json({ error: "Please write a little more before sending that suggestion." });
        return;
      }

      publicSuggestionCooldowns.set(throttleKey, now);
      const updatedConfig = await store.updateGuild(targetGuildId, {
        community: {
          ...config.community,
          suggestions: [suggestion, ...storedSuggestions(config)].slice(0, 250)
        }
      });
      await sendSuggestionStaffDm(client, updatedConfig, suggestion);
      await addAuditLog(store, targetGuildId, {
        type: "suggestions",
        label: "Website suggestion submitted",
        details: `${suggestion.authorName || "Anonymous"} submitted a public website suggestion.`,
        actor: "Website"
      }).catch(() => {});
      response.json({ ok: true, suggestion: publicSuggestionPayload(suggestion), updatedAt: new Date().toISOString() });
    } catch (error) {
      console.error("Public suggestion submission failed:", error);
      response.status(500).json({ error: "The suggestion box could not save that yet." });
    }
  });

  app.get("/api/public/game-leaderboard", (request, response) => {
    setPublicApiHeaders(response);
    const config = getPublicGuildConfig();
    response.json({
      scores: publicLeaderboardEntries(readGameLeaderboard(), request.query.game, publicGameSettings(config)),
      updatedAt: new Date().toISOString()
    });
  });

  app.post("/api/public/game-leaderboard", (request, response) => {
    setPublicApiHeaders(response);
    const config = getPublicGuildConfig();
    const settings = publicGameSettings(config);
    const blockedTerm = blockedLeaderboardTerm(request.body?.name, config);
    const previousTop = publicLeaderboardEntries(readGameLeaderboard(), request.body?.game, settings)[0] || null;
    const entry = {
      game: cleanGameId(request.body?.game),
      name: cleanLeaderboardName(request.body?.name),
      score: Math.min(Math.max(Math.floor(Number(request.body?.score) || 0), 0), settings.maxLeaderboardScore),
      bread: Math.min(Math.max(Math.floor(Number(request.body?.bread) || 0), 0), settings.maxLeaderboardBread),
      createdAt: new Date().toISOString()
    };

    if (blockedTerm) {
      response.status(400).json({ error: "That player name is blocked on this leaderboard." });
      return;
    }

    if (entry.score <= 0) {
      response.status(400).json({ error: "Score must be greater than zero." });
      return;
    }

    writeGameLeaderboard([...readGameLeaderboard(), entry], settings);
    if (!previousTop || entry.score > Number(previousTop.score || 0)) {
      sendGameRecordAlert(client, settings.recordAlertChannelId, entry, previousTop).catch(() => {});
    }
    response.json({
      scores: publicLeaderboardEntries(readGameLeaderboard(), entry.game, settings),
      updatedAt: new Date().toISOString()
    });
  });

  app.post("/api/public/dash-claim", (request, response) => {
    setPublicApiHeaders(response);
    const config = getPublicGuildConfig();
    const settings = publicGameSettings(config);
    const blockedTerm = blockedLeaderboardTerm(request.body?.name, config);
    const entry = {
      game: cleanGameId(request.body?.game),
      name: cleanLeaderboardName(request.body?.name),
      score: Math.min(Math.max(Math.floor(Number(request.body?.score) || 0), 0), settings.maxLeaderboardScore),
      bread: Math.min(Math.max(Math.floor(Number(request.body?.bread) || 0), 0), settings.maxClaimBreadPerRun)
    };

    if (blockedTerm) {
      response.status(400).json({ error: "That player name is blocked for game claims." });
      return;
    }

    if (entry.bread <= 0) {
      response.status(400).json({ error: "Bread must be greater than zero." });
      return;
    }

    const claim = createDashClaim(entry);
    response.json({
      claimCode: claim?.code || "",
      claimBread: claim?.bread || 0,
      updatedAt: new Date().toISOString()
    });
  });

  app.post("/api/public/dash-claim/redeem", async (request, response) => {
    setPublicApiHeaders(response);
    try {
      const targetGuildId = getPublicGuildId();
      const discordId = String(request.body?.discordId || "").replace(/\D/g, "");
      if (!targetGuildId) {
        response.status(503).json({ error: "The Discord server is not available yet." });
        return;
      }
      if (!/^\d{16,22}$/.test(discordId)) {
        response.status(400).json({ error: "Enter a valid Discord user ID." });
        return;
      }

      const discordGuild = client.guilds.cache.get(targetGuildId);
      const member = await discordGuild?.members.fetch(discordId).catch(() => null);
      if (!member) {
        response.status(404).json({ error: "That Discord ID was not found in the #CK server." });
        return;
      }

      const claim = redeemDashClaim({
        code: request.body?.code,
        guildId: targetGuildId,
        userId: discordId
      });
      if (!claim.ok) {
        response.status(400).json({ error: claim.error });
        return;
      }

      const config = store.getGuild(targetGuildId);
      const economy = config.economy || {};
      const balances = { ...(economy.balances || {}) };
      const current = Math.max(Math.floor(Number(balances[discordId]) || 0), 0);
      balances[discordId] = current + claim.bread;
      await store.updateGuild(targetGuildId, {
        economy: {
          ...economy,
          balances
        }
      });
      await addAuditLog(store, targetGuildId, {
        type: "economy",
        label: "Dash claim redeemed",
        details: `${member.user.tag} claimed ${claim.bread.toLocaleString()} bread from ${claim.name || "a Dash run"} on the website.`,
        actor: "Website",
        action: "dash_claim_redeem",
        targetId: discordId,
        targetTag: member.user.tag
      }).catch(() => {});
      response.json({
        ok: true,
        bread: claim.bread,
        balance: balances[discordId],
        userTag: member.user.tag,
        updatedAt: new Date().toISOString()
      });
    } catch (error) {
      console.error("Dash claim redeem failed:", error);
      response.status(500).json({ error: "Could not redeem that claim right now." });
    }
  });

  app.post("/api/public/eight-ball/create", (request, response) => {
    setPublicApiHeaders(response);
    try {
      const payload = createEightBallRoom(request.body?.playerName);
      response.json(payload);
    } catch (error) {
      response.status(400).json({ error: error.message || "Could not create a room." });
    }
  });

  app.post("/api/public/eight-ball/:roomCode/join", (request, response) => {
    setPublicApiHeaders(response);
    try {
      const payload = joinEightBallRoom(request.params.roomCode, request.body?.playerName);
      response.json(payload);
    } catch (error) {
      response.status(400).json({ error: error.message || "Could not join that room." });
    }
  });

  app.get("/api/public/eight-ball/:roomCode", (request, response) => {
    setPublicApiHeaders(response);
    try {
      const state = getEightBallRoomState(
        request.params.roomCode,
        String(request.query.token || ""),
        { sinceShotId: Number(request.query.sinceShotId) }
      );
      response.json(state);
    } catch (error) {
      response.status(404).json({ error: error.message || "That room could not be found." });
    }
  });

  app.post("/api/public/eight-ball/:roomCode/shoot", (request, response) => {
    setPublicApiHeaders(response);
    try {
      const state = shootEightBall(request.params.roomCode, String(request.body?.token || ""), {
        dx: Number(request.body?.dx),
        dy: Number(request.body?.dy),
        power: Number(request.body?.power),
        cuePlacement: request.body?.cuePlacement && typeof request.body.cuePlacement === "object"
          ? {
              x: Number(request.body.cuePlacement.x),
              y: Number(request.body.cuePlacement.y)
            }
          : null
      });
      response.json(state);
    } catch (error) {
      response.status(400).json({ error: error.message || "That shot failed." });
    }
  });

  app.post("/api/public/eight-ball/:roomCode/reset", (request, response) => {
    setPublicApiHeaders(response);
    try {
      const state = resetEightBallRoom(request.params.roomCode, String(request.body?.token || ""));
      response.json(state);
    } catch (error) {
      response.status(400).json({ error: error.message || "Could not reset that table." });
    }
  });

  app.get("/profile/login", (request, response) => {
    if (request.session.publicProfileUser) {
      response.redirect("/profile/edit");
      return;
    }
    response.send(profileLoginPage(loginErrorMessage(request.query.error), discordProfileOAuthUrl(request)));
  });

  app.get("/auth/discord/profile", (request, response) => {
    const url = discordProfileOAuthUrl(request);
    if (!url) {
      response.status(503).send(profileLoginPage("Discord OAuth is not configured yet.", ""));
      return;
    }
    response.redirect(url);
  });

  app.get("/auth/discord/profile/callback", async (request, response) => {
    const state = String(request.query.state || "");
    const code = String(request.query.code || "");
    const storedState = profileOAuthStates.get(state);
    profileOAuthStates.delete(state);
    if (!storedState || Date.now() - storedState.createdAt > 10 * 60 * 1000 || !code) {
      response.redirect("/profile/login?error=state");
      return;
    }

    try {
      const discordUser = await exchangeDiscordOAuthCode(code, profileOAuthRedirectUri(request));
      const discordUserId = String(discordUser.id || "");
      const verified = await verifyProfileEditorMember(discordUserId);
      if (!verified.ok) {
        response.status(403).send(profileLoginPage(verified.reason, discordProfileOAuthUrl(request)));
        return;
      }
      request.session.publicProfileUser = {
        userId: discordUserId,
        guildId: verified.guildId,
        username: discordUser.username || discordUserId,
        displayName: verified.member.displayName
      };
      response.redirect("/profile/edit");
    } catch (error) {
      console.error("Discord profile OAuth failed:", error);
      response.redirect(`/profile/login?error=${error.oauthRedirectProblem ? "oauth-redirect" : "oauth"}`);
    }
  });

  app.get("/profile/edit", async (request, response) => {
    const sessionUser = request.session.publicProfileUser;
    if (!sessionUser?.userId) {
      response.redirect("/profile/login");
      return;
    }
    const verified = await verifyProfileEditorMember(sessionUser.userId);
    if (!verified.ok) {
      request.session.publicProfileUser = null;
      response.status(403).send(profileLoginPage(verified.reason, discordProfileOAuthUrl(request)));
      return;
    }
    request.session.publicProfileUser = {
      ...sessionUser,
      guildId: verified.guildId,
      displayName: verified.member.displayName
    };
    response.send(profileEditPage({
      config: store.getGuild(verified.guildId),
      member: verified.member,
      message: request.query.saved ? "Profile submitted for root approval." : ""
    }));
  });

  app.post("/profile/edit", async (request, response) => {
    const sessionUser = request.session.publicProfileUser;
    if (!sessionUser?.userId) {
      response.redirect("/profile/login");
      return;
    }
    const verified = await verifyProfileEditorMember(sessionUser.userId);
    if (!verified.ok) {
      request.session.publicProfileUser = null;
      response.status(403).send(profileLoginPage(verified.reason, discordProfileOAuthUrl(request)));
      return;
    }

    const displayName = String(request.body?.displayName || verified.member.displayName).trim().slice(0, 80) || verified.member.displayName;
    const title = String(request.body?.title || "Bread Initiate").trim().slice(0, 80) || "Bread Initiate";
    const pronouns = String(request.body?.pronouns || "").trim().slice(0, 40);
    const favoriteArtifact = String(request.body?.favoriteArtifact || "").trim().slice(0, 80);
    const quote = String(request.body?.quote || "").trim().slice(0, 140);
    const bio = String(request.body?.bio || "").trim().slice(0, 260) || "No ceremonial biography has been recorded yet.";
    const draft = {
      displayName,
      title,
      pronouns,
      favoriteArtifact,
      quote,
      bio,
      publicVisible: request.body?.publicVisible === "on"
    };
    const blockedTerm = blockedProfileTerm(draft, verified.config);
    if (blockedTerm) {
      response.status(400).send(profileEditPage({
        config: store.getGuild(verified.guildId),
        member: verified.member,
        error: `That profile edit was blocked by the profile filter: ${blockedTerm}.`
      }));
      return;
    }

    const currentConfig = store.getGuild(verified.guildId);
    await store.updateGuild(verified.guildId, {
      community: {
        profileEdits: {
          ...(currentConfig.community?.profileEdits || {}),
          [verified.member.id]: {
            status: "pending",
            draft,
            username: verified.member.user.tag,
            submittedAt: new Date().toISOString()
          }
        }
      }
    });
    await addAuditLog(store, verified.guildId, {
      type: "profile",
      label: "Public profile edit submitted",
      details: `${verified.member.user.tag} submitted a public profile edit for root approval.`,
      actor: verified.member.user.tag,
      targetId: verified.member.id,
      targetTag: verified.member.user.tag
    }).catch(() => {});
    response.redirect("/profile/edit?saved=1");
  });

  app.post("/profile/logout", (request, response) => {
    request.session.publicProfileUser = null;
    response.redirect("/profile/login");
  });

  app.post("/guilds/:guildId/profiles/:userId/approve", requireAuth, requirePanelLevel("root"), async (request, response, next) => {
    try {
      const targetGuildId = String(request.params.guildId || "");
      const targetUserId = String(request.params.userId || "");
      const discordGuild = client.guilds.cache.get(targetGuildId);
      if (!discordGuild) {
        response.status(404).send("Server not found.");
        return;
      }
      const config = store.getGuild(targetGuildId);
      const pending = config.community?.profileEdits?.[targetUserId];
      if (!pending || pending.status !== "pending" || !pending.draft) {
        response.redirect(`/guilds/${targetGuildId}?section=members&saved=1`);
        return;
      }
      const blockedTerm = blockedProfileTerm(pending.draft, config);
      if (blockedTerm) {
        response.redirect(`/guilds/${targetGuildId}?section=members&update=${encodeURIComponent(`profile-filter-${blockedTerm}`)}`);
        return;
      }
      const member = discordGuild.members.cache.get(targetUserId) || await discordGuild.members.fetch(targetUserId).catch(() => null);
      await updateProfile(store, targetGuildId, targetUserId, (profile) => ({
        ...profile,
        ...pending.draft
      }), member?.displayName || pending.draft.displayName || targetUserId);
      const nextConfig = store.getGuild(targetGuildId);
      const nextProfileEdits = { ...(nextConfig.community?.profileEdits || {}) };
      delete nextProfileEdits[targetUserId];
      await store.updateGuild(targetGuildId, {
        community: {
          profileEdits: nextProfileEdits
        }
      });
      await addAuditLog(store, targetGuildId, {
        type: "profile",
        label: "Public profile edit approved",
        details: `${pending.username || targetUserId}'s website profile edit was approved by root.`,
        actor: currentPanelUser(request, targetGuildId)?.username || "Panel",
        targetId: targetUserId,
        targetTag: pending.username || targetUserId
      }).catch(() => {});
      writePublicMembersFile(publicMembersFromConfig(store.getGuild(targetGuildId)));
      response.redirect(`/guilds/${targetGuildId}?section=members&saved=1`);
    } catch (error) {
      next(error);
    }
  });

  app.post("/guilds/:guildId/profiles/:userId/reject", requireAuth, requirePanelLevel("root"), async (request, response, next) => {
    try {
      const targetGuildId = String(request.params.guildId || "");
      const targetUserId = String(request.params.userId || "");
      const config = store.getGuild(targetGuildId);
      const pending = config.community?.profileEdits?.[targetUserId];
      const nextProfileEdits = { ...(config.community?.profileEdits || {}) };
      delete nextProfileEdits[targetUserId];
      await store.updateGuild(targetGuildId, {
        community: {
          profileEdits: nextProfileEdits
        }
      });
      await addAuditLog(store, targetGuildId, {
        type: "profile",
        label: "Public profile edit rejected",
        details: `${pending?.username || targetUserId}'s website profile edit was rejected by root.`,
        actor: currentPanelUser(request, targetGuildId)?.username || "Panel",
        targetId: targetUserId,
        targetTag: pending?.username || targetUserId
      }).catch(() => {});
      response.redirect(`/guilds/${targetGuildId}?section=members&saved=1`);
    } catch (error) {
      next(error);
    }
  });

  app.get("/login", (request, response) => {
    if (request.session.authenticated) {
      response.redirect("/");
      return;
    }

    response.send(loginPage(loginErrorMessage(request.query.error), discordOAuthUrl(request), oauthDiagnosticInfo(request)));
  });

  app.post("/login", (request, response) => {
    response.redirect("/auth/discord");
  });

  app.get("/recovery", (request, response) => {
    response.send(recoveryPage());
  });

  app.post("/recovery", async (request, response) => {
    const discordId = String(request.body?.discordId || "").replace(/\D/g, "");
    const code = String(request.body?.code || "").trim();
    const throttle = readLoginThrottle(request, `recovery:${discordId}`);
    if (throttle.limited) {
      response.status(429).send(recoveryPage("Too many recovery attempts. Please wait 15 minutes and try again."));
      return;
    }
    if (!/^\d{16,22}$/.test(discordId) || !code) {
      recordFailedLogin(request, `recovery:${discordId}`);
      response.status(400).send(recoveryPage("Enter a valid Discord ID and recovery code."));
      return;
    }

    for (const [storedGuildId, config] of Object.entries(store.data?.guilds || {})) {
      const codes = config.panelAccess?.recoveryCodes || [];
      const index = codes.findIndex((entry) => verifyPanelPassword(code, entry.hash || entry));
      if (index === -1) continue;
      const nextCodes = [...codes];
      nextCodes.splice(index, 1);
      await store.updateGuild(storedGuildId, {
        panelAccess: {
          ...config.panelAccess,
          recoveryCodes: nextCodes,
          users: {
            ...(config.panelAccess?.users || {}),
            [discordId]: {
              ...(config.panelAccess?.users?.[discordId] || {}),
              username: config.panelAccess?.users?.[discordId]?.username || discordId,
              level: "root",
              grantedAt: new Date().toISOString(),
              grantedBy: "recovery-code",
              recoveryGrantedAt: new Date().toISOString()
            }
          }
        }
      });
      await auditPanelLogin(storedGuildId, "Root recovery code redeemed", `${discordId} redeemed a backup root recovery code.`, "Panel Recovery", { targetId: discordId });
      clearFailedLogins(request, `recovery:${discordId}`);
      response.send(recoveryPage("", "Recovery code accepted. You can now sign in with Discord OAuth using that Discord account."));
      return;
    }

    recordFailedLogin(request, `recovery:${discordId}`);
    await auditPanelLogin(currentPanelGuildId(), "Root recovery code failed", `${discordId} attempted recovery with an invalid code.`, "Panel Recovery", { targetId: discordId });
    response.status(401).send(recoveryPage("That recovery code was invalid or already used."));
  });

  app.get("/auth/discord", (request, response) => {
    const throttle = readLoginThrottle(request, "discord-oauth");
    if (throttle.limited) {
      response.status(429).send(loginPage("Too many sign-in attempts. Please wait 15 minutes and try again.", ""));
      return;
    }
    const url = discordOAuthUrl(request);
    if (!url) {
      recordFailedLogin(request, "discord-oauth");
      response.status(503).send(loginPage("Discord OAuth is not configured. Set DISCORD_CLIENT_SECRET and restart the panel.", "", oauthDiagnosticInfo(request)));
      return;
    }
    response.redirect(url);
  });

  app.get("/auth/discord/callback", async (request, response) => {
    const state = String(request.query.state || "");
    const code = String(request.query.code || "");
    const storedState = oauthStates.get(state);
    oauthStates.delete(state);
    if (!storedState || Date.now() - storedState.createdAt > 10 * 60 * 1000 || !code) {
      recordFailedLogin(request, "discord-oauth");
      response.redirect("/login?error=state");
      return;
    }

    try {
      const tokenBody = new URLSearchParams({
        client_id: clientId,
        client_secret: discordClientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: oauthRedirectUri(request)
      });
      const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenBody
      });
      if (!tokenResponse.ok) {
        const body = await tokenResponse.text().catch(() => "");
        const error = new Error(`Token exchange failed: ${tokenResponse.status} ${body}`);
        error.oauthRedirectProblem = /redirect_uri|invalid_grant/i.test(body);
        throw error;
      }
      const token = await tokenResponse.json();
      const userResponse = await fetch("https://discord.com/api/users/@me", {
        headers: { Authorization: `Bearer ${token.access_token}` }
      });
      if (!userResponse.ok) throw new Error(`User fetch failed: ${userResponse.status}`);
      const discordUser = await userResponse.json();
      const discordUserId = String(discordUser.id || "");
      const access = findPanelAccessForDiscordUser(discordUserId) || fallbackOwnerRoot(discordUserId);
      if (!access) {
        const auditGuildId = currentPanelGuildId();
        await auditPanelLogin(auditGuildId, "Panel OAuth denied", `${discordUser.username || discordUserId} tried to sign in without panel access.`, "Panel Auth", { targetId: discordUserId });
        recordFailedLogin(request, "discord-oauth");
        response.redirect("/login?error=denied");
        return;
      }

      clearFailedLogins(request, "discord-oauth");
      await finishPanelLogin(request, response, access, discordUser);
    } catch (error) {
      console.error("Discord OAuth login failed:", error);
      recordFailedLogin(request, "discord-oauth");
      await auditPanelLogin(currentPanelGuildId(), "Panel OAuth failed", "OAuth callback failed.", "Panel Auth");
      response.redirect(`/login?error=${error.oauthRedirectProblem ? "oauth-redirect" : "oauth"}`);
    }
  });

  app.post("/account/password", requireAuth, async (request, response, next) => {
    try {
      const panelUser = currentPanelUser(request, request.session.panelGuildId);
      if (!panelUser) {
        response.redirect("/login?error=access-expired");
        return;
      }
      const password = String(request.body?.password || "");
      const confirm = String(request.body?.confirmPassword || "");
      if (password.length < 12 || password !== confirm) {
        response.redirect("/account?account=password-invalid");
        return;
      }
      const config = store.getGuild(request.session.panelGuildId);
      const entry = config.panelAccess?.users?.[panelUser.userId] || {};
      await store.updateGuild(request.session.panelGuildId, {
        panelAccess: {
          ...config.panelAccess,
          users: {
            ...config.panelAccess.users,
            [panelUser.userId]: {
              ...entry,
              passwordHash: hashPanelPassword(password),
              passwordChangedAt: new Date().toISOString(),
              passwordResetRequired: false
            }
          }
        }
      });
      await auditPanelLogin(request.session.panelGuildId, "Panel recovery password changed", `${panelUserLabel(panelUser)} changed their recovery password.`, panelUserLabel(panelUser), { targetId: panelUser.userId });
      response.redirect("/account?account=password-updated");
    } catch (error) {
      next(error);
    }
  });

  app.post("/account/sessions/:sessionId/revoke", requireAuth, async (request, response) => {
    const sessionId = String(request.params.sessionId || "");
    if (sessionId && sessionId !== request.sessionID) {
      sessionStore.destroy(sessionId, () => {});
      activePanelSessions.delete(sessionId);
    }
    response.redirect("/account?account=session-revoked");
  });

  app.post("/admin/sessions/logout-all", requireAuth, requirePanelLevel("root"), async (request, response) => {
    const targetGuildId = request.session.panelGuildId || currentPanelGuildId();
    const config = store.getGuild(targetGuildId);
    const now = new Date().toISOString();
    await store.updateGuild(targetGuildId, {
      panelAccess: {
        ...config.panelAccess,
        sessionsRevokedBefore: now
      }
    });
    for (const sessionId of [...activePanelSessions.keys()]) {
      if (sessionId !== request.sessionID) sessionStore.destroy(sessionId, () => {});
      if (sessionId !== request.sessionID) activePanelSessions.delete(sessionId);
    }
    await auditPanelLogin(targetGuildId, "All panel sessions revoked", `${panelUserLabel(currentPanelUser(request, targetGuildId))} signed out all other panel sessions.`, panelUserLabel(currentPanelUser(request, targetGuildId)));
    response.redirect("/account?account=all-sessions-revoked");
  });

  app.get("/account", requireAuth, (request, response) => {
    const targetGuildId = request.session.panelGuildId || currentPanelGuildId();
    const panelUser = currentPanelUser(request, targetGuildId);
    if (!panelUser) {
      response.redirect("/login?error=access-expired");
      return;
    }
    const sessions = [...activePanelSessions.values()]
      .filter((entry) => entry.userId === panelUser.userId)
      .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));
    response.send(accountPage({
      panelUser,
      sessions,
      currentSessionId: request.sessionID,
      flash: accountFlash(request.query.account),
      isRoot: panelAccessAtLeast(panelUser.level, "root")
    }));
  });

  app.get("/logout", (request, response) => {
    activePanelSessions.delete(request.sessionID);
    request.session.destroy(() => response.redirect("/login"));
  });

  function sendDashboard(request, response) {
    const guilds = client.guilds.cache.map(serializeGuild).sort((a, b) => a.name.localeCompare(b.name));
    if (guildId) {
      const pinnedGuild = client.guilds.cache.get(guildId);
      if (pinnedGuild) {
        response.redirect(`/guilds/${pinnedGuild.id}${request.query.saved ? "?saved=1" : request.query.update ? `?update=${encodeURIComponent(request.query.update)}` : ""}`);
        return;
      }
    }

    if (guilds.length === 1) {
      response.redirect(`/guilds/${guilds[0].id}${request.query.saved ? "?saved=1" : request.query.update ? `?update=${encodeURIComponent(request.query.update)}` : ""}`);
      return;
    }

    response.send(dashboardPage({ guilds, client, clientId, ai, commandList, flash: flashFromQuery(request.query) }));
  }

  app.get("/", requireAuth, sendDashboard);
  app.get("/panel", requireAuth, sendDashboard);

  app.get("/commits", requireAuth, async (_request, response) => {
    try {
      response.send(commitsPage({ commits: await recentCommits(30) }));
    } catch (error) {
      console.error("Could not read commits:", error);
      response.send(commitsPage({ commits: [], error: "Could not read git commits on this server." }));
    }
  });

  app.get("/guilds/:guildId", requireAuth, async (request, response, next) => {
    const discordGuild = client.guilds.cache.get(request.params.guildId);
    if (!discordGuild) {
      response.status(404).send(layout({ title: "Not found", user: true, body: '<p class="empty">Server not found.</p>' }));
      return;
    }

    try {
      const guild = serializeGuild(discordGuild);
      const config = store.getGuild(guild.id);
      const panelUser = currentPanelUser(request, guild.id);
      const viewAs = normalizePanelAccessLevel(request.query.viewAs);
      const effectiveLevel = viewAs && panelAccessAtLeast(panelUser?.level || "root", viewAs) ? viewAs : panelUser?.level || "root";
      const activeSection = allowedPanelSection(String(request.query.section || ""), effectiveLevel);
      const moderationMembers =
        activeSection === "moderation"
          ? await moderationMemberPage(discordGuild, config, {
              search: String(request.query.modSearch || ""),
              after: String(request.query.modAfter || "")
            })
          : null;
      const economyMembers =
        activeSection === "economy"
          ? await moderationMemberPage(discordGuild, config, {
              search: String(request.query.econSearch || ""),
              after: String(request.query.econAfter || "")
            })
          : null;
      const labels = activeSection === "moderation" ? await warningMemberLabels(discordGuild, config) : {};
      response.send(guildPage({
        guild,
        config,
        commandList,
        defaultAiModel,
        ai,
        flash: flashFromQuery(request.query),
        activeSection,
        moderationMembers,
        economyMembers,
        warningMemberLabels: labels,
        panelUser: viewAs ? { ...panelUser, level: effectiveLevel, username: `${panelUser?.username || "User"} viewing as ${panelAccessLabel(effectiveLevel)}` } : panelUser
      }));
    } catch (error) {
      next(error);
    }
  });

  app.post("/admin/update", requireAuth, requirePanelLevel("root"), (request, response) => {
    const status = readUpdateStatus();
    if (ACTIVE_UPDATE_STATUSES.has(status?.status) && !status.stale) {
      response.redirect(`${updateRedirectTarget(request)}busy`);
      return;
    }

    try {
      const scriptPath = path.join(process.cwd(), "scripts", "panel-update.mjs");
      const child = spawn(process.execPath, [scriptPath], {
        cwd: process.cwd(),
        detached: true,
        stdio: "ignore",
        env: process.env
      });
      child.unref();
      response.redirect(`${updateRedirectTarget(request)}started`);
    } catch (error) {
      console.error("Could not start panel update:", error);
      response.redirect(`${updateRedirectTarget(request)}failed`);
    }
  });

  app.post("/admin/restart", requireAuth, requirePanelLevel("root"), (request, response) => {
    const status = readUpdateStatus();
    if (ACTIVE_UPDATE_STATUSES.has(status?.status) && !status.stale) {
      response.redirect(`${updateRedirectTarget(request)}busy`);
      return;
    }

    try {
      const scriptPath = path.join(process.cwd(), "scripts", "panel-restart.mjs");
      const child = spawn(process.execPath, [scriptPath], {
        cwd: process.cwd(),
        detached: true,
        stdio: "ignore",
        env: process.env
      });
      child.unref();
      response.redirect(`${updateRedirectTarget(request)}restart-started`);
    } catch (error) {
      console.error("Could not start panel restart:", error);
      response.redirect(`${updateRedirectTarget(request)}restart-failed`);
    }
  });

  app.get("/admin/export/config", requireAuth, requirePanelLevel("root"), (_request, response) => {
    downloadJson(response, "chipkittle-config.json", sanitizeStoreDataForExport(store.data || { guilds: {} }));
  });

  app.get("/admin/export/community", requireAuth, requirePanelLevel("root"), (_request, response) => {
    const payload = Object.fromEntries(
      Object.entries(store.data?.guilds || {}).map(([guildEntryId, config]) => [
        guildEntryId,
        {
          community: config.community || {},
          publicSite: config.publicSite || {},
          moderation: {
            warnings: config.moderation?.warnings || {},
            logChannelId: config.moderation?.logChannelId || ""
          },
          applications: {
            enabled: config.applications?.enabled || false,
            questions: config.applications?.questions || []
          }
        }
      ])
    );
    downloadJson(response, "chipkittle-community-export.json", payload);
  });

  app.get("/admin/export/moderation", requireAuth, requirePanelLevel("root"), (_request, response) => {
    const payload = Object.fromEntries(
      Object.entries(store.data?.guilds || {}).map(([guildEntryId, config]) => [
        guildEntryId,
        {
          warnings: config.moderation?.warnings || {},
          auditLog: config.community?.auditLog || [],
          exportedAt: new Date().toISOString()
        }
      ])
    );
    downloadJson(response, "chipkittle-moderation-export.json", payload);
  });

  app.get("/admin/export/applications", requireAuth, requirePanelLevel("root"), (_request, response) => {
    const payload = Object.fromEntries(
      Object.entries(store.data?.guilds || {}).map(([guildEntryId, config]) => [
        guildEntryId,
        {
          enabled: config.applications?.enabled || false,
          channelId: config.applications?.channelId || "",
          threadChannelId: config.applications?.threadChannelId || "",
          reviewerRoleIds: config.applications?.reviewerRoleIds || [],
          approvedRoleId: config.applications?.approvedRoleId || "",
          blockedRoleIds: config.applications?.blockedRoleIds || [],
          cooldownMinutes: config.applications?.cooldownMinutes || 0,
          questions: config.applications?.questions || [],
          cooldowns: config.applications?.cooldowns || {},
          tickets: config.applications?.tickets || {},
          exportedAt: new Date().toISOString()
        }
      ])
    );
    downloadJson(response, "chipkittle-applications-export.json", payload);
  });

  app.get("/admin/export/public", requireAuth, requirePanelLevel("root"), (_request, response) => {
    const payload = Object.fromEntries(
      Object.entries(store.data?.guilds || {}).map(([guildEntryId, config]) => [
        guildEntryId,
        {
          publicSite: config.publicSite || {},
          rituals: config.community?.rituals || {},
          artifacts: config.community?.artifacts || [],
          leaderboard: publicLeaderboardFileEntries(readGameLeaderboard(), publicGameSettings(config)),
          exportedAt: new Date().toISOString()
        }
      ])
    );
    downloadJson(response, "chipkittle-public-site-export.json", payload);
  });

  app.get("/admin/export/full", requireAuth, requirePanelLevel("root"), (_request, response) => {
    downloadJson(response, "chipkittle-backup-snapshot.json", {
      generatedAt: new Date().toISOString(),
      guilds: sanitizeStoreDataForExport({ guilds: store.data?.guilds || {} }).guilds
    });
  });

  app.post("/admin/restore", requireAuth, requirePanelLevel("root"), async (request, response, next) => {
    try {
      const targetGuildId = String(request.body?.guildId || guildId || client.guilds.cache.first()?.id || "");
      const discordGuild = client.guilds.cache.get(targetGuildId);
      if (!discordGuild) {
        response.status(404).send("Server not found.");
        return;
      }

      const scope = String(request.body?.restoreScope || "config").toLowerCase();
      const payloadText = String(request.body?.restorePayload || "").trim();
      if (!payloadText) {
        response.redirect(`/guilds/${discordGuild.id}?section=server&update=${encodeURIComponent("restore-empty")}`);
        return;
      }

      const parsed = JSON.parse(payloadText);
      const partial = restorePartialForScope(scope, parsed, discordGuild.id);
      if (!partial || typeof partial !== "object") {
        response.redirect(`/guilds/${discordGuild.id}?section=server&update=${encodeURIComponent("restore-invalid")}`);
        return;
      }

      const mergedConfig = await store.updateGuild(discordGuild.id, partial);
      if (partial.publicSite || partial.community?.artifacts || partial.community?.rituals) {
        writePublicMembersFile(publicMembersFromConfig(mergedConfig));
      }
      await addAuditLog(store, discordGuild.id, {
        type: "panel",
        label: "Snapshot restored",
        details: `Restored ${scope} data from the web panel.`,
        actor: "Panel"
      }).catch(() => {});
      response.redirect(`/guilds/${discordGuild.id}?saved=1&section=server`);
    } catch (error) {
      if (error instanceof SyntaxError) {
        const targetGuildId = String(request.body?.guildId || guildId || client.guilds.cache.first()?.id || "");
        response.redirect(`/guilds/${encodeURIComponent(targetGuildId)}?section=server&update=${encodeURIComponent("restore-json-error")}`);
        return;
      }
      next(error);
    }
  });

  app.post("/guilds/:guildId/audit/:logId/delete", requireAuth, requirePanelLevel("root"), async (request, response, next) => {
    try {
      const discordGuild = client.guilds.cache.get(request.params.guildId);
      if (!discordGuild) {
        response.status(404).send("Server not found.");
        return;
      }
      await deleteAuditLog(store, discordGuild.id, request.params.logId);
      response.redirect(`/guilds/${discordGuild.id}?saved=1&section=audit`);
    } catch (error) {
      next(error);
    }
  });

  app.post("/guilds/:guildId/moderation/action", requireAuth, async (request, response, next) => {
    const discordGuild = client.guilds.cache.get(request.params.guildId);
    if (!discordGuild) {
      response.status(404).send("Server not found.");
      return;
    }

    try {
      const action = String(request.body?.action || "").toLowerCase();
      const panelUser = currentPanelUser(request, discordGuild.id);
      const requiredLevel = ["kick", "ban"].includes(action) ? "keeper" : "round_table";
      if (!panelUser || !panelAccessAtLeast(panelUser.level, requiredLevel)) {
        response.status(403).send(layout({ title: "Forbidden", user: true, body: '<p class="empty">You do not have permission to run that moderation action.</p>' }));
        return;
      }
      const targetUserId = String(request.body?.targetUserId || "").trim();
      const reason = String(request.body?.reason || "No reason provided.").trim().slice(0, 500) || "No reason provided.";
      const config = store.getGuild(discordGuild.id);
      await discordGuild.members.fetchMe().catch(() => null);
      const member = await discordGuild.members.fetch(targetUserId).catch(() => null);
      if (!member) {
        response.redirect(moderationRedirect(discordGuild, request, "missing-target"));
        return;
      }

      await assertPanelActorCanModerate(discordGuild, panelUser, member);

      let output = "";
      let durationMs = 0;
      const moderatorTag = panelUserLabel(panelUser);

      if (action === "warn") {
        requireBotPermission(discordGuild, PermissionsBitField.Flags.ModerateMembers);
        await store.addWarning(discordGuild.id, member.id, {
          reason,
          moderatorId: panelUser.userId || "panel",
          createdAt: new Date().toISOString()
        });
        await sendPanelPunishmentNotice(member, {
          guildName: discordGuild.name,
          action: "warned",
          reason,
          moderatorTag
        });
        output = `${member.user.tag} was warned from the panel. Reason: ${reason}`;
      } else if (action === "timeout") {
        requireBotPermission(discordGuild, PermissionsBitField.Flags.ModerateMembers);
        durationMs = parsePanelDuration(request.body?.duration);
        if (!durationMs) {
          response.redirect(moderationRedirect(discordGuild, request, "bad-duration"));
          return;
        }
        durationMs = Math.min(durationMs, 28 * 86_400_000);
        assertModerationHierarchy(member, "moderatable");
        await member.timeout(durationMs, reason);
        await sendPanelPunishmentNotice(member, {
          guildName: discordGuild.name,
          action: "timed out",
          reason,
          durationLabel: formatPanelDuration(durationMs),
          moderatorTag
        });
        output = `${member.user.tag} was timed out from the panel for ${formatPanelDuration(durationMs)}. Reason: ${reason}`;
      } else if (action === "untimeout") {
        requireBotPermission(discordGuild, PermissionsBitField.Flags.ModerateMembers);
        assertModerationHierarchy(member, "moderatable");
        await member.timeout(null, reason);
        await sendPanelPunishmentNotice(member, {
          guildName: discordGuild.name,
          action: "removed from timeout",
          reason,
          moderatorTag
        });
        output = `${member.user.tag}'s timeout was removed from the panel. Reason: ${reason}`;
      } else if (action === "kick") {
        requireBotPermission(discordGuild, PermissionsBitField.Flags.KickMembers);
        assertModerationHierarchy(member, "kickable");
        await sendPanelPunishmentNotice(member, {
          guildName: discordGuild.name,
          action: "kicked",
          reason,
          moderatorTag
        });
        await member.kick(reason);
        output = `${member.user.tag} was kicked from the panel. Reason: ${reason}`;
      } else if (action === "ban") {
        requireBotPermission(discordGuild, PermissionsBitField.Flags.BanMembers);
        assertModerationHierarchy(member, "bannable");
        await sendPanelPunishmentNotice(member, {
          guildName: discordGuild.name,
          action: "banned",
          reason,
          moderatorTag
        });
        await member.ban({ reason });
        output = `${member.user.tag} was banned from the panel. Reason: ${reason}`;
      } else {
        response.redirect(moderationRedirect(discordGuild, request, "failed"));
        return;
      }

      const logOutput = `${output} Moderator: ${moderatorTag}`;
      await addAuditLog(store, discordGuild.id, {
        type: "moderation",
        label: `Panel ${action}`,
        action,
        details: logOutput,
        actor: moderatorTag,
        targetId: member.id,
        targetTag: member.user.tag,
        moderatorId: panelUser.userId || "panel",
        moderatorTag
      }).catch(() => {});
      await sendPanelModerationLog(discordGuild, store.getGuild(discordGuild.id), logOutput);
      response.redirect(moderationRedirect(discordGuild, request, "success"));
    } catch (error) {
      if (error?.panelStatus) {
        response.redirect(moderationRedirect(discordGuild, request, error.panelStatus));
        return;
      }
      if (error?.code === 50013) {
        response.redirect(moderationRedirect(discordGuild, request, "missing-permission"));
        return;
      }
      console.error("Panel moderation action failed:", error);
      response.redirect(moderationRedirect(discordGuild, request, "failed"));
    }
  });

  app.post("/guilds/:guildId/warnings/:userId/clear", requireAuth, requirePanelLevel("round_table"), async (request, response, next) => {
    try {
      const discordGuild = client.guilds.cache.get(request.params.guildId);
      if (!discordGuild) {
        response.status(404).send("Server not found.");
        return;
      }
      const panelUser = currentPanelUser(request, discordGuild.id);
      const actor = panelUserLabel(panelUser);
      await store.clearWarnings(discordGuild.id, String(request.params.userId || ""));
      await addAuditLog(store, discordGuild.id, {
        type: "warning",
        label: "Warnings cleared from panel",
        details: `Cleared warnings for ${request.params.userId} from the web panel.`,
        action: "clear_warnings",
        actor,
        targetId: String(request.params.userId || ""),
        moderatorId: panelUser?.userId || "panel",
        moderatorTag: actor
      }).catch(() => {});
      response.redirect(`/guilds/${discordGuild.id}?saved=1&section=moderation`);
    } catch (error) {
      next(error);
    }
  });

  app.post("/guilds/:guildId/economy/:userId/update", requireAuth, requirePanelLevel("root"), async (request, response, next) => {
    try {
      const discordGuild = client.guilds.cache.get(request.params.guildId);
      if (!discordGuild) {
        response.status(404).send("Server not found.");
        return;
      }

      const targetUserId = String(request.params.userId || "").trim();
      if (!/^\d{16,22}$/.test(targetUserId)) {
        response.redirect(`/guilds/${discordGuild.id}?section=economy&modAction=missing-target`);
        return;
      }

      const config = store.getGuild(discordGuild.id);
      const panelUser = currentPanelUser(request, discordGuild.id);
      const member = await discordGuild.members.fetch(targetUserId).catch(() => null);
      const wallet = Math.floor(clampPanelNumber(request.body?.wallet, DEFAULT_STARTING_BREAD, 0, 1000000000000));
      const bank = Math.floor(clampPanelNumber(request.body?.bank, 0, 0, 1000000000000));
      const userUpgrades = Object.fromEntries(
        PANEL_ECONOMY_UPGRADES.map((upgrade) => [
          upgrade.id,
          Math.floor(clampPanelNumber(request.body?.[`economyUpgrade_${upgrade.id}`], 0, 0, upgrade.maxLevel))
        ])
      );
      const economy = config.economy || {};
      const balances = { ...(economy.balances || {}), [targetUserId]: wallet };
      const bankBalances = { ...(economy.bankBalances || {}), [targetUserId]: bank };
      const upgrades = {
        ...(economy.upgrades || {}),
        [targetUserId]: userUpgrades
      };
      const dailyClaims = { ...(economy.dailyClaims || {}) };
      const dailyStreaks = { ...(economy.dailyStreaks || {}) };
      const cooldowns = {
        ...(economy.cooldowns || {}),
        gambling: { ...(economy.cooldowns?.gambling || {}) },
        beg: { ...(economy.cooldowns?.beg || {}) },
        work: { ...(economy.cooldowns?.work || {}) },
        interest: { ...(economy.cooldowns?.interest || {}) },
        casinoRobbery: { ...(economy.cooldowns?.casinoRobbery || {}) },
        robbers: { ...(economy.cooldowns?.robbers || {}) },
        robVictims: { ...(economy.cooldowns?.robVictims || {}) }
      };

      if (request.body?.resetDailyClaim === "on") delete dailyClaims[targetUserId];
      if (request.body?.resetDailyStreak === "on") delete dailyStreaks[targetUserId];
      if (request.body?.clearEconomyCooldowns === "on") {
        delete cooldowns.gambling[targetUserId];
        delete cooldowns.beg[targetUserId];
        delete cooldowns.work[targetUserId];
        delete cooldowns.interest[targetUserId];
        delete cooldowns.casinoRobbery[targetUserId];
        delete cooldowns.robbers[targetUserId];
        delete cooldowns.robVictims[targetUserId];
      }

      await store.updateGuild(discordGuild.id, {
        economy: {
          ...economy,
          balances,
          bankBalances,
          upgrades,
          dailyClaims,
          dailyStreaks,
          cooldowns
        }
      });

      await addAuditLog(store, discordGuild.id, {
        type: "economy",
        label: "User economy edited",
        details: `Set ${member?.user?.tag || targetUserId} to ${wallet.toLocaleString()} wallet bread, ${bank.toLocaleString()} bank bread, and updated economy upgrades.`,
        actor: panelUserLabel(panelUser),
        action: "economy_user_update",
        targetId: targetUserId,
        targetTag: member?.user?.tag || "",
        moderatorId: panelUser?.userId || "panel",
        moderatorTag: panelUserLabel(panelUser)
      }).catch(() => {});

      const search = encodeURIComponent(String(request.body?.econSearch || targetUserId));
      const after = String(request.body?.econAfter || "");
      response.redirect(`/guilds/${discordGuild.id}?saved=1&section=economy&econSearch=${search}${after ? `&econAfter=${encodeURIComponent(after)}` : ""}`);
    } catch (error) {
      next(error);
    }
  });

  app.post("/guilds/:guildId/applications/:userId/clear-ticket", requireAuth, requirePanelLevel("keeper"), async (request, response, next) => {
    try {
      const discordGuild = client.guilds.cache.get(request.params.guildId);
      if (!discordGuild) {
        response.status(404).send("Server not found.");
        return;
      }
      const config = store.getGuild(discordGuild.id);
      const tickets = { ...(config.applications?.tickets || {}) };
      delete tickets[String(request.params.userId || "")];
      await store.updateGuild(discordGuild.id, {
        applications: {
          ...config.applications,
          tickets
        }
      });
      await addAuditLog(store, discordGuild.id, {
        type: "application",
        label: "Application ticket cleared",
        details: `Cleared application ticket record for ${request.params.userId} from the web panel.`,
        actor: "Panel"
      }).catch(() => {});
      response.redirect(`/guilds/${discordGuild.id}?saved=1&section=applications`);
    } catch (error) {
      next(error);
    }
  });

  app.post("/guilds/:guildId/applications/:userId/clear-cooldown", requireAuth, requirePanelLevel("keeper"), async (request, response, next) => {
    try {
      const discordGuild = client.guilds.cache.get(request.params.guildId);
      if (!discordGuild) {
        response.status(404).send("Server not found.");
        return;
      }
      const config = store.getGuild(discordGuild.id);
      const cooldowns = { ...(config.applications?.cooldowns || {}) };
      delete cooldowns[String(request.params.userId || "")];
      await store.updateGuild(discordGuild.id, {
        applications: {
          ...config.applications,
          cooldowns
        }
      });
      await addAuditLog(store, discordGuild.id, {
        type: "application",
        label: "Application cooldown cleared",
        details: `Cleared application cooldown for ${request.params.userId} from the web panel.`,
        actor: "Panel"
      }).catch(() => {});
      response.redirect(`/guilds/${discordGuild.id}?saved=1&section=applications`);
    } catch (error) {
      next(error);
    }
  });

  app.post("/guilds/:guildId/community/staff-notes/:userId/clear", requireAuth, requirePanelLevel("root"), async (request, response, next) => {
    try {
      const discordGuild = client.guilds.cache.get(request.params.guildId);
      if (!discordGuild) {
        response.status(404).send("Server not found.");
        return;
      }
      const config = store.getGuild(discordGuild.id);
      const staffNotes = { ...(config.community?.staffNotes || {}) };
      delete staffNotes[String(request.params.userId || "")];
      await store.updateGuild(discordGuild.id, {
        community: {
          ...config.community,
          staffNotes
        }
      });
      await addAuditLog(store, discordGuild.id, {
        type: "staff-note",
        label: "Staff notes cleared",
        details: `Cleared staff notes for ${request.params.userId} from the web panel.`,
        actor: "Panel"
      }).catch(() => {});
      response.redirect(`/guilds/${discordGuild.id}?saved=1&section=community`);
    } catch (error) {
      next(error);
    }
  });

  app.post("/guilds/:guildId/panel-access/:userId/revoke", requireAuth, async (request, response, next) => {
    try {
      const discordGuild = client.guilds.cache.get(request.params.guildId);
      if (!discordGuild) {
        response.status(404).send("Server not found.");
        return;
      }
      const panelUser = currentPanelUser(request, discordGuild.id);
      const targetUserId = String(request.params.userId || "");
      const config = store.getGuild(discordGuild.id);
      const target = config.panelAccess?.users?.[targetUserId];
      if (!target) {
        response.redirect(`/guilds/${discordGuild.id}?section=access&saved=1`);
        return;
      }
      if (!panelAccessCanManage(panelUser?.level || "", target.level, target.level)) {
        panelAccessDenied(response);
        return;
      }
      await store.updateGuild(discordGuild.id, {
        panelAccess: {
          ...config.panelAccess,
          users: {
            ...config.panelAccess.users,
            [targetUserId]: {
              ...target,
              revokedAt: new Date().toISOString(),
              revokedBy: panelUser?.userId || "panel"
            }
          }
        }
      });
      await addAuditLog(store, discordGuild.id, {
        type: "panel-access",
        label: "Panel access revoked",
        details: `Revoked panel access for ${target.username || targetUserId}.`,
        actor: panelUserLabel(panelUser)
      }).catch(() => {});
      response.redirect(`/guilds/${discordGuild.id}?section=access&saved=1`);
    } catch (error) {
      next(error);
    }
  });

  app.post("/guilds/:guildId/panel-access/:userId/level", requireAuth, async (request, response, next) => {
    try {
      const discordGuild = client.guilds.cache.get(request.params.guildId);
      if (!discordGuild) {
        response.status(404).send("Server not found.");
        return;
      }
      const panelUser = currentPanelUser(request, discordGuild.id);
      const targetUserId = String(request.params.userId || "");
      const nextLevel = normalizePanelAccessLevel(request.body?.level);
      const config = store.getGuild(discordGuild.id);
      const target = config.panelAccess?.users?.[targetUserId];
      if (!target || !nextLevel) {
        response.redirect(`/guilds/${discordGuild.id}?section=access&saved=1`);
        return;
      }
      if (!panelAccessCanManage(panelUser?.level || "", target.level, nextLevel)) {
        panelAccessDenied(response, "You cannot set a panel user to that access level.");
        return;
      }
      await store.updateGuild(discordGuild.id, {
        panelAccess: {
          ...config.panelAccess,
          users: {
            ...config.panelAccess.users,
            [targetUserId]: {
              ...target,
              level: nextLevel,
              username: target.username || targetUserId,
              updatedAt: new Date().toISOString(),
              updatedBy: panelUser?.userId || "panel"
            }
          }
        }
      });
      const member = await discordGuild.members.fetch(targetUserId).catch(() => null);
      await member?.send?.([
        "**Chipkittle Panel Access Updated**",
        `Access level: **${panelAccessLabel(nextLevel)}**`,
        "Your password did not change."
      ].join("\n")).catch(() => {});
      await addAuditLog(store, discordGuild.id, {
        type: "panel-access",
        label: "Panel access level changed",
        details: `${panelUserLabel(panelUser)} changed ${target.username || targetUserId} to ${panelAccessLabel(nextLevel)}.`,
        actor: panelUserLabel(panelUser)
      }).catch(() => {});
      response.redirect(`/guilds/${discordGuild.id}?section=access&saved=1`);
    } catch (error) {
      next(error);
    }
  });

  app.get("/admin/export/audit", requireAuth, requirePanelLevel("round_table"), (_request, response) => {
    const payload = Object.fromEntries(
      Object.entries(store.data?.guilds || {}).map(([guildEntryId, config]) => [
        guildEntryId,
        {
          auditLog: config.community?.auditLog || [],
          exportedAt: new Date().toISOString()
        }
      ])
    );
    downloadJson(response, "chipkittle-audit-export.json", payload);
  });

  app.post("/guilds/:guildId/panel-access/:userId/expiration", requireAuth, async (request, response, next) => {
    try {
      const discordGuild = client.guilds.cache.get(request.params.guildId);
      if (!discordGuild) {
        response.status(404).send("Server not found.");
        return;
      }
      const panelUser = currentPanelUser(request, discordGuild.id);
      const targetUserId = String(request.params.userId || "");
      const config = store.getGuild(discordGuild.id);
      const target = config.panelAccess?.users?.[targetUserId];
      if (!target) {
        response.redirect(`/guilds/${discordGuild.id}?section=access&saved=1`);
        return;
      }
      if (!panelAccessCanManage(panelUser?.level || "", target.level, target.level)) {
        panelAccessDenied(response);
        return;
      }
      const raw = String(request.body?.expiresAt || "").trim();
      const rawTime = raw ? Date.parse(raw) : NaN;
      const expiresAt = raw && Number.isFinite(rawTime) ? new Date(rawTime).toISOString() : "";
      await store.updateGuild(discordGuild.id, {
        panelAccess: {
          ...config.panelAccess,
          users: {
            ...config.panelAccess.users,
            [targetUserId]: {
              ...target,
              expiresAt,
              updatedAt: new Date().toISOString(),
              updatedBy: panelUser?.userId || "panel"
            }
          }
        }
      });
      await addAuditLog(store, discordGuild.id, {
        type: "panel-access",
        label: "Panel access expiration changed",
        details: `${panelUserLabel(panelUser)} set ${target.username || targetUserId} expiration to ${expiresAt || "never"}.`,
        actor: panelUserLabel(panelUser)
      }).catch(() => {});
      response.redirect(`/guilds/${discordGuild.id}?section=access&saved=1`);
    } catch (error) {
      next(error);
    }
  });

  app.post("/guilds/:guildId/panel-access/:userId/reset-password", requireAuth, async (request, response, next) => {
    try {
      const discordGuild = client.guilds.cache.get(request.params.guildId);
      if (!discordGuild) {
        response.status(404).send("Server not found.");
        return;
      }
      const panelUser = currentPanelUser(request, discordGuild.id);
      const targetUserId = String(request.params.userId || "");
      const config = store.getGuild(discordGuild.id);
      const target = config.panelAccess?.users?.[targetUserId];
      if (!target) {
        response.redirect(`/guilds/${discordGuild.id}?section=access&saved=1`);
        return;
      }
      if (!panelAccessCanManage(panelUser?.level || "", target.level, target.level)) {
        panelAccessDenied(response, "You cannot reset that panel user's password.");
        return;
      }
      const member = await discordGuild.members.fetch(targetUserId).catch(() => null);
      if (!member) {
        response.redirect(`/guilds/${discordGuild.id}?section=access&modAction=missing-target`);
        return;
      }
      const password = randomPanelPassword();
      await member.send([
        "**Chipkittle Panel Recovery Password Reset**",
        "Panel sign-in is Discord OAuth only. This password is stored as a recovery/admin credential and does not replace Discord login.",
        `Discord account: \`${member.user.tag}\``,
        `Temporary recovery password: \`${password}\``,
        `Access level: **${panelAccessLabel(target.level)}**`,
        "This value is only shown once. Change it from My Account after signing in."
      ].join("\n"));
      await store.updateGuild(discordGuild.id, {
        panelAccess: {
          ...config.panelAccess,
          users: {
            ...config.panelAccess.users,
            [targetUserId]: {
              ...target,
              username: target.username || member.user.username,
              passwordHash: hashPanelPassword(password),
              passwordResetAt: new Date().toISOString(),
              passwordResetBy: panelUser?.userId || "panel"
            }
          }
        }
      });
      await addAuditLog(store, discordGuild.id, {
        type: "panel-access",
        label: "Panel password reset",
        details: `${panelUserLabel(panelUser)} reset the panel password for ${target.username || targetUserId}.`,
        actor: panelUserLabel(panelUser)
      }).catch(() => {});
      response.redirect(`/guilds/${discordGuild.id}?section=access&saved=1`);
    } catch (error) {
      next(error);
    }
  });

  app.post("/guilds/:guildId/panel-access/grant-levels", requireAuth, requirePanelLevel("root"), async (request, response, next) => {
    try {
      const discordGuild = client.guilds.cache.get(request.params.guildId);
      if (!discordGuild) {
        response.status(404).send("Server not found.");
        return;
      }
      const config = store.getGuild(discordGuild.id);
      const levels = arrayFromFormValue(request.body?.grantAccessLevels)
        .map(normalizePanelAccessLevel)
        .filter(Boolean);
      const grantAccessLevels = levels.length ? [...new Set(levels)] : ["root"];
      await store.updateGuild(discordGuild.id, {
        panelAccess: {
          ...config.panelAccess,
          grantAccessLevels
        }
      });
      await addAuditLog(store, discordGuild.id, {
        type: "panel-access",
        label: "Grant access levels changed",
        details: `Grant command access set to: ${grantAccessLevels.map(panelAccessLabel).join(", ")}.`,
        actor: panelUserLabel(currentPanelUser(request, discordGuild.id))
      }).catch(() => {});
      response.redirect(`/guilds/${discordGuild.id}?section=access&saved=1`);
    } catch (error) {
      next(error);
    }
  });

  app.post("/guilds/:guildId/panel-access/emergency-lockout", requireAuth, requirePanelLevel("root"), async (request, response, next) => {
    try {
      const discordGuild = client.guilds.cache.get(request.params.guildId);
      if (!discordGuild) {
        response.status(404).send("Server not found.");
        return;
      }
      const config = store.getGuild(discordGuild.id);
      const emergencyLockout = request.body?.emergencyLockout === "on";
      await store.updateGuild(discordGuild.id, {
        panelAccess: {
          ...config.panelAccess,
          emergencyLockout
        }
      });
      await addAuditLog(store, discordGuild.id, {
        type: "panel-access",
        label: "Emergency lockout changed",
        details: `Emergency lockout ${emergencyLockout ? "enabled" : "disabled"}.`,
        actor: panelUserLabel(currentPanelUser(request, discordGuild.id))
      }).catch(() => {});
      response.redirect(`/guilds/${discordGuild.id}?section=access&saved=1`);
    } catch (error) {
      next(error);
    }
  });

  app.post("/guilds/:guildId/panel-access/recovery-codes", requireAuth, requirePanelLevel("root"), async (request, response, next) => {
    try {
      const discordGuild = client.guilds.cache.get(request.params.guildId);
      if (!discordGuild) {
        response.status(404).send("Server not found.");
        return;
      }
      const config = store.getGuild(discordGuild.id);
      const codes = Array.from({ length: 8 }, () => randomRecoveryCode());
      await store.updateGuild(discordGuild.id, {
        panelAccess: {
          ...config.panelAccess,
          recoveryCodes: codes.map((code) => ({
            hash: hashPanelPassword(code),
            createdAt: new Date().toISOString(),
            createdBy: currentPanelUser(request, discordGuild.id)?.userId || "panel"
          }))
        }
      });
      await addAuditLog(store, discordGuild.id, {
        type: "panel-access",
        label: "Recovery codes generated",
        details: `${codes.length} backup root recovery codes were generated. Old unused codes were replaced.`,
        actor: panelUserLabel(currentPanelUser(request, discordGuild.id))
      }).catch(() => {});
      response.send(layout({
        title: "Recovery codes",
        user: true,
        body: `
          <section class="panel-section">
            <div class="section-heading">
              <h2>Backup Root Recovery Codes</h2>
              <p>These codes are shown once. Store them somewhere private.</p>
            </div>
            <pre>${escapeHtml(codes.join("\n"))}</pre>
            <a class="primary-link" href="/guilds/${discordGuild.id}?section=access">Return to access panel</a>
          </section>
        `
      }));
    } catch (error) {
      next(error);
    }
  });

  app.post("/guilds/:guildId/panel-access/templates", requireAuth, requirePanelLevel("root"), async (request, response, next) => {
    try {
      const discordGuild = client.guilds.cache.get(request.params.guildId);
      if (!discordGuild) {
        response.status(404).send("Server not found.");
        return;
      }
      const config = store.getGuild(discordGuild.id);
      const roleTemplates = Object.fromEntries(
        Object.entries(PANEL_ROLE_TEMPLATE_LEVELS).map(([templateId, fallbackLevel]) => [
          templateId,
          {
            level: normalizePanelAccessLevel(request.body?.[`template_${templateId}`]) || fallbackLevel,
            days: Math.min(Math.max(Math.floor(Number(request.body?.[`templateDays_${templateId}`]) || 0), 0), 365)
          }
        ])
      );
      await store.updateGuild(discordGuild.id, {
        panelAccess: {
          ...config.panelAccess,
          roleTemplates
        }
      });
      await addAuditLog(store, discordGuild.id, {
        type: "panel-access",
        label: "Panel role templates changed",
        details: "Root updated panel role templates.",
        actor: panelUserLabel(currentPanelUser(request, discordGuild.id))
      }).catch(() => {});
      response.redirect(`/guilds/${discordGuild.id}?section=access&saved=1`);
    } catch (error) {
      next(error);
    }
  });

  app.post("/admin/game-leaderboard/delete", requireAuth, requirePanelLevel("root"), (request, response) => {
    const index = Math.floor(Number(request.body?.index));
    const gameId = cleanGameId(request.query.game);
    const targetGuildId = String(request.query.guildId || "");
    const settings = publicGameSettings(targetGuildId ? store.getGuild(targetGuildId) : getPublicGuildConfig());
    if (Number.isInteger(index) && index >= 0) {
      deleteGameLeaderboardEntry(index, gameId, settings);
    }
    response.redirect(targetGuildId ? `/guilds/${encodeURIComponent(targetGuildId)}?section=games&saved=1` : "/?section=games");
  });

  app.post("/guilds/:guildId/suggestions/staff-dm", requireAuth, requirePanelLevel("root"), async (request, response, next) => {
    try {
      const discordGuild = client.guilds.cache.get(request.params.guildId);
      if (!discordGuild) {
        response.status(404).send("Server not found.");
        return;
      }
      const config = store.getGuild(discordGuild.id);
      const staffUserId = String(request.body?.suggestionStaffUserId || "").replace(/\D/g, "");
      await store.updateGuild(discordGuild.id, {
        publicSite: {
          ...config.publicSite,
          suggestions: {
            ...config.publicSite?.suggestions,
            staffUserId
          }
        }
      });
      await addAuditLog(store, discordGuild.id, {
        type: "suggestions",
        label: "Suggestion DM user saved",
        details: staffUserId ? `Suggestion DMs set to ${staffUserId}.` : "Suggestion staff DM forwarding disabled.",
        actor: panelUserLabel(currentPanelUser(request, discordGuild.id))
      }).catch(() => {});
      response.redirect(`/guilds/${discordGuild.id}?section=suggestions&saved=1`);
    } catch (error) {
      next(error);
    }
  });

  app.post("/guilds/:guildId/suggestions/:suggestionId/status", requireAuth, requirePanelLevel("artifact_contributor"), async (request, response, next) => {
    try {
      const discordGuild = client.guilds.cache.get(request.params.guildId);
      if (!discordGuild) {
        response.status(404).send("Server not found.");
        return;
      }
      const status = String(request.body?.status || "submitted");
      if (!SUGGESTION_STATUSES.includes(status)) {
        response.redirect(`/guilds/${discordGuild.id}?section=suggestions`);
        return;
      }
      const config = store.getGuild(discordGuild.id);
      const panelUser = currentPanelUser(request, discordGuild.id);
      const suggestions = storedSuggestions(config);
      const index = suggestions.findIndex((suggestion) => String(suggestion.id) === String(request.params.suggestionId));
      if (index === -1) {
        response.redirect(`/guilds/${discordGuild.id}?section=suggestions`);
        return;
      }
      const previousStatus = suggestions[index].status || "submitted";
      const updatedSuggestion = {
        ...suggestions[index],
        status,
        updatedAt: new Date().toISOString(),
        updatedBy: panelUserLabel(panelUser)
      };
      const nextSuggestions = [...suggestions];
      nextSuggestions[index] = updatedSuggestion;
      await store.updateGuild(discordGuild.id, {
        community: {
          ...config.community,
          suggestions: nextSuggestions
        }
      });
      await addAuditLog(store, discordGuild.id, {
        type: "suggestions",
        label: "Suggestion status updated",
        details: `Changed ${updatedSuggestion.id} from ${suggestionStatusLabel(previousStatus)} to ${suggestionStatusLabel(status)}.`,
        actor: panelUserLabel(panelUser)
      }).catch(() => {});
      await sendSuggestionAuthorStatusDm(client, updatedSuggestion, previousStatus);
      response.redirect(`/guilds/${discordGuild.id}?section=suggestions&saved=1`);
    } catch (error) {
      next(error);
    }
  });

  app.post("/guilds/:guildId/config", requireAuth, async (request, response, next) => {
    try {
      const discordGuild = client.guilds.cache.get(request.params.guildId);
      if (!discordGuild) {
        response.status(404).send("Server not found.");
        return;
      }

      const section = normalizeSettingsSection(String(request.query.section || ""));
      const panelUser = currentPanelUser(request, discordGuild.id);
      const saveRequiredLevel = section === "moderation" ? "keeper" : PANEL_SECTION_MIN_LEVEL[section] || "root";
      if (!panelAccessAtLeast(panelUser?.level || "root", saveRequiredLevel) || NON_FORM_SECTIONS.has(section)) {
        response.status(403).send(layout({ title: "Forbidden", user: true, body: '<p class="empty">You do not have permission to save this section.</p>' }));
        return;
      }
      const nextConfig = parseConfigForm(request.body, section);
      const existingConfig = store.getGuild(discordGuild.id);
      if (section === "ai" && nextConfig.ai) {
        nextConfig.ai = {
          ...nextConfig.ai,
          usage: existingConfig.ai?.usage || { month: "", requests: 0, estimatedTokens: 0 }
        };
      }
      if (section === "permissions" && !panelAccessAtLeast(panelUser?.level || "root", "root")) {
        nextConfig.commandRoles = {
          ...nextConfig.commandRoles,
          overrides: {
            ...(nextConfig.commandRoles?.overrides || {}),
            ...(store.getGuild(discordGuild.id).commandRoles?.overrides?.grantaccess
              ? { grantaccess: store.getGuild(discordGuild.id).commandRoles.overrides.grantaccess }
              : {})
          },
          disabled: {
            ...(nextConfig.commandRoles?.disabled || {}),
            ...(store.getGuild(discordGuild.id).commandRoles?.disabled?.grantaccess
              ? { grantaccess: store.getGuild(discordGuild.id).commandRoles.disabled.grantaccess }
              : {})
          },
          channelAllowlist: {
            ...(nextConfig.commandRoles?.channelAllowlist || {}),
            ...(store.getGuild(discordGuild.id).commandRoles?.channelAllowlist?.grantaccess
              ? { grantaccess: store.getGuild(discordGuild.id).commandRoles.channelAllowlist.grantaccess }
              : {})
          },
          disabledCategories: {
            ...(nextConfig.commandRoles?.disabledCategories || {}),
            ...(store.getGuild(discordGuild.id).commandRoles?.disabledCategories?.Config
              ? { Config: store.getGuild(discordGuild.id).commandRoles.disabledCategories.Config }
              : {})
          },
          channelCommandAllowlist: {
            ...(nextConfig.commandRoles?.channelCommandAllowlist || {})
          },
          channelCategoryAllowlist: {
            ...(nextConfig.commandRoles?.channelCategoryAllowlist || {})
          }
        };
      }
      const mergedConfig = await store.updateGuild(discordGuild.id, nextConfig);
      writePublicMembersFile(publicMembersFromConfig(mergedConfig));
      await addAuditLog(store, discordGuild.id, {
        type: "panel",
        label: "Panel settings saved",
        details: `Saved ${section} settings from the web panel.`,
        actor: "Panel"
      }).catch(() => {});
      response.redirect(`/guilds/${discordGuild.id}?saved=1&section=${section}`);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/status", requireAuth, (request, response) => {
    response.json({
      bot: client.user?.tag || null,
      ready: client.isReady(),
      guildCount: client.guilds.cache.size,
      uptimeSeconds: Math.round(process.uptime())
    });
  });

  app.use((error, request, response, _next) => {
    console.error(error);
    response.status(500).send(layout({ title: "Error", user: Boolean(request.session.authenticated), body: '<p class="empty">Something went wrong.</p>' }));
  });

  return app;
}
