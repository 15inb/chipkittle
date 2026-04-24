import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import express from "express";
import session from "express-session";
import { serializeGuild } from "./bot.js";
<<<<<<< HEAD
import { createDashClaim } from "./dashClaims.js";
=======
import {
  createEightBallRoom,
  getEightBallRoomState,
  joinEightBallRoom,
  resetEightBallRoom,
  shootEightBall
} from "./eightBallRooms.js";
>>>>>>> 9963cb1334ef8ae6aae1f8cf9b0c089029bcee9a

const execFileAsync = promisify(execFile);
const UPDATE_STALE_MS = 10 * 60 * 1000;
const ACTIVE_UPDATE_STATUSES = new Set(["running", "updating", "restarting"]);
const SETTINGS_SECTIONS = [
  { id: "general", label: "General", description: "Slash commands, legacy prefix, welcome, autorole, and public directory." },
  { id: "moderation", label: "Moderation", description: "Automod rules and moderation logging." },
  { id: "ai", label: "AI", description: "Chipkittle AI channels, model, cooldowns, and personality." },
  { id: "applications", label: "Applications", description: "DM questions, review threads, roles, and cooldowns." },
  { id: "permissions", label: "Permissions", description: "Command role access overrides." },
  { id: "commands", label: "Commands", description: "Browse the command catalog." },
  { id: "server", label: "Server", description: "Pull GitHub changes and restart the VPS bot." }
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
      const [name = "", role = "", bio = ""] = line.split("|").map((part) => part.trim());
      return {
        name: name.slice(0, 80),
        role: role.slice(0, 80),
        bio: bio.slice(0, 220)
      };
    })
    .filter((member) => member.name)
    .slice(0, 40);
}

function memberDirectoryText(members = []) {
  return members
    .map((member) => [member.name, member.role, member.bio].filter((part) => part !== undefined).join(" | "))
    .join("\n");
}

function publicMembersFromConfig(config = {}) {
  return (config.publicSite?.members || [])
    .map((member) => ({
      name: String(member.name || "").slice(0, 80),
      role: String(member.role || "").slice(0, 80),
      bio: String(member.bio || "").slice(0, 220)
    }))
    .filter((member) => member.name)
    .slice(0, 40);
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

function cleanLeaderboardName(value = "") {
  return String(value || "")
    .replace(/[^\w .#-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24) || "Anonymous Chipkittle";
}

function readGameLeaderboard() {
  try {
    const parsed = JSON.parse(fs.readFileSync(leaderboardPath(), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function publicLeaderboardEntries(entries = []) {
  return entries
    .map((entry) => ({
      name: cleanLeaderboardName(entry.name),
      score: Math.max(Math.floor(Number(entry.score) || 0), 0),
      bread: Math.max(Math.floor(Number(entry.bread) || 0), 0),
      createdAt: String(entry.createdAt || "")
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.bread - a.bread)
    .slice(0, 10);
}

function writeGameLeaderboard(entries = []) {
  const filePath = leaderboardPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(`${filePath}.tmp`, `${JSON.stringify(publicLeaderboardEntries(entries), null, 2)}\n`, "utf8");
  fs.renameSync(`${filePath}.tmp`, filePath);
}

function deleteGameLeaderboardEntry(index) {
  const entries = publicLeaderboardEntries(readGameLeaderboard());
  entries.splice(index, 1);
  writeGameLeaderboard(entries);
  return entries;
}

function gameLeaderboardControls(guildId = "") {
  const entries = publicLeaderboardEntries(readGameLeaderboard());
  return `
    <section class="panel-section leaderboard-admin">
      <div class="section-heading">
        <h2>Dash Leaderboard</h2>
        <p>Remove saved Chipkittle Dash scores from the public leaderboard.</p>
      </div>
      ${
        entries.length
          ? `<div class="leaderboard-admin-list">
              ${entries
                .map(
                  (entry, index) => `
                    <div class="leaderboard-admin-row">
                      <div>
                        <strong>${escapeHtml(entry.name)}</strong>
                        <small>Score ${escapeHtml(entry.score)} / Bread ${escapeHtml(entry.bread)}</small>
                      </div>
                      <form method="post" action="/admin/game-leaderboard/delete?guildId=${encodeURIComponent(guildId)}" class="inline-form">
                        <input type="hidden" name="index" value="${index}">
                        <button type="submit" class="danger-button">Remove</button>
                      </form>
                    </div>`
                )
                .join("")}
            </div>`
          : '<p class="muted">No Dash scores are saved yet.</p>'
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
      members: parseMemberDirectory(body.publicMembers)
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

                <section class="panel-section">
                  <div class="section-heading">
                    <h2>Public Member Directory</h2>
                    <p>Edit the member list used by the public website. Use one member per line.</p>
                  </div>
                  <label>
                    Members
                    <textarea name="publicMembers" rows="8" placeholder="Name | Role | Bio">${escapeHtml(memberDirectoryText(config.publicSite.members))}</textarea>
                  </label>
                  <p class="field-help">Format: <code>Name | Role | Bio</code></p>
                </section>
              </div>
            </section>

            <section class="${sectionClass("moderation", currentSection)}">
              <div class="settings-stack">
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

            <div class="form-actions ${["commands", "server"].includes(currentSection) ? "is-hidden" : ""}">
              <button type="submit">Save ${escapeHtml(currentMeta.label)}</button>
            </div>
          </form>

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
            ${gameLeaderboardControls(guild.id)}
          </section>
        </div>
      </div>
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

  app.options("/api/public/game-leaderboard", (_request, response) => {
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

  app.get("/api/public/game-leaderboard", (_request, response) => {
    setPublicApiHeaders(response);
    response.json({
      scores: publicLeaderboardEntries(readGameLeaderboard()),
      updatedAt: new Date().toISOString()
    });
  });

  app.post("/api/public/game-leaderboard", (request, response) => {
    setPublicApiHeaders(response);
    const entry = {
      name: cleanLeaderboardName(request.body?.name),
      score: Math.min(Math.max(Math.floor(Number(request.body?.score) || 0), 0), 100000),
      bread: Math.min(Math.max(Math.floor(Number(request.body?.bread) || 0), 0), 100000),
      createdAt: new Date().toISOString()
    };

    if (entry.score <= 0) {
      response.status(400).json({ error: "Score must be greater than zero." });
      return;
    }

    const scores = publicLeaderboardEntries([...readGameLeaderboard(), entry]);
    writeGameLeaderboard(scores);
    const claim = createDashClaim(entry);
    response.json({
      scores,
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
      const state = getEightBallRoomState(request.params.roomCode, String(request.query.token || ""));
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
        power: Number(request.body?.power)
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

  app.post("/admin/game-leaderboard/delete", requireAuth, (request, response) => {
    const index = Math.floor(Number(request.body?.index));
    if (Number.isInteger(index) && index >= 0) {
      deleteGameLeaderboardEntry(index);
    }
    const targetGuildId = String(request.query.guildId || "");
    response.redirect(targetGuildId ? `/guilds/${encodeURIComponent(targetGuildId)}?section=server&saved=1` : "/?section=server");
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
