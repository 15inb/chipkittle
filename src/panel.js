import crypto from "node:crypto";
import express from "express";
import session from "express-session";
import { serializeGuild } from "./bot.js";

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

function safeEquals(a, b) {
  const first = Buffer.from(a);
  const second = Buffer.from(b);
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}

function arrayFromFormValue(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
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
    ai: {
      enabled: body.aiEnabled === "on",
      channelIds: aiChannelIds.map(String),
      blacklistedChannelIds: aiBlacklistedChannelIds.map(String),
      model: String(body.aiModel || "").trim().slice(0, 80),
      apiCooldownSeconds: Math.min(Math.max(Number(body.aiApiCooldownSeconds) || 0, 0), 3600),
      replyToMentions: body.aiReplyToMentions === "on",
      personality: String(body.aiPersonality || "").trim().slice(0, 1200)
    },
    applications: {
      enabled: body.applicationsEnabled === "on",
      channelId: String(body.applicationChannelId || ""),
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
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <a class="brand" href="/">
        <span class="brand-mark">D</span>
        <span>
          <strong>Chipkittle Panel</strong>
          <small>Server configuration</small>
        </span>
      </a>
      <nav>
        <a href="/">Config</a>
        ${user ? '<a href="/logout">Sign out</a>' : '<a href="/login">Sign in</a>'}
      </nav>
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

  const permissions = "361045691472";
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
      <section class="guild-list">
        <p class="empty">The bot is not connected to a Discord server yet, or it is still starting up.</p>
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
                    <strong>${escapeHtml(prefix)}${escapeHtml(command.name)}</strong>
                    <small>${escapeHtml(command.description)}</small>
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
  return commandList
    .map(
      (command) => `
        <details class="permission-row">
          <summary>
            <span>${escapeHtml(command.name)}</span>
            <small>${escapeHtml(command.category || "Other")}</small>
          </summary>
          <div class="checkbox-grid compact">
            ${roleCheckboxes(roles, overrides[command.name] || [], `commandRole_${command.name}`)}
          </div>
        </details>`
    )
    .join("");
}

function guildPage({ guild, config, commandList, defaultAiModel, ai, flash }) {
  return layout({
    title: guild.name,
    user: true,
    flash,
    body: `
      <section class="page-heading guild-heading">
        <div class="guild-title">
          <span class="guild-icon large">${guild.iconUrl ? `<img src="${guild.iconUrl}" alt="">` : escapeHtml(guild.name[0] || "?")}</span>
          <div>
            <p class="eyebrow">Editing server</p>
            <h1>${escapeHtml(guild.name)}</h1>
            <p class="muted">${guild.memberCount ?? "Unknown"} members</p>
          </div>
        </div>
      </section>
      <form method="post" action="/guilds/${guild.id}/config" class="config-grid">
        <section class="panel-section">
          <div class="section-heading">
            <h2>Command Settings</h2>
            <p>Set the prefix used by text commands.</p>
          </div>
          <label>
            Prefix
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
            <p>Choose where automod events should be posted.</p>
          </div>
          <label>
            Log channel
            <select name="logChannelId">
              ${optionList(guild.channels, config.moderation.logChannelId, "No channel selected")}
            </select>
          </label>
        </section>

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
          <label>
            Model
            <input name="aiModel" value="${escapeHtml(config.ai.model || defaultAiModel)}">
          </label>
          <label>
            API cooldown seconds
            <input type="number" name="aiApiCooldownSeconds" min="0" max="3600" value="${escapeHtml(config.ai.apiCooldownSeconds)}">
          </label>
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

        <section class="panel-section">
          <div class="section-heading">
            <h2>Membership Applications</h2>
            <p>DM applicants the questions and create private staff review threads.</p>
          </div>
          <label class="toggle">
            <input type="checkbox" name="applicationsEnabled" ${isChecked(config.applications.enabled)}>
            <span>Enable application threads</span>
          </label>
          <label>
            Application command and thread channel
            <select name="applicationChannelId">
              ${optionList(guild.channels, config.applications.channelId, "Allow applications from any channel")}
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

        <div class="form-actions">
          <button type="submit">Save configuration</button>
        </div>
      </form>
      <section class="panel-section command-catalog">
        <div class="section-heading">
          <h2>Command Catalog</h2>
          <p>${commandList.length} commands are available with this server's prefix.</p>
        </div>
        ${commandCatalog(commandList, config.prefix)}
      </section>
    `
  });
}

export function createPanel({ client, store, panelPassword, sessionSecret, clientId, guildId, ai, defaultAiModel, commandList }) {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(express.static("public", { index: false }));
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

  app.get("/", requireAuth, (request, response) => {
    const guilds = client.guilds.cache.map(serializeGuild).sort((a, b) => a.name.localeCompare(b.name));
    if (guildId) {
      const pinnedGuild = client.guilds.cache.get(guildId);
      if (pinnedGuild) {
        response.redirect(`/guilds/${pinnedGuild.id}${request.query.saved ? "?saved=1" : ""}`);
        return;
      }
    }

    if (guilds.length === 1) {
      response.redirect(`/guilds/${guilds[0].id}${request.query.saved ? "?saved=1" : ""}`);
      return;
    }

    response.send(dashboardPage({ guilds, client, clientId, ai, commandList, flash: request.query.saved ? "Configuration saved." : "" }));
  });

  app.get("/guilds/:guildId", requireAuth, (request, response) => {
    const discordGuild = client.guilds.cache.get(request.params.guildId);
    if (!discordGuild) {
      response.status(404).send(layout({ title: "Not found", user: true, body: '<p class="empty">Server not found.</p>' }));
      return;
    }

    const guild = serializeGuild(discordGuild);
    const config = store.getGuild(guild.id);
    response.send(guildPage({ guild, config, commandList, defaultAiModel, ai, flash: request.query.saved ? "Configuration saved." : "" }));
  });

  app.post("/guilds/:guildId/config", requireAuth, async (request, response, next) => {
    try {
      const discordGuild = client.guilds.cache.get(request.params.guildId);
      if (!discordGuild) {
        response.status(404).send("Server not found.");
        return;
      }

      await store.updateGuild(discordGuild.id, parseConfigForm(request.body));
      response.redirect(`/guilds/${discordGuild.id}?saved=1`);
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
