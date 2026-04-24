import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import express from "express";
import session from "express-session";
import { serializeGuild } from "./bot.js";
import {
  addAuditLog,
  artifactDirectoryText,
  communitySnapshot,
  parseArtifactDirectory,
  publicMemberCards,
  topCommands
} from "./communityFeatures.js";
import { CHIPKITTLE_LORE } from "./chipkittleLore.js";
import { createDashClaim } from "./dashClaims.js";
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
const SETTINGS_SECTIONS = [
  { id: "dashboard", label: "Dashboard", description: "At-a-glance stats, audit activity, and quick links." },
  { id: "general", label: "General", description: "Slash commands, legacy prefix, welcome, and autorole." },
  { id: "members", label: "Members", description: "Edit the public member directory and review community profiles." },
  { id: "moderation", label: "Moderation", description: "Automod rules and moderation logging." },
  { id: "ai", label: "AI", description: "Chipkittle AI channels, model, cooldowns, and personality." },
  { id: "applications", label: "Applications", description: "DM questions, review threads, roles, and cooldowns." },
  { id: "games", label: "Games", description: "Leaderboard moderation, claim limits, and public game tools." },
  { id: "community", label: "Community", description: "Artifacts, rituals, public directory extras, and archive data." },
  { id: "permissions", label: "Permissions", description: "Command role access overrides." },
  { id: "commands", label: "Commands", description: "Browse the command catalog." },
  { id: "server", label: "Server", description: "Pull GitHub changes and restart the VPS bot." }
];

const DEFAULT_PUBLIC_GAME_SETTINGS = {
  blockedLeaderboardWords: [],
  maxLeaderboardEntriesPerGame: 10,
  maxLeaderboardScore: 100000,
  maxLeaderboardBread: 100000,
  maxClaimBreadPerRun: 100000
};

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

function updateControls() {
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

function moderationCenter(config = {}) {
  const warnings = Object.entries(config.moderation?.warnings || {});
  const warningTotals = warnings.reduce((sum, [, entries]) => sum + (Array.isArray(entries) ? entries.length : 0), 0);
  const warnedMembers = warnings.filter(([, entries]) => Array.isArray(entries) && entries.length).length;
  const cases = Array.isArray(config.community?.cases) ? config.community.cases : [];
  const openCases = cases.filter((entry) => String(entry.status || "open").toLowerCase() !== "closed");
  const closedCases = Math.max(cases.length - openCases.length, 0);
  const warningHotlist = warnings
    .map(([userId, entries]) => ({
      userId,
      count: Array.isArray(entries) ? entries.length : 0,
      latest: Array.isArray(entries) && entries.length ? entries[entries.length - 1] : ""
    }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  return `
    <section class="panel-section">
      <div class="section-heading">
        <h2>Moderation Center</h2>
        <p>Quick visibility into warnings, open cases, and who is generating the most staff action.</p>
      </div>
      <div class="stats-grid">
        <article class="stat-card"><strong>${escapeHtml(cases.length)}</strong><span>Total Cases</span></article>
        <article class="stat-card"><strong>${escapeHtml(openCases.length)}</strong><span>Open Cases</span></article>
        <article class="stat-card"><strong>${escapeHtml(closedCases)}</strong><span>Closed Cases</span></article>
        <article class="stat-card"><strong>${escapeHtml(warningTotals)}</strong><span>Total Warnings</span></article>
        <article class="stat-card"><strong>${escapeHtml(warnedMembers)}</strong><span>Warned Members</span></article>
      </div>
      <div class="dashboard-grid">
        <div class="sub-panel">
          <div class="section-heading">
            <h2>Open Cases</h2>
            <p>Newest active cases that still need attention.</p>
          </div>
          ${
            openCases.length
              ? `<div class="stack-list">${openCases.slice(0, 8).map((entry) => `<div class="audit-row"><strong>Case #${escapeHtml(entry.id)} • ${escapeHtml(entry.action)}</strong><small>${escapeHtml(entry.targetTag || entry.targetId || "Unknown target")} • ${escapeHtml(entry.createdAt || "")}</small><p>${escapeHtml(entry.reason || "No reason recorded.")}</p>${entry.updates?.length ? `<small>${escapeHtml(entry.updates.length)} note${entry.updates.length === 1 ? "" : "s"}</small>` : ""}</div>`).join("")}</div>`
              : '<p class="muted">No open moderation cases right now.</p>'
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

function dashboardCards(guild, config = {}) {
  const snapshot = communitySnapshot(config);
  const top = topCommands(config, 5);
  const auditLog = (config.community?.auditLog || []).slice(0, 8);
  const recentCases = (config.community?.cases || []).slice(0, 6);
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
        <article class="stat-card"><strong>${escapeHtml(snapshot.cases)}</strong><span>Case Files</span></article>
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
          <h2>Recent Cases</h2>
          <p>Newest moderation cases recorded by the bot.</p>
        </div>
        ${recentCases.length
          ? `<div class="stack-list">${recentCases.map((entry) => `<div class="audit-row"><strong>Case #${escapeHtml(entry.id)} • ${escapeHtml(entry.action)}</strong><small>${escapeHtml(entry.targetTag || entry.targetId)} • ${escapeHtml(entry.status)}</small><p>${escapeHtml(entry.reason || "No reason recorded.")}</p></div>`).join("")}</div>`
          : '<p class="muted">No moderation cases yet.</p>'}
      </section>
      <section class="panel-section">
        <div class="section-heading">
          <h2>Activity Feed</h2>
          <p>Recent application, moderation, shop, and profile events.</p>
        </div>
        ${auditLog.length
          ? `<div class="stack-list">${auditLog.map((entry) => `<div class="audit-row"><strong>${escapeHtml(entry.label)}</strong><small>${escapeHtml(entry.actor || "System")} • ${escapeHtml(entry.createdAt || "")}</small><p>${escapeHtml(entry.details || "")}</p></div>`).join("")}</div>`
          : '<p class="muted">No audit activity yet.</p>'}
      </section>
    </div>
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

function publicMembersFromConfig(config = {}) {
  return publicMemberCards(config);
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

function cleanGameId(value = "") {
  const gameId = String(value || "dash").toLowerCase().replace(/[^a-z0-9-]/g, "");
  return ["dash", "runner", "mines", "catch"].includes(gameId) ? gameId : "dash";
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
    maxClaimBreadPerRun: Math.min(Math.max(Number(games.maxClaimBreadPerRun) || DEFAULT_PUBLIC_GAME_SETTINGS.maxClaimBreadPerRun, 0), 1000000)
  };
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
    catch: "Bread Catch"
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
  const gameIds = ["dash", "runner", "mines", "catch"];
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

function parseConfigForm(body) {
  const aiChannelIds = arrayFromFormValue(body.aiChannelIds);
  const aiBlacklistedChannelIds = arrayFromFormValue(body.aiBlacklistedChannelIds);
  const reviewerRoleIds = arrayFromFormValue(body.applicationReviewerRoleIds);
  const blockedRoleIds = arrayFromFormValue(body.applicationBlockedRoleIds);
  const commandOverrides = Object.fromEntries(
    Object.entries(body)
      .filter(([key]) => key.startsWith("commandRole_"))
      .map(([key, value]) => [key.replace("commandRole_", ""), arrayFromFormValue(value).map(String)])
      .filter(([, roleIds]) => roleIds.length)
  );

  return {
    prefix: String(body.prefix || "!").trim().slice(0, 5) || "!",
    welcome: {
      enabled: body.welcomeEnabled === "on",
      channelId: String(body.welcomeChannelId || ""),
      message: String(body.welcomeMessage || "").trim().slice(0, 500)
    },
    autoRoleId: String(body.autoRoleId || ""),
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
    },
    commandRoles: {
      overrides: commandOverrides
    },
    publicSite: {
      members: parseMemberDirectory(body.publicMembers),
      games: {
        blockedLeaderboardWords: normalizeBlockedWordList(body.blockedLeaderboardWords),
        maxLeaderboardEntriesPerGame: Math.min(Math.max(Number(body.maxLeaderboardEntriesPerGame) || DEFAULT_PUBLIC_GAME_SETTINGS.maxLeaderboardEntriesPerGame, 1), 50),
        maxLeaderboardScore: Math.min(Math.max(Number(body.maxLeaderboardScore) || DEFAULT_PUBLIC_GAME_SETTINGS.maxLeaderboardScore, 1), 1000000),
        maxLeaderboardBread: Math.min(Math.max(Number(body.maxLeaderboardBread) || DEFAULT_PUBLIC_GAME_SETTINGS.maxLeaderboardBread, 0), 1000000),
        maxClaimBreadPerRun: Math.min(Math.max(Number(body.maxClaimBreadPerRun) || DEFAULT_PUBLIC_GAME_SETTINGS.maxClaimBreadPerRun, 0), 1000000)
      }
    },
    community: {
      artifacts: parseArtifactDirectory(body.communityArtifacts),
      rituals: {
        currentEvent: String(body.currentEvent || "").trim().slice(0, 220),
        seasonalMessage: String(body.seasonalMessage || "").trim().slice(0, 220),
        nextTrial: String(body.nextTrial || "").trim().slice(0, 120)
      }
    },
    ai: {
      enabled: body.aiEnabled === "on",
      channelIds: aiChannelIds.map(String),
      blacklistedChannelIds: aiBlacklistedChannelIds.map(String),
      mode: String(body.aiMode || "").toLowerCase() === "evil" ? "evil" : "normal",
      model: String(body.aiModel || "").trim().slice(0, 80),
      apiCooldownSeconds: Math.min(Math.max(Number(body.aiApiCooldownSeconds) || 0, 0), 3600),
      imageCooldownSeconds: Math.min(Math.max(Number(body.aiImageCooldownSeconds) || 0, 0), 7200),
      replyToMentions: body.aiReplyToMentions === "on",
      personality: String(body.aiPersonality || "").trim().slice(0, 1200)
    },
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
}

function layout({ title, body, user, flash = "" }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" type="image/png" href="/notativelogotransparent.png">
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <a class="brand" href="https://chipkittle.com" target="_blank" rel="noreferrer">
        <span class="brand-mark"><img src="/chipkittle-logo.svg" alt="Chipkittle logo"></span>
        <span>
          <strong>Chipkittle Panel</strong>
          <small>Server configuration</small>
        </span>
      </a>
      <nav>
        <a href="/">Config</a>
        <a href="https://chipkittle.com" target="_blank" rel="noreferrer">Website</a>
        ${user ? '<a href="/commits">Commits</a>' : ""}
        ${user ? '<a href="/logout">Sign out</a>' : '<a href="/login">Sign in</a>'}
      </nav>
      <a class="sidebar-button" href="https://chipkittle.com/" aria-label="Open the Chipkittle homepage">Homepage</a>
      <div class="sidebar-note">
        <span class="status-dot"></span>
        Web panel active
      </div>
    </aside>
    <main class="content">
      ${flash ? `<div class="flash">${escapeHtml(flash)}</div>` : ""}
      ${body}
    </main>
  </div>
</body>
</html>`;
}

function loginPage(error = "") {
  return layout({
    title: "Sign in",
    body: `
      <section class="login-panel">
        <div>
          <p class="eyebrow">Admin access</p>
          <h1>Sign in to configure your bot.</h1>
          <p class="muted">Use the password from <code>PANEL_PASSWORD</code> in your environment file.</p>
        </div>
        <form method="post" action="/login" class="stack">
          ${error ? `<p class="form-error">${escapeHtml(error)}</p>` : ""}
          <label>
            Password
            <input type="password" name="password" autocomplete="current-password" required autofocus>
          </label>
          <button type="submit">Sign in</button>
        </form>
      </section>
    `
  });
}

function inviteUrl(clientId) {
  if (!clientId) return "";

  const permissions = "361048837200";
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&permissions=${permissions}&scope=bot%20applications.commands`;
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

function commandRoleAccess(commandList, roles, overrides = {}) {
  const byCategory = new Map();
  for (const command of commandList) {
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
                    <div class="checkbox-grid compact">
                      ${roleCheckboxes(roles, overrides[command.name] || [], `commandRole_${command.name}`)}
                    </div>
                  </details>`
              )
              .join("")}
          </div>
        </details>`
    )
    .join("");
}

function settingsNav(guildId, activeSection) {
  return `
    <nav class="settings-nav" aria-label="Settings categories">
      ${SETTINGS_SECTIONS.map(
        (section) => `
          <a class="${section.id === activeSection ? "active" : ""}" href="/guilds/${guildId}?section=${section.id}">
            <span>${escapeHtml(section.label)}</span>
            <small>${escapeHtml(section.description)}</small>
          </a>`
      ).join("")}
    </nav>
  `;
}

function guildPage({ guild, config, commandList, defaultAiModel, ai, flash, activeSection = "general" }) {
  const currentSection = normalizeSettingsSection(activeSection);
  const currentMeta = activeSectionMeta(currentSection);
  const gameSettings = publicGameSettings(config);
  const memberDirectoryScript = `
    <script>
      (() => {
        const editor = document.querySelector("[data-member-directory-editor]");
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
      <section class="page-heading guild-heading settings-head">
        <div class="guild-title">
          <span class="guild-icon large">${guild.iconUrl ? `<img src="${guild.iconUrl}" alt="">` : escapeHtml(guild.name[0] || "?")}</span>
          <div>
            <p class="eyebrow">Editing server</p>
            <h1>${escapeHtml(guild.name)}</h1>
            <p class="muted">${guild.memberCount ?? "Unknown"} members</p>
          </div>
        </div>
        <div class="section-context">
          <span>${escapeHtml(currentMeta.label)}</span>
          <p>${escapeHtml(currentMeta.description)}</p>
        </div>
      </section>
      <div class="settings-workspace">
        ${settingsNav(guild.id, currentSection)}
        <div class="settings-main">
          <form method="post" action="/guilds/${guild.id}/config?section=${currentSection}" class="config-grid">
            <section class="${sectionClass("dashboard", currentSection)}">
              ${dashboardCards(guild, config)}
            </section>

            <section class="${sectionClass("general", currentSection)}">
              <div class="settings-stack">
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
              </div>
            </section>

            <section class="${sectionClass("members", currentSection)}">
              <div class="settings-stack">
                ${memberDirectoryEditor(config.publicSite.members)}
                ${profileDirectoryCards(config)}
              </div>
            </section>

            <section class="${sectionClass("moderation", currentSection)}">
              <div class="settings-stack">
                ${moderationCenter(config)}
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
              </div>
            </section>

            <section class="${sectionClass("ai", currentSection)}">
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
                </div>
                <label>
                  Extra personality
                  <textarea name="aiPersonality" rows="5">${escapeHtml(config.ai.personality)}</textarea>
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
            </section>

            <section class="${sectionClass("applications", currentSection)}">
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
            </section>

            <section class="${sectionClass("games", currentSection)}">
              <div class="settings-stack">
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
                  </div>
                </section>
              </div>
            </section>

            <section class="${sectionClass("community", currentSection)}">
              <div class="settings-stack">
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
              </div>
            </section>

            <section class="${sectionClass("permissions", currentSection)}">
              <section class="panel-section">
                <div class="section-heading">
                  <h2>Command Role Access</h2>
                  <p>Grant specific roles access to specific commands without requiring the matching Discord permission.</p>
                </div>
                <p class="field-help">Open a command, then choose which roles can bypass that command's Discord permission check.</p>
                <div class="permission-list">
                  ${commandRoleAccess(commandList, guild.roles, config.commandRoles.overrides)}
                </div>
              </section>
            </section>

            <div class="form-actions ${["commands", "server", "dashboard"].includes(currentSection) ? "is-hidden" : ""}">
              <button type="submit">Save ${escapeHtml(currentMeta.label)}</button>
            </div>
          </form>

          <section class="${sectionClass("games", currentSection)}">
            ${gameLeaderboardControls(guild.id, gameSettings)}
          </section>

          <section class="${sectionClass("commands", currentSection)}">
            <section class="panel-section command-catalog">
              <div class="section-heading">
                <h2>Command Catalog</h2>
                <p>${commandList.length} slash commands are available. Legacy text commands still use this server's prefix.</p>
              </div>
              ${commandCatalog(commandList, config.prefix)}
            </section>
          </section>

          <section class="${sectionClass("server", currentSection)}">
            ${updateControls()}
          </section>
        </div>
      </div>${memberDirectoryScript}
    `
  });
}

export function createPanel({ client, store, panelPassword, sessionSecret, clientId, guildId, ai, defaultAiModel, commandList }) {
  const app = express();
  const panelStatic = express.static("public", { index: false });

  app.disable("x-powered-by");
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
      name: "bot_panel.sid",
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        maxAge: 1000 * 60 * 60 * 12
      }
    })
  );

  function requireAuth(request, response, next) {
    if (request.session.authenticated) {
      next();
      return;
    }

    response.redirect("/login");
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

  app.options("/api/public/game-leaderboard", (_request, response) => {
    setPublicApiHeaders(response);
    response.sendStatus(204);
  });

  app.options("/api/public/dash-claim", (_request, response) => {
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

  app.get("/login", (request, response) => {
    if (request.session.authenticated) {
      response.redirect("/");
      return;
    }

    response.send(loginPage());
  });

  app.post("/login", (request, response) => {
    if (safeEquals(String(request.body.password || ""), panelPassword)) {
      request.session.authenticated = true;
      response.redirect("/");
      return;
    }

    response.status(401).send(loginPage("That password did not match."));
  });

  app.get("/logout", (request, response) => {
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

  app.get("/guilds/:guildId", requireAuth, (request, response) => {
    const discordGuild = client.guilds.cache.get(request.params.guildId);
    if (!discordGuild) {
      response.status(404).send(layout({ title: "Not found", user: true, body: '<p class="empty">Server not found.</p>' }));
      return;
    }

    const guild = serializeGuild(discordGuild);
    const config = store.getGuild(guild.id);
    response.send(guildPage({
      guild,
      config,
      commandList,
      defaultAiModel,
      ai,
      flash: flashFromQuery(request.query),
      activeSection: normalizeSettingsSection(String(request.query.section || ""))
    }));
  });

  app.post("/admin/update", requireAuth, (request, response) => {
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

  app.post("/admin/restart", requireAuth, (request, response) => {
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

  app.get("/admin/export/config", requireAuth, (_request, response) => {
    downloadJson(response, "chipkittle-config.json", store.data || { guilds: {} });
  });

  app.get("/admin/export/community", requireAuth, (_request, response) => {
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

  app.get("/admin/export/full", requireAuth, (_request, response) => {
    downloadJson(response, "chipkittle-backup-snapshot.json", {
      generatedAt: new Date().toISOString(),
      guilds: store.data?.guilds || {}
    });
  });

  app.post("/admin/game-leaderboard/delete", requireAuth, (request, response) => {
    const index = Math.floor(Number(request.body?.index));
    const gameId = cleanGameId(request.query.game);
    const targetGuildId = String(request.query.guildId || "");
    const settings = publicGameSettings(targetGuildId ? store.getGuild(targetGuildId) : getPublicGuildConfig());
    if (Number.isInteger(index) && index >= 0) {
      deleteGameLeaderboardEntry(index, gameId, settings);
    }
    response.redirect(targetGuildId ? `/guilds/${encodeURIComponent(targetGuildId)}?section=games&saved=1` : "/?section=games");
  });

  app.post("/guilds/:guildId/config", requireAuth, async (request, response, next) => {
    try {
      const discordGuild = client.guilds.cache.get(request.params.guildId);
      if (!discordGuild) {
        response.status(404).send("Server not found.");
        return;
      }

      const nextConfig = parseConfigForm(request.body);
      await store.updateGuild(discordGuild.id, nextConfig);
      writePublicMembersFile(nextConfig.publicSite.members);
      await addAuditLog(store, discordGuild.id, {
        type: "panel",
        label: "Panel settings saved",
        details: `Saved ${normalizeSettingsSection(String(request.query.section || ""))} settings from the web panel.`,
        actor: "Panel"
      }).catch(() => {});
      const section = normalizeSettingsSection(String(request.query.section || ""));
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
