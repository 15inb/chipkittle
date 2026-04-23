import { AttachmentBuilder, ChannelType, EmbedBuilder, PermissionsBitField } from "discord.js";
import { checkAiRateLimit } from "./aiRateLimit.js";
import {
  applicantIdFromChannel,
  applicationQuestions,
  clearApplicationTicket,
  findOpenApplicationChannel,
  isApplicationStaff as canUseApplicationCommand,
  saveApplicationTicket,
  ticketNameFor
} from "./applicationTickets.js";
import {
  CHIPKITTLE_LORE,
  randomChipkittleName,
  randomChipkittleQuote
} from "./chipkittleLore.js";
import { NO_MENTIONS } from "./discordSafety.js";
import {
  buildPrettyEmbed,
  commandEmbedMeta,
  createEmbedMessageProxy,
  sendEmbedPayload,
  toEmbedPayload
} from "./embedOutput.js";

const eightBallAnswers = [
  "The artifact says yes.",
  "The horns point to no.",
  "Ask again after the Wednesday ceremony.",
  "The Round Table is divided.",
  "Almost certainly.",
  "Do not bet the tombstone on it.",
  "The suit approves.",
  "Signs point to a deeply weird maybe."
];
const IMAGE_CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);
const MAX_CHIPIFY_IMAGE_BYTES = 20 * 1024 * 1024;
const PLAIN_OUTPUT_COMMANDS = new Set(["ask", "chipify"]);

const pendingDateRequests = new Map();
const currentDates = new Map();

function pendingDateKey(guildId, targetId) {
  return `${guildId}:${targetId}`;
}

function isUserDating(userId) {
  return currentDates.has(userId);
}

function currentDatePartner(userId) {
  return currentDates.get(userId) || null;
}

function clearDatePair(userId) {
  const partnerId = currentDates.get(userId);
  if (!partnerId) return;
  currentDates.delete(userId);
  currentDates.delete(partnerId);
}

function requesterHasPendingRequest(guildId, requesterId) {
  for (const request of pendingDateRequests.values()) {
    if (request.guildId === guildId && request.requesterId === requesterId) {
      return true;
    }
  }
  return false;
}

const commandDefinitions = [];

export const commandList = commandDefinitions;

function define(command) {
  commandDefinitions.push(command);
}

function usage(config, command) {
  return `${config.prefix}${command.usage || command.name}`;
}

function mentionUser(message) {
  return message.mentions.members.first() || message.member;
}

function mentionRole(message) {
  return message.mentions.roles.first();
}

function hasPermission(member, permission) {
  return member?.permissions.has(permission);
}

function hasAnyRole(member, roleIds = []) {
  const allowedRoleIds = new Set(roleIds);
  const memberRoleIds = member?.roles.cache.map((role) => role.id) || [];
  return memberRoleIds.some((roleId) => allowedRoleIds.has(roleId));
}

function hasCommandRoleOverride(member, config, commandName) {
  const roleIds = config.commandRoles?.overrides?.[commandName] || [];
  return hasAnyRole(member, roleIds);
}

function requirePermission(ctx, permission) {
  if (
    hasPermission(ctx.message.member, permission) ||
    hasCommandRoleOverride(ctx.message.member, ctx.config, ctx.command.name)
  ) {
    return true;
  }

  ctx.message.reply("You do not have permission to use that command.");
  return false;
}

function isAiChannelBlacklisted(config, channelId) {
  return (config.ai.blacklistedChannelIds || []).includes(channelId);
}

function isApplicationStaff(ctx) {
  return canUseApplicationCommand(ctx.message.member, ctx.config, ctx.command.name, hasCommandRoleOverride);
}

function applicationCooldownStatus(config, userId) {
  const minutes = Number(config.applications.cooldownMinutes) || 0;
  if (minutes <= 0) return { limited: false, remainingMs: 0 };

  const lastAppliedAt = config.applications.cooldowns?.[userId]?.lastAppliedAt;
  if (!lastAppliedAt) return { limited: false, remainingMs: 0 };

  const remainingMs = minutes * 60_000 - (Date.now() - new Date(lastAppliedAt).getTime());
  return { limited: remainingMs > 0, remainingMs: Math.max(remainingMs, 0) };
}

function formatCooldown(ms) {
  const totalMinutes = Math.ceil(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours && minutes) return `${hours}h ${minutes}m`;
  if (hours) return `${hours}h`;
  return `${Math.max(minutes, 1)}m`;
}

function isBlockedFromApplying(member, config) {
  const blockedRoleIds = config.applications.blockedRoleIds || [];
  return hasAnyRole(member, blockedRoleIds);
}

async function saveApplicationCooldown(store, guildId, userId) {
  const config = store.getGuild(guildId);
  return store.updateGuild(guildId, {
    applications: {
      ...config.applications,
      cooldowns: {
        ...(config.applications.cooldowns || {}),
        [userId]: {
          lastAppliedAt: new Date().toISOString()
        }
      }
    }
  });
}

async function deleteCommandMessage(message) {
  await message.delete().catch(() => {});
}

async function sendApplicationNotice(ctx, text) {
  const meta = commandEmbedMeta({ command: ctx.command, config: ctx.config, message: ctx.message });
  const dmSent = await sendEmbedPayload(ctx.message.author, text, meta)
    .then(() => true)
    .catch(() => false);

  if (dmSent) return true;

  const channelSent = await sendEmbedPayload(
    ctx.message.channel,
    {
      content: `${ctx.message.author} ${text}`,
      allowedMentions: { users: [ctx.message.author.id], roles: [] }
    },
    meta
  )
    .then(() => true)
    .catch(() => false);

  if (!channelSent) {
    console.warn(`[applications] Could not notify ${ctx.message.author.tag}: ${text}`);
  }

  return channelSent;
}

function closeThreadLater(client, channelId, reason, delayMs) {
  setTimeout(() => {
    client.channels
      .fetch(channelId)
      .then(async (channel) => {
        if (!channel?.isThread?.()) return;
        await channel.setLocked(true, reason).catch(() => {});
        await channel.setArchived(true, reason).catch(() => {});
      })
      .catch(() => {});
  }, delayMs);
}

function parseDuration(input = "") {
  const match = input.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return amount * multipliers[unit];
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatUptime(totalSeconds) {
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${days}d ${hours}h ${minutes}m`;
}

function safeContent(text, fallback = "No text provided.") {
  const cleaned = String(text || "").trim();
  return cleaned ? cleaned.slice(0, 1800) : fallback;
}

function normalizeBlockedWord(word) {
  return String(word || "").trim().toLowerCase().slice(0, 80);
}

async function sendModerationLog(ctx, content) {
  const channelId = ctx.config.moderation?.logChannelId;
  if (!channelId) return;

  const channel =
    ctx.message.guild.channels.cache.get(channelId) ||
    (await ctx.message.guild.channels.fetch(channelId).catch(() => null));

  if (!channel?.isTextBased()) return;

  const embed = buildPrettyEmbed({
    title: `Moderation Log: ${ctx.config.prefix}${ctx.command.name}`,
    description: safeContent(content),
    color: 0xef4444,
    footer: `${ctx.message.author.tag} (${ctx.message.author.id}) in #${ctx.message.channel.name}`
  });

  await channel
    .send({
      embeds: [embed],
      allowedMentions: NO_MENTIONS
    })
    .catch(() => {});
}

function targetTextChannel(message) {
  return message.mentions.channels.first() || message.channel;
}

function isSupportedImageAttachment(attachment) {
  const contentType = attachment.contentType?.toLowerCase() || "";
  const extension = attachment.name?.split(".").pop()?.toLowerCase();
  return (
    IMAGE_CONTENT_TYPES.has(contentType) ||
    ["png", "jpg", "jpeg", "webp"].includes(extension)
  );
}

async function findImageAttachment(message) {
  const directAttachment = message.attachments.find(isSupportedImageAttachment);
  if (directAttachment) return directAttachment;

  const referencedMessageId = message.reference?.messageId;
  if (!referencedMessageId) return null;

  const referencedMessage = await message.channel.messages.fetch(referencedMessageId).catch(() => null);
  return referencedMessage?.attachments.find(isSupportedImageAttachment) || null;
}

async function downloadAttachment(attachment) {
  if (attachment.size && attachment.size > MAX_CHIPIFY_IMAGE_BYTES) {
    throw new Error("That image is too large. Please use an image under 20 MB.");
  }

  const response = await fetch(attachment.url);
  if (!response.ok) {
    throw new Error("I could not download that image from Discord.");
  }

  const contentType = response.headers.get("content-type") || attachment.contentType || "image/png";
  if (!isSupportedImageAttachment({ contentType, name: attachment.name })) {
    throw new Error("Please use a PNG, JPG, or WebP image.");
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_CHIPIFY_IMAGE_BYTES) {
    throw new Error("That image is too large. Please use an image under 20 MB.");
  }

  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType: contentType.split(";")[0],
    filename: attachment.name || "chipify.png"
  };
}

function channelMentionList(ids) {
  return ids.length ? ids.map((id) => `<#${id}>`).join(", ") : "none";
}

function splitArgs(content, prefix) {
  const withoutPrefix = content.slice(prefix.length).trim();
  const parts = withoutPrefix.split(/\s+/);
  const commandName = parts.shift()?.toLowerCase();
  return {
    commandName,
    args: parts,
    rest: withoutPrefix.slice(commandName?.length || 0).trim()
  };
}

const STARTING_BREAD = 500;
const DAILY_BREAD = 300;
const MAX_BREAD_BET = 10_000;
const DAILY_COOLDOWN_MS = 20 * 60 * 60 * 1000;

function normalizeEconomy(economy = {}) {
  return {
    balances: { ...(economy.balances || {}) },
    dailyClaims: { ...(economy.dailyClaims || {}) }
  };
}

function breadBalance(economy, userId) {
  return Math.max(Math.floor(Number(economy.balances?.[userId] ?? STARTING_BREAD) || 0), 0);
}

function setBreadBalance(economy, userId, amount) {
  economy.balances[userId] = Math.max(Math.floor(Number(amount) || 0), 0);
}

function formatBread(amount) {
  return `${Math.floor(amount).toLocaleString()} bread`;
}

function parseBreadAmount(input, balance) {
  const raw = String(input || "").trim().toLowerCase();
  if (raw === "all" || raw === "max") return Math.min(balance, MAX_BREAD_BET);
  if (raw === "half") return Math.min(Math.floor(balance / 2), MAX_BREAD_BET);

  const amount = Math.floor(Number(raw.replaceAll(",", "")));
  if (!Number.isFinite(amount)) return null;
  return amount;
}

function validateBreadBet(input, balance) {
  const amount = parseBreadAmount(input, balance);
  if (!amount || amount < 1) return { ok: false, error: "Bet at least 1 bread." };
  if (amount > balance) return { ok: false, error: `You only have ${formatBread(balance)}.` };
  if (amount > MAX_BREAD_BET) return { ok: false, error: `Max bet is ${formatBread(MAX_BREAD_BET)}.` };
  return { ok: true, amount };
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function updateBreadEconomy(ctx, mutator) {
  const guildId = ctx.message.guild.id;
  const latestConfig = ctx.store.getGuild(guildId);
  const economy = normalizeEconomy(latestConfig.economy);
  const result = await mutator(economy, latestConfig);
  await ctx.store.updateGuild(guildId, { economy });
  return result;
}

async function runBreadBet(ctx, gameName, resolver) {
  const reply = await updateBreadEconomy(ctx, async (economy) => {
    const userId = ctx.message.author.id;
    const balance = breadBalance(economy, userId);
    const bet = validateBreadBet(ctx.args[0], balance);
    if (!bet.ok) return bet.error;

    const result = resolver(bet.amount, balance, economy);
    const payout = Math.max(Math.floor(Number(result.payout) || 0), 0);
    const nextBalance = balance - bet.amount + payout;
    setBreadBalance(economy, userId, nextBalance);

    return [
      `**${gameName}**`,
      result.text,
      `Bet: ${formatBread(bet.amount)}`,
      `Payout: ${formatBread(payout)}`,
      `Balance: ${formatBread(nextBalance)}`
    ].join("\n");
  });

  await ctx.message.reply(reply);
}

define({
  name: "help",
  aliases: ["commands"],
  category: "General",
  description: "Show commands, or details for one command.",
  usage: "help [command]",
  async run(ctx) {
    const target = ctx.args[0]?.toLowerCase();
    const command = target ? ctx.commands.get(target) : null;

    if (command) {
      await ctx.message.reply(
        [
          `**${ctx.config.prefix}${command.name}**`,
          command.description,
          `Usage: \`${usage(ctx.config, command)}\``,
          command.aliases?.length ? `Aliases: ${command.aliases.join(", ")}` : ""
        ]
          .filter(Boolean)
          .join("\n")
      );
      return;
    }

    const byCategory = new Map();
    for (const item of ctx.commandList) {
      const category = item.category || "Other";
      byCategory.set(category, [...(byCategory.get(category) || []), item]);
    }

    const lines = [...byCategory.entries()].map(([category, items]) => {
      const names = items.map((item) => `\`${ctx.config.prefix}${item.name}\``).join(" ");
      return `**${category}**\n${names}`;
    });

    await ctx.message.reply(
      `Commands for this server use \`${ctx.config.prefix}\`.\n\n${lines.join("\n\n")}\n\nUse \`${ctx.config.prefix}help command\` for details.`
    );
  }
});

define({
  name: "ping",
  category: "General",
  description: "Check bot latency.",
  async run(ctx) {
    const sent = await ctx.message.reply("Pinging...");
    await sent.edit(
      toEmbedPayload(
        `Pong. Discord latency: ${sent.createdTimestamp - ctx.message.createdTimestamp}ms.`,
        commandEmbedMeta({ command: ctx.command, config: ctx.config, message: ctx.message })
      )
    );
  }
});

define({
  name: "config",
  aliases: ["panel"],
  category: "General",
  description: "Get the web config panel link.",
  async run(ctx) {
    await ctx.message.reply(`Open the config panel: ${ctx.publicUrl}`);
  }
});

define({
  name: "invite",
  category: "General",
  description: "Get the bot invite link.",
  async run(ctx) {
    if (!ctx.clientId) {
      await ctx.message.reply("Set `CLIENT_ID` in `.env` to enable invite links.");
      return;
    }

    await ctx.message.reply(
      `Invite link: https://discord.com/oauth2/authorize?client_id=${ctx.clientId}&permissions=361045691472&scope=bot%20applications.commands`
    );
  }
});

define({
  name: "uptime",
  category: "General",
  description: "Show how long the bot process has been running.",
  async run(ctx) {
    await ctx.message.reply(`Uptime: ${formatUptime(Math.floor(process.uptime()))}.`);
  }
});

define({
  name: "botinfo",
  aliases: ["about"],
  category: "General",
  description: "Show bot status.",
  async run(ctx) {
    await ctx.message.reply(
      `Logged in as ${ctx.client.user.tag}. Serving ${ctx.client.guilds.cache.size} server(s). AI: ${ctx.ai.enabled ? "configured" : "missing API key"}.`
    );
  }
});

define({
  name: "server",
  aliases: ["serverinfo"],
  category: "Info",
  description: "Show server details.",
  async run(ctx) {
    const guild = ctx.message.guild;
    await ctx.message.reply(
      [
        `**${guild.name}**`,
        `Members: ${guild.memberCount}`,
        `Channels: ${guild.channels.cache.size}`,
        `Roles: ${guild.roles.cache.size}`,
        `Created: <t:${Math.floor(guild.createdTimestamp / 1000)}:D>`
      ].join("\n")
    );
  }
});

define({
  name: "user",
  aliases: ["userinfo"],
  category: "Info",
  description: "Show user details.",
  usage: "user [@user]",
  async run(ctx) {
    const member = mentionUser(ctx.message);
    await ctx.message.reply(
      [
        `**${member.user.tag}**`,
        `ID: ${member.id}`,
        `Joined: ${member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:D>` : "unknown"}`,
        `Created: <t:${Math.floor(member.user.createdTimestamp / 1000)}:D>`,
        `Roles: ${Math.max(member.roles.cache.size - 1, 0)}`
      ].join("\n")
    );
  }
});

define({
  name: "avatar",
  category: "Info",
  description: "Show a user's avatar.",
  usage: "avatar [@user]",
  async run(ctx) {
    const member = mentionUser(ctx.message);
    await ctx.message.reply(member.displayAvatarURL({ size: 1024 }));
  }
});

define({
  name: "roles",
  category: "Info",
  description: "List server roles.",
  async run(ctx) {
    const roles = ctx.message.guild.roles.cache
      .filter((role) => role.name !== "@everyone")
      .sort((a, b) => b.position - a.position)
      .map((role) => role.name)
      .slice(0, 50)
      .join(", ");
    await ctx.message.reply(roles || "No roles found.");
  }
});

define({
  name: "channels",
  category: "Info",
  description: "List text channels.",
  async run(ctx) {
    const channels = ctx.message.guild.channels.cache
      .filter((channel) => channel.isTextBased())
      .map((channel) => `#${channel.name}`)
      .slice(0, 50)
      .join(", ");
    await ctx.message.reply(channels || "No text channels found.");
  }
});

define({
  name: "coinflip",
  aliases: ["coin"],
  category: "Fun",
  description: "Flip a coin.",
  async run(ctx) {
    await ctx.message.reply(Math.random() > 0.5 ? "Heads." : "Tails.");
  }
});

define({
  name: "roll",
  aliases: ["dice"],
  category: "Fun",
  description: "Roll dice, like 2d20.",
  usage: "roll [dice]",
  async run(ctx) {
    const dice = ctx.args[0] || "1d6";
    const match = dice.match(/^(\d{1,2})d(\d{1,4})$/i);
    if (!match) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }

    const count = Math.min(Number(match[1]), 20);
    const sides = Math.min(Number(match[2]), 1000);
    const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
    await ctx.message.reply(`Rolled ${dice}: ${rolls.join(", ")} = **${rolls.reduce((a, b) => a + b, 0)}**`);
  }
});

define({
  name: "choose",
  category: "Fun",
  description: "Choose between options separated by commas.",
  usage: "choose pizza, tacos, soup",
  async run(ctx) {
    const options = ctx.rest.split(",").map((item) => item.trim()).filter(Boolean);
    if (options.length < 2) {
      await ctx.message.reply("Give me at least two comma-separated options.");
      return;
    }

    await ctx.message.reply(`I choose: **${options[Math.floor(Math.random() * options.length)]}**.`);
  }
});

define({
  name: "8ball",
  category: "Fun",
  description: "Ask the artifact a yes/no question.",
  usage: "8ball will we win?",
  async run(ctx) {
    await ctx.message.reply(eightBallAnswers[Math.floor(Math.random() * eightBallAnswers.length)]);
  }
});

define({
  name: "rate",
  category: "Fun",
  description: "Rate something from 0 to 100.",
  usage: "rate my drip",
  async run(ctx) {
    const thing = safeContent(ctx.rest, "that");
    const score = Math.floor(Math.random() * 101);
    await ctx.message.reply(`${thing} is ${score}/100 on the artifact scale.`);
  }
});

define({
  name: "curse",
  category: "Fun",
  description: "Deliver a Chipkittle curse to a member.",
  usage: "curse @user",
  async run(ctx) {
    const curses = [
      "doesn't have the horns for this family",
      "is unworthy of the suit",
      "lacks the artifact's blessing",
      "is too weak to join the Round Table",
      "will never understand the ceremony",
      "is a stain on the Chipkittle name",
      "doesn't deserve a Chipkittle name",
      "failed the silence test",
      "has betrayed the principles",
      "is banned from the bakery",
      "will never wear the suit",
      "lacks respect for the family",
      "will never comprehend the lore",
      "is cursed by the artifact",
      "doesn't have what it takes",
      "is forever banned from bread",
      "will never rise in rank",
      "is a disappointment to the horns",
      "lacks the silent strength",
      "is not worthy of Chipkittle honor"
    ];

    await ctx.message.delete().catch(() => {});
    const member = mentionUser(ctx.message);
    const curse = curses[Math.floor(Math.random() * curses.length)];
    
    const embed = new EmbedBuilder()
      .setColor(0xef4444)
      .setTitle("Chipkittle Judgment")
      .setDescription(`${member} ${curse}.`)
      .setFooter({ text: "The artifact has spoken." });
    
    await ctx.message.channel.send({ embeds: [embed], allowedMentions: NO_MENTIONS });
  }
});

define({
  name: "ship",
  category: "Fun",
  description: "Calculate fake compatibility.",
  usage: "ship @user @user",
  async run(ctx) {
    const users = [...ctx.message.mentions.users.values()];
    const first = users[0]?.username || ctx.message.author.username;
    const second = users[1]?.username || ctx.args.join(" ") || "the ancient artifact";
    await ctx.message.reply(`${first} + ${second}: ${Math.floor(Math.random() * 101)}% Chipkittle harmony.`);
  }
});

define({
  name: "date",
  category: "Fun",
  description: "Invite someone to date you in the server.",
  usage: "date @user",
  async run(ctx) {
    const mentions = [...ctx.message.mentions.users.values()];
    const requester = ctx.message.author;

    if (mentions.length !== 1) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\` — mention exactly one user.`);
      return;
    }

    const target = mentions[0];
    if (target.id === requester.id) {
      await ctx.message.reply("You cannot date yourself.");
      return;
    }
    if (target.bot) {
      await ctx.message.reply("You cannot invite a bot to date. ");
      return;
    }
    if (isUserDating(requester.id)) {
      await ctx.message.reply("You are already dating someone. End your current relationship before inviting another person.");
      return;
    }
    if (isUserDating(target.id)) {
      await ctx.message.reply(`${target} is already dating someone else.`);
      return;
    }
    if (requesterHasPendingRequest(ctx.message.guild.id, requester.id)) {
      await ctx.message.reply("You already have a pending date invitation. Wait for it to be accepted or denied before sending another.");
      return;
    }

    const key = pendingDateKey(ctx.message.guild.id, target.id);
    if (pendingDateRequests.has(key)) {
      await ctx.message.reply(`${target} already has a pending date invitation.`);
      return;
    }

    pendingDateRequests.set(key, {
      guildId: ctx.message.guild.id,
      requesterId: requester.id,
      requesterTag: requester.tag,
      requesterMention: `<@${requester.id}>`
    });

    const embed = new EmbedBuilder()
      .setTitle("Date Request Sent")
      .setDescription(`${requester} has asked ${target} to date them. ${target}, respond with \`${ctx.config.prefix}dateaccept\` or \`${ctx.config.prefix}datedeny\`.`)
      .setColor(0xff99cc);

    await ctx.message.channel.send({ embeds: [embed], allowedMentions: NO_MENTIONS });
  }
});

define({
  name: "dateaccept",
  category: "Fun",
  description: "Accept a date invitation.",
  async run(ctx) {
    const recipient = ctx.message.author;
    const key = pendingDateKey(ctx.message.guild.id, recipient.id);
    const request = pendingDateRequests.get(key);

    if (!request) {
      const embed = new EmbedBuilder()
        .setTitle("No Date Request")
        .setDescription("You do not have any pending date invitations.")
        .setColor(0xffcc99);
      await ctx.message.reply({ embeds: [embed], allowedMentions: NO_MENTIONS });
      return;
    }

    if (isUserDating(recipient.id)) {
      pendingDateRequests.delete(key);
      const embed = new EmbedBuilder()
        .setTitle("Already Dating")
        .setDescription("You are already dating someone else, so this invitation cannot be accepted.")
        .setColor(0xffcc99);
      await ctx.message.reply({ embeds: [embed], allowedMentions: NO_MENTIONS });
      return;
    }

    if (isUserDating(request.requesterId)) {
      pendingDateRequests.delete(key);
      const embed = new EmbedBuilder()
        .setTitle("Requester Already Dating")
        .setDescription(`${request.requesterMention} is already dating someone else, so this invitation cannot be accepted.`)
        .setColor(0xffcc99);
      await ctx.message.reply({ embeds: [embed], allowedMentions: NO_MENTIONS });
      return;
    }

    pendingDateRequests.delete(key);
    currentDates.set(recipient.id, request.requesterId);
    currentDates.set(request.requesterId, recipient.id);

    const embed = new EmbedBuilder()
      .setTitle("Date Accepted")
      .setDescription(`${recipient} accepted ${request.requesterMention}'s date invitation. You are now officially dating.`)
      .setColor(0x99ffcc);

    await ctx.message.channel.send({ embeds: [embed], allowedMentions: NO_MENTIONS });
  }
});

define({
  name: "datedeny",
  category: "Fun",
  description: "Deny a date invitation.",
  async run(ctx) {
    const recipient = ctx.message.author;
    const key = pendingDateKey(ctx.message.guild.id, recipient.id);
    const request = pendingDateRequests.get(key);

    if (!request) {
      const embed = new EmbedBuilder()
        .setTitle("No Date Request")
        .setDescription("You do not have any pending date invitations.")
        .setColor(0xffcc99);
      await ctx.message.reply({ embeds: [embed], allowedMentions: NO_MENTIONS });
      return;
    }

    pendingDateRequests.delete(key);
    const embed = new EmbedBuilder()
      .setTitle("Date Denied")
      .setDescription(`${recipient} declined ${request.requesterMention}'s date invitation. Maybe the artifact will bless someone else.`)
      .setColor(0xff6666);

    await ctx.message.channel.send({ embeds: [embed], allowedMentions: NO_MENTIONS });
  }
});

define({
  name: "datebreak",
  category: "Fun",
  description: "End your current dating relationship.",
  async run(ctx) {
    const requester = ctx.message.author;
    const partnerId = currentDatePartner(requester.id);

    if (!partnerId) {
      const embed = new EmbedBuilder()
        .setTitle("No Relationship")
        .setDescription("You are not currently dating anyone.")
        .setColor(0xffcc99);
      await ctx.message.reply({ embeds: [embed], allowedMentions: NO_MENTIONS });
      return;
    }

    clearDatePair(requester.id);
    const embed = new EmbedBuilder()
      .setTitle("Date Broken")
      .setDescription(`${requester} has ended their dating relationship with <@${partnerId}>. The ceremony is over.`)
      .setColor(0xff9999);

    await ctx.message.channel.send({ embeds: [embed], allowedMentions: NO_MENTIONS });
  }
});

define({
  name: "datehelp",
  category: "Fun",
  description: "List all date-related commands.",
  usage: "datehelp",
  async run(ctx) {
    const commandNames = [
      "date",
      "dateaccept",
      "datedeny",
      "datebreak",
      "dateinfo",
      "kiss",
      "hug",
      "holdhands",
      "sex",
      "homewreck",
      "cheat"
    ];
    const commands = commandNames
      .map((name) => ctx.commandList.find((command) => command.name === name))
      .filter(Boolean);

    const fields = commands.map((command) => ({
      name: `${ctx.config.prefix}${command.usage || command.name}`,
      value: command.description || "No description available.",
      inline: false
    }));

    const embed = new EmbedBuilder()
      .setTitle("Date Commands")
      .setDescription("Use these commands to send requests, accept, deny, break up, or announce a dating scandal.")
      .addFields(fields)
      .setColor(0x99ccff);

    await ctx.message.reply({ embeds: [embed], allowedMentions: NO_MENTIONS });
  }
});

define({
  name: "cheat",
  category: "Fun",
  description: "Cheat on your partner with someone else.",
  usage: "cheat @user",
  async run(ctx) {
    const mentions = [...ctx.message.mentions.users.values()];
    const requester = ctx.message.author;

    if (mentions.length !== 1) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\` — mention exactly one user.`);
      return;
    }

    const target = mentions[0];
    if (target.id === requester.id) {
      await ctx.message.reply("You cannot cheat with yourself.");
      return;
    }
    if (!isUserDating(requester.id)) {
      await ctx.message.reply("You are not currently dating anyone.");
      return;
    }

    const partnerId = currentDatePartner(requester.id);
    const embed = new EmbedBuilder()
      .setTitle("Cheating Scandal")
      .setDescription(`${requester} cheated on <@${partnerId}> with ${target}. The artifact is watching.`)
      .setColor(0xff3366);

    await ctx.message.channel.send({ embeds: [embed], allowedMentions: NO_MENTIONS });
  }
});

define({
  name: "kiss",
  category: "Fun",
  description: "Send a Chipkittle kiss to someone.",
  usage: "kiss @user",
  async run(ctx) {
    const mentions = [...ctx.message.mentions.users.values()];
    const requester = ctx.message.author;

    if (mentions.length !== 1) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\` — mention exactly one user.`);
      return;
    }

    const target = mentions[0];
    if (target.id === requester.id) {
      await ctx.message.reply("You cannot kiss yourself.");
      return;
    }
    if (target.bot) {
      await ctx.message.reply("Bots do not return kisses.");
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle("Sweet Kiss")
      .setDescription(`${requester} gives ${target} a gentle Chipkittle kiss. Romance is in the air.`)
      .setColor(0xff99cc);

    await ctx.message.channel.send({ embeds: [embed], allowedMentions: NO_MENTIONS });
  }
});

define({
  name: "hug",
  category: "Fun",
  description: "Wrap someone in a cozy Chipkittle hug.",
  usage: "hug @user",
  async run(ctx) {
    const mentions = [...ctx.message.mentions.users.values()];
    const requester = ctx.message.author;

    if (mentions.length !== 1) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\` — mention exactly one user.`);
      return;
    }

    const target = mentions[0];
    if (target.id === requester.id) {
      await ctx.message.reply("You cannot hug yourself.");
      return;
    }
    if (target.bot) {
      await ctx.message.reply("Bots do not feel warm hugs.");
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle("Warm Hug")
      .setDescription(`${requester} wraps ${target} in a comforting Chipkittle hug. Cozy vibes all around.`)
      .setColor(0x99ccff);

    await ctx.message.channel.send({ embeds: [embed], allowedMentions: NO_MENTIONS });
  }
});

define({
  name: "holdhands",
  category: "Fun",
  description: "Take someone's hand in a Chipkittle way.",
  usage: "holdhands @user",
  async run(ctx) {
    const mentions = [...ctx.message.mentions.users.values()];
    const requester = ctx.message.author;

    if (mentions.length !== 1) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\` — mention exactly one user.`);
      return;
    }

    const target = mentions[0];
    if (target.id === requester.id) {
      await ctx.message.reply("You cannot hold hands with yourself.");
      return;
    }
    if (target.bot) {
      await ctx.message.reply("Bots do not have hands to hold.");
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle("Hand Holding")
      .setDescription(`${requester} takes ${target}'s hand and walks in silent Chipkittle solidarity.`)
      .setColor(0xccaaff);

    await ctx.message.channel.send({ embeds: [embed], allowedMentions: NO_MENTIONS });
  }
});

define({
  name: "sex",
  category: "Fun",
  description: "Share a flirty Chipkittle moment with someone.",
  usage: "sex @user",
  async run(ctx) {
    const mentions = [...ctx.message.mentions.users.values()];
    const requester = ctx.message.author;

    if (mentions.length !== 1) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\` — mention exactly one user.`);
      return;
    }

    const target = mentions[0];
    if (target.id === requester.id) {
      await ctx.message.reply("You cannot do that to yourself.");
      return;
    }
    if (target.bot) {
      await ctx.message.reply("Bots are not part of Chipkittle romance.");
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle("Hot Chipkittle Moment")
      .setDescription(`${requester} and ${target} shared a very intimate Chipkittle moment. Keep it spicy.`)
      .setColor(0xff3399);

    await ctx.message.channel.send({ embeds: [embed], allowedMentions: NO_MENTIONS });
  }
});

define({
  name: "dateinfo",
  category: "Fun",
  description: "Check who you're actively dating.",
  async run(ctx) {
    const requester = ctx.message.author;
    const partnerId = currentDatePartner(requester.id);

    if (!partnerId) {
      const embed = new EmbedBuilder()
        .setTitle("Dating Status")
        .setDescription("You are not currently dating anyone.")
        .setColor(0xffcc99);
      await ctx.message.reply({ embeds: [embed], allowedMentions: NO_MENTIONS });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle("Dating Status")
      .setDescription(`You are dating <@${partnerId}>.`)
      .setColor(0x99ffcc);

    await ctx.message.reply({ embeds: [embed], allowedMentions: NO_MENTIONS });
  }
});

define({
  name: "homewreck",
  category: "Fun",
  description: "Homewreck someone's relationship with a steamy moment.",
  usage: "homewreck @user",
  async run(ctx) {
    const mentions = [...ctx.message.mentions.users.values()];
    const requester = ctx.message.author;

    if (mentions.length !== 1) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\` — mention exactly one user.`);
      return;
    }

    const target = mentions[0];
    if (target.id === requester.id) {
      await ctx.message.reply("You cannot homewreck yourself.");
      return;
    }
    if (target.bot) {
      await ctx.message.reply("Bots are not part of Chipkittle romance.");
      return;
    }
    if (!isUserDating(target.id)) {
      await ctx.message.reply(`${target} is not in a relationship. Use !sex instead.`);
      return;
    }

    const partnerId = currentDatePartner(target.id);
    const embed = new EmbedBuilder()
      .setTitle("Homewrecking Scandal")
      .setDescription(`${requester} homewrecked ${target}'s relationship with <@${partnerId}> in a steamy Chipkittle moment. Drama ensues.`)
      .setColor(0xff3366);

    await ctx.message.channel.send({ embeds: [embed], allowedMentions: NO_MENTIONS });
  }
});

define({
  name: "poll",
  category: "Fun",
  description: "Create a quick yes/no poll.",
  usage: "poll question",
  async run(ctx) {
    const question = safeContent(ctx.rest, "Should the artifact be polished?");
    const poll = await ctx.message.channel.send(`**Poll:** ${question}`);
    await poll.react("👍");
    await poll.react("👎");
  }
});

define({
  name: "bread",
  aliases: ["balance", "bal", "wallet"],
  category: "Gambling",
  description: "Check your bread balance.",
  usage: "bread [@user]",
  async run(ctx) {
    const economy = normalizeEconomy(ctx.store.getGuild(ctx.message.guild.id).economy);
    const target = ctx.message.mentions.users.first?.() || ctx.message.author;
    await ctx.message.reply(`${target.username || target.tag} has **${formatBread(breadBalance(economy, target.id))}**.`);
  }
});

define({
  name: "dailybread",
  aliases: ["daily", "breadclaim"],
  category: "Gambling",
  description: "Claim free daily bread.",
  async run(ctx) {
    const output = await updateBreadEconomy(ctx, async (economy) => {
      const userId = ctx.message.author.id;
      const lastClaim = new Date(economy.dailyClaims[userId] || 0).getTime();
      const remaining = DAILY_COOLDOWN_MS - (Date.now() - lastClaim);
      if (remaining > 0) {
        return `You already claimed daily bread. Try again in ${formatCooldown(remaining)}.`;
      }

      const bonus = randomInt(0, 150);
      const amount = DAILY_BREAD + bonus;
      const nextBalance = breadBalance(economy, userId) + amount;
      economy.dailyClaims[userId] = new Date().toISOString();
      setBreadBalance(economy, userId, nextBalance);
      return `You claimed **${formatBread(amount)}**.\nBalance: **${formatBread(nextBalance)}**.`;
    });

    await ctx.message.reply(output);
  }
});

define({
  name: "breadgive",
  aliases: ["paybread", "givebread"],
  category: "Gambling",
  description: "Give bread to another user.",
  usage: "breadgive @user 100",
  async run(ctx) {
    const target = ctx.message.mentions.users.first?.();
    const amountInput = ctx.args.find((arg) => !arg.includes("<@"));
    if (!target || target.bot || target.id === ctx.message.author.id || !amountInput) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }

    const output = await updateBreadEconomy(ctx, async (economy) => {
      const senderBalance = breadBalance(economy, ctx.message.author.id);
      const amount = parseBreadAmount(amountInput, senderBalance);
      if (!amount || amount < 1) return "Give at least 1 bread.";
      if (amount > senderBalance) return `You only have ${formatBread(senderBalance)}.`;

      setBreadBalance(economy, ctx.message.author.id, senderBalance - amount);
      setBreadBalance(economy, target.id, breadBalance(economy, target.id) + amount);
      return `Sent **${formatBread(amount)}** to **${target.username || target.tag}**.`;
    });

    await ctx.message.reply(output);
  }
});

define({
  name: "breadtop",
  aliases: ["breadleaderboard", "breadlb"],
  category: "Gambling",
  description: "Show the richest bread holders.",
  async run(ctx) {
    const economy = normalizeEconomy(ctx.store.getGuild(ctx.message.guild.id).economy);
    const entries = Object.entries(economy.balances)
      .map(([userId, amount]) => [userId, Math.max(Math.floor(Number(amount) || 0), 0)])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    if (!entries.length) {
      await ctx.message.reply("No bread accounts have moved yet. Claim daily bread and start baking.");
      return;
    }

    await ctx.message.reply(
      entries
        .map(([userId, amount], index) => `${index + 1}. <@${userId}> - **${formatBread(amount)}**`)
        .join("\n")
    );
  }
});

define({
  name: "breadflip",
  aliases: ["betflip"],
  category: "Gambling",
  description: "Bet bread on heads or tails.",
  usage: "breadflip 100 heads",
  async run(ctx) {
    const guess = (ctx.args[1] || "").toLowerCase();
    if (!["heads", "tails", "h", "t"].includes(guess)) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }

    await runBreadBet(ctx, "Bread Flip", (bet) => {
      const pickedHeads = guess === "heads" || guess === "h";
      const resultHeads = Math.random() < 0.5;
      const won = pickedHeads === resultHeads;
      return {
        payout: won ? bet * 2 : 0,
        text: `You picked **${pickedHeads ? "heads" : "tails"}**. It landed **${resultHeads ? "heads" : "tails"}**. ${won ? "You win." : "You lose."}`
      };
    });
  }
});

define({
  name: "slots",
  aliases: ["breadslots"],
  category: "Gambling",
  description: "Spin the bread slots.",
  usage: "slots 100",
  async run(ctx) {
    const symbols = ["loaf", "horns", "suit", "artifact", "crumb", "ck"];
    await runBreadBet(ctx, "Bread Slots", (bet) => {
      const spin = Array.from({ length: 3 }, () => symbols[randomInt(0, symbols.length - 1)]);
      const counts = spin.reduce((map, symbol) => ({ ...map, [symbol]: (map[symbol] || 0) + 1 }), {});
      const maxMatches = Math.max(...Object.values(counts));
      const payout = maxMatches === 3 ? bet * (spin[0] === "artifact" ? 12 : 6) : maxMatches === 2 ? Math.floor(bet * 1.5) : 0;
      return {
        payout,
        text: `[ ${spin.join(" | ")} ]\n${payout ? "The bakery pays out." : "The loaf goes stale."}`
      };
    });
  }
});

define({
  name: "breaddice",
  aliases: ["gamble", "dicebet"],
  category: "Gambling",
  description: "Bet that your die beats the house.",
  usage: "breaddice 100",
  async run(ctx) {
    await runBreadBet(ctx, "Bread Dice", (bet) => {
      const player = randomInt(1, 6);
      const house = randomInt(1, 6);
      const payout = player > house ? bet * 2 : player === house ? bet : 0;
      return {
        payout,
        text: `You rolled **${player}**. House rolled **${house}**. ${player > house ? "You win." : player === house ? "Push." : "House wins."}`
      };
    });
  }
});

define({
  name: "highlow",
  aliases: ["hl"],
  category: "Gambling",
  description: "Bet whether the next card is higher or lower.",
  usage: "highlow 100 high",
  async run(ctx) {
    const guess = (ctx.args[1] || "").toLowerCase();
    if (!["high", "higher", "low", "lower"].includes(guess)) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }

    await runBreadBet(ctx, "High Low", (bet) => {
      const first = randomInt(1, 13);
      const second = randomInt(1, 13);
      const wantsHigh = guess === "high" || guess === "higher";
      const won = wantsHigh ? second > first : second < first;
      const tied = second === first;
      return {
        payout: tied ? bet : won ? bet * 2 : 0,
        text: `First card: **${first}**. Next card: **${second}**. ${tied ? "Tie, bet returned." : won ? "You called it." : "Wrong call."}`
      };
    });
  }
});

define({
  name: "roulette",
  aliases: ["breadroulette"],
  category: "Gambling",
  description: "Bet bread on red, black, green, odd, even, or a number.",
  usage: "roulette 100 red",
  async run(ctx) {
    const choice = (ctx.args[1] || "").toLowerCase();
    const numberChoice = Number(choice);
    const valid =
      ["red", "black", "green", "odd", "even"].includes(choice) ||
      (Number.isInteger(numberChoice) && numberChoice >= 0 && numberChoice <= 36);
    if (!valid) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }

    await runBreadBet(ctx, "Bread Roulette", (bet) => {
      const roll = randomInt(0, 36);
      const color = roll === 0 ? "green" : roll % 2 === 0 ? "black" : "red";
      const parity = roll === 0 ? "green" : roll % 2 === 0 ? "even" : "odd";
      const numberHit = Number.isInteger(numberChoice) && roll === numberChoice;
      const colorHit = choice === color;
      const parityHit = choice === parity;
      const payout = numberHit ? bet * 36 : choice === "green" && colorHit ? bet * 14 : colorHit || parityHit ? bet * 2 : 0;
      return {
        payout,
        text: `Wheel: **${roll} ${color}**.\nYour bet: **${choice}**. ${payout ? "Winner." : "No bread today."}`
      };
    });
  }
});

define({
  name: "blackjack",
  aliases: ["bj"],
  category: "Gambling",
  description: "Play quick automatic blackjack for bread.",
  usage: "blackjack 100",
  async run(ctx) {
    function drawCard() {
      const value = randomInt(1, 13);
      if (value === 1) return { name: "A", value: 11 };
      if (value >= 11) return { name: ["J", "Q", "K"][value - 11], value: 10 };
      return { name: String(value), value };
    }

    function handValue(hand) {
      let total = hand.reduce((sum, card) => sum + card.value, 0);
      let aces = hand.filter((card) => card.name === "A").length;
      while (total > 21 && aces > 0) {
        total -= 10;
        aces -= 1;
      }
      return total;
    }

    function handText(hand) {
      return `${hand.map((card) => card.name).join(", ")} (${handValue(hand)})`;
    }

    await runBreadBet(ctx, "Bread Blackjack", (bet) => {
      const player = [drawCard(), drawCard()];
      const dealer = [drawCard(), drawCard()];

      while (handValue(player) < 16) player.push(drawCard());
      while (handValue(dealer) < 17) dealer.push(drawCard());

      const playerTotal = handValue(player);
      const dealerTotal = handValue(dealer);
      const natural = player.length === 2 && playerTotal === 21;
      const payout =
        playerTotal > 21
          ? 0
          : natural
            ? Math.floor(bet * 2.5)
            : dealerTotal > 21 || playerTotal > dealerTotal
              ? bet * 2
              : playerTotal === dealerTotal
                ? bet
                : 0;

      return {
        payout,
        text: `Your hand: **${handText(player)}**\nHouse hand: **${handText(dealer)}**\n${payout > bet ? "You win." : payout === bet ? "Push." : "House wins."}`
      };
    });
  }
});

define({
  name: "scratch",
  aliases: ["scratchcard"],
  category: "Gambling",
  description: "Buy a bread scratch card.",
  usage: "scratch 100",
  async run(ctx) {
    const symbols = ["loaf", "crumb", "horn", "suit", "ck", "artifact"];
    await runBreadBet(ctx, "Bread Scratch Card", (bet) => {
      const card = Array.from({ length: 6 }, () => symbols[randomInt(0, symbols.length - 1)]);
      const counts = card.reduce((map, symbol) => ({ ...map, [symbol]: (map[symbol] || 0) + 1 }), {});
      const maxMatches = Math.max(...Object.values(counts));
      const payout = maxMatches >= 6 ? bet * 25 : maxMatches === 5 ? bet * 10 : maxMatches === 4 ? bet * 4 : maxMatches === 3 ? bet * 2 : 0;
      return {
        payout,
        text: `${card.join(" | ")}\nBest match: **${maxMatches}**.`
      };
    });
  }
});

define({
  name: "cups",
  aliases: ["breadcups"],
  category: "Gambling",
  description: "Pick the cup hiding the bread.",
  usage: "cups 100 1",
  async run(ctx) {
    const pick = Number(ctx.args[1]);
    if (!Number.isInteger(pick) || pick < 1 || pick > 3) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }

    await runBreadBet(ctx, "Bread Cups", (bet) => {
      const winner = randomInt(1, 3);
      const won = pick === winner;
      return {
        payout: won ? bet * 3 : 0,
        text: `You picked cup **${pick}**. Bread was under cup **${winner}**. ${won ? "Sharp eyes." : "Empty cup."}`
      };
    });
  }
});

define({
  name: "crash",
  aliases: ["breadcrash"],
  category: "Gambling",
  description: "Cash out before the bread market crashes.",
  usage: "crash 100 2.0",
  async run(ctx) {
    const target = Math.min(Math.max(Number(ctx.args[1]) || 2, 1.1), 10);

    await runBreadBet(ctx, "Bread Crash", (bet) => {
      const crashPoint = Math.min(Math.max(Math.floor((1 / Math.random()) * 0.85 * 100) / 100, 1), 25);
      const won = target <= crashPoint;
      return {
        payout: won ? Math.floor(bet * target) : 0,
        text: `You tried to cash out at **${target.toFixed(2)}x**.\nMarket crashed at **${crashPoint.toFixed(2)}x**. ${won ? "You escaped with warm bread." : "Burnt toast."}`
      };
    });
  }
});

define({
  name: "jackpot",
  aliases: ["lottery"],
  category: "Gambling",
  description: "Buy a long-shot jackpot ticket.",
  usage: "jackpot 100",
  async run(ctx) {
    await runBreadBet(ctx, "Bread Jackpot", (bet) => {
      const roll = randomInt(1, 100);
      const payout = roll >= 96 ? bet * 25 : roll >= 86 ? bet * 4 : 0;
      return {
        payout,
        text: `Ticket roll: **${roll}**.\n${roll >= 96 ? "Massive jackpot." : roll >= 86 ? "Small prize." : "The bakery keeps the ticket."}`
      };
    });
  }
});

define({
  name: "remind",
  category: "Utility",
  description: "Set a simple reminder while the bot process is running.",
  usage: "remind 10m check the artifact",
  async run(ctx) {
    const duration = parseDuration(ctx.args[0]);
    const reminder = ctx.args.slice(1).join(" ");
    if (!duration || !reminder) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }

    setTimeout(() => {
      ctx.message.channel.send(`${ctx.message.author}, reminder: ${safeContent(reminder)}`).catch(() => {});
    }, Math.min(duration, 7 * 86_400_000));
    await ctx.message.reply(`Reminder set for ${formatDuration(duration)}.`);
  }
});

define({
  name: "timestamp",
  aliases: ["time"],
  category: "Utility",
  description: "Show a Discord timestamp for now or a unix time.",
  usage: "timestamp [unix]",
  async run(ctx) {
    const unix = Number(ctx.args[0]) || Math.floor(Date.now() / 1000);
    await ctx.message.reply(`<t:${unix}:F> | \`<t:${unix}:F>\``);
  }
});

define({
  name: "echo",
  category: "Utility",
  description: "Repeat a short message.",
  usage: "echo message",
  async run(ctx) {
    await ctx.message.reply(safeContent(ctx.rest));
  }
});

define({
  name: "embed",
  category: "Utility",
  description: "Send a simple embed.",
  usage: "embed title | description",
  async run(ctx) {
    const [title, description] = ctx.rest.split("|").map((item) => item?.trim());
    const embed = new EmbedBuilder()
      .setColor(0x65d6ad)
      .setTitle((title || "Chipkittle Notice").slice(0, 256))
      .setDescription((description || "The artifact has been observed.").slice(0, 4096));
    await ctx.message.channel.send({ embeds: [embed] });
  }
});

define({
  name: "chipkittle",
  category: "Chipkittle",
  description: "Explain what a Chipkittle is.",
  async run(ctx) {
    await ctx.message.reply(`${CHIPKITTLE_LORE.visual} The family exists to protect the ancient artifact, honor the roster, and move in silence.`);
  }
});

define({
  name: "artifact",
  category: "Chipkittle",
  description: "Receive artifact guidance.",
  async run(ctx) {
    await ctx.message.reply(randomChipkittleQuote());
  }
});

define({
  name: "oath",
  category: "Chipkittle",
  description: "Show the clean Chipkittle oath.",
  async run(ctx) {
    await ctx.message.reply(CHIPKITTLE_LORE.principles.map((rule, index) => `${index + 1}. ${rule}`).join("\n"));
  }
});

define({
  name: "chipname",
  aliases: ["name"],
  category: "Chipkittle",
  description: "Generate a safe Chipkittle name.",
  async run(ctx) {
    await ctx.message.reply(`Your Chipkittle name is **${randomChipkittleName()}**.`);
  }
});

define({
  name: "rank",
  category: "Chipkittle",
  description: "Assign a ceremonial rank.",
  usage: "rank [@user]",
  async run(ctx) {
    const member = mentionUser(ctx.message);
    const rank = CHIPKITTLE_LORE.ranks[Math.floor(Math.random() * CHIPKITTLE_LORE.ranks.length)];
    await ctx.message.reply(`${member} is now recognized as **${rank}**.`);
  }
});

define({
  name: "suit",
  category: "Chipkittle",
  description: "Describe the shared Chipkittle suit.",
  async run(ctx) {
    await ctx.message.reply(CHIPKITTLE_LORE.visual);
  }
});

define({
  name: "donation",
  category: "Chipkittle",
  description: "Generate a ceremonial donation total.",
  async run(ctx) {
    const amount = (Math.random() * 8 + 0.2).toFixed(1);
    await ctx.message.reply(`${ctx.message.member.displayName} has pledged ${amount} million imaginary bread units to the Chipkittle Donation Fund.`);
  }
});

define({
  name: "lore",
  category: "Chipkittle",
  description: "Show a random safe lore note.",
  async run(ctx) {
    const lore = ctx.args[0] === "rules" ? CHIPKITTLE_LORE.principles : CHIPKITTLE_LORE.figures;
    await ctx.message.reply(lore[Math.floor(Math.random() * lore.length)]);
  }
});

define({
  name: "chipify",
  aliases: ["chipimage", "chipkit"],
  category: "Chipkittle",
  description: "Turn an attached or replied-to image into a Chipkittle.",
  usage: "chipify [attach image] or reply to an image",
  async run(ctx) {
    if (!ctx.ai.enabled) {
      await ctx.message.reply("AI image generation is not configured yet. Add `OPENAI_API_KEY` to `.env`, then restart the bot.");
      return;
    }

    if (isAiChannelBlacklisted(ctx.config, ctx.message.channel.id)) {
      await ctx.message.reply("Chipkittle AI is blacklisted in this channel.");
      return;
    }

    const attachment = await findImageAttachment(ctx.message);
    if (!attachment) {
      await ctx.message.reply(`Attach an image with \`${usage(ctx.config, this)}\`, or reply to an image with \`${ctx.config.prefix}chipify\`.`);
      return;
    }

    const rateLimit = checkAiRateLimit({
      guildId: ctx.message.guild.id,
      userId: ctx.message.author.id,
      cooldownSeconds: ctx.config.ai.imageCooldownSeconds,
      bucket: "image"
    });

    if (rateLimit.limited) {
      await ctx.message.reply({
        content: `The artifact is cooling down. Try again in ${rateLimit.retryAfterSeconds}s.`,
        allowedMentions: NO_MENTIONS
      });
      return;
    }

    const status = await ctx.message.reply("Chipifying image... this can take a little bit.");

    try {
      const source = await downloadAttachment(attachment);
      const imageBuffer = await ctx.ai.chipifyImage({
        imageBuffer: source.buffer,
        mimeType: source.mimeType,
        filename: source.filename,
        userId: ctx.message.author.id
      });
      const file = new AttachmentBuilder(imageBuffer, { name: "chipified.png" });
      await status.edit({
        content: `${ctx.message.author}, behold: chipified.`,
        files: [file],
        allowedMentions: NO_MENTIONS
      });
    } catch (error) {
      console.error("Chipify failed:", error);
      await status.edit(error.message || "The artifact failed to chipify that image.").catch(() => {});
    }
  }
});

define({
  name: "purge",
  aliases: ["clear"],
  category: "Moderation",
  description: "Bulk delete recent messages.",
  usage: "purge 10",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageMessages)) return;
    const count = Math.min(Math.max(Number(ctx.args[0]) || 0, 1), 100);
    const deleted = await ctx.message.channel.bulkDelete(count, true).catch(() => null);
    const output = `Deleted ${deleted?.size || 0} message(s).`;
    await ctx.message.channel.send(output).then((msg) => setTimeout(() => msg.delete().catch(() => {}), 4000));
    await sendModerationLog(ctx, output);
  }
});

define({
  name: "warn",
  category: "Moderation",
  description: "Warn a user and store it in config data.",
  usage: "warn @user reason",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ModerateMembers)) return;
    const member = ctx.message.mentions.members.first();
    const reason = ctx.args.slice(1).join(" ") || "No reason provided.";
    if (!member) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }

    await ctx.store.addWarning(ctx.message.guild.id, member.id, {
      reason,
      moderatorId: ctx.message.author.id,
      createdAt: new Date().toISOString()
    });
    const output = `${member} was warned: ${reason}`;
    await ctx.message.reply(output);
    await sendModerationLog(ctx, output);
  }
});

define({
  name: "warnings",
  category: "Moderation",
  description: "Show warnings for a user.",
  usage: "warnings @user",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ModerateMembers)) return;
    const member = ctx.message.mentions.members.first() || ctx.message.member;
    const warnings = ctx.config.moderation.warnings?.[member.id] || [];
    if (!warnings.length) {
      const output = `${member} has no warnings.`;
      await ctx.message.reply(output);
      await sendModerationLog(ctx, output);
      return;
    }

    const output = warnings
      .map((warning, index) => `${index + 1}. ${warning.reason} by <@${warning.moderatorId}>`)
      .join("\n")
      .slice(0, 1800);
    await ctx.message.reply(output);
    await sendModerationLog(ctx, output);
  }
});

define({
  name: "clearwarnings",
  category: "Moderation",
  description: "Clear warnings for a user.",
  usage: "clearwarnings @user",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ModerateMembers)) return;
    const member = ctx.message.mentions.members.first();
    if (!member) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }

    await ctx.store.clearWarnings(ctx.message.guild.id, member.id);
    const output = `Cleared warnings for ${member}.`;
    await ctx.message.reply(output);
    await sendModerationLog(ctx, output);
  }
});

define({
  name: "timeout",
  category: "Moderation",
  description: "Timeout a user.",
  usage: "timeout @user 10m reason",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ModerateMembers)) return;
    const member = ctx.message.mentions.members.first();
    const duration = parseDuration(ctx.args[1]);
    const reason = ctx.args.slice(2).join(" ") || "No reason provided.";
    if (!member || !duration) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }

    await member.timeout(Math.min(duration, 28 * 86_400_000), reason);
    const output = `${member} timed out for ${formatDuration(duration)}. Reason: ${reason}`;
    await ctx.message.reply(output);
    await sendModerationLog(ctx, output);
  }
});

define({
  name: "untimeout",
  category: "Moderation",
  description: "Remove a timeout.",
  usage: "untimeout @user",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ModerateMembers)) return;
    const member = ctx.message.mentions.members.first();
    if (!member) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }

    await member.timeout(null);
    const output = `${member} is no longer timed out.`;
    await ctx.message.reply(output);
    await sendModerationLog(ctx, output);
  }
});

define({
  name: "kick",
  category: "Moderation",
  description: "Kick a user.",
  usage: "kick @user reason",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.KickMembers)) return;
    const member = ctx.message.mentions.members.first();
    const reason = ctx.args.slice(1).join(" ") || "No reason provided.";
    if (!member) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }

    await member.kick(reason);
    const output = `${member.user.tag} was kicked. Reason: ${reason}`;
    await ctx.message.reply(output);
    await sendModerationLog(ctx, output);
  }
});

define({
  name: "ban",
  category: "Moderation",
  description: "Ban a user.",
  usage: "ban @user reason",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.BanMembers)) return;
    const member = ctx.message.mentions.members.first();
    const reason = ctx.args.slice(1).join(" ") || "No reason provided.";
    if (!member) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }

    await member.ban({ reason });
    const output = `${member.user.tag} was banned. Reason: ${reason}`;
    await ctx.message.reply(output);
    await sendModerationLog(ctx, output);
  }
});

define({
  name: "slowmode",
  category: "Moderation",
  description: "Set channel slowmode in seconds.",
  usage: "slowmode 5",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageChannels)) return;
    const seconds = Math.min(Math.max(Number(ctx.args[0]) || 0, 0), 21_600);
    await ctx.message.channel.setRateLimitPerUser(seconds);
    const output = `Slowmode set to ${seconds}s.`;
    await ctx.message.reply(output);
    await sendModerationLog(ctx, output);
  }
});

define({
  name: "lock",
  category: "Moderation",
  description: "Lock the current channel for @everyone.",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageChannels)) return;
    await ctx.message.channel.permissionOverwrites.edit(ctx.message.guild.roles.everyone, { SendMessages: false });
    const output = "Channel locked.";
    await ctx.message.reply(output);
    await sendModerationLog(ctx, output);
  }
});

define({
  name: "unlock",
  category: "Moderation",
  description: "Unlock the current channel for @everyone.",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageChannels)) return;
    await ctx.message.channel.permissionOverwrites.edit(ctx.message.guild.roles.everyone, { SendMessages: null });
    const output = "Channel unlocked.";
    await ctx.message.reply(output);
    await sendModerationLog(ctx, output);
  }
});

define({
  name: "setprefix",
  category: "Config",
  description: "Change the command prefix.",
  usage: "setprefix !",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const prefix = ctx.args[0]?.slice(0, 5);
    if (!prefix) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }

    await ctx.store.updateGuild(ctx.message.guild.id, { prefix });
    await ctx.message.reply(`Prefix changed to \`${prefix}\`.`);
  }
});

define({
  name: "setwelcome",
  category: "Config",
  description: "Set welcome channel and message.",
  usage: "setwelcome #channel Welcome {user} to {server}!",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const channel = ctx.message.mentions.channels.first();
    const message = ctx.args.slice(1).join(" ");
    if (!channel || !message) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }

    await ctx.store.updateGuild(ctx.message.guild.id, {
      welcome: { enabled: true, channelId: channel.id, message }
    });
    await ctx.message.reply(`Welcome messages enabled in ${channel}.`);
  }
});

define({
  name: "testwelcome",
  category: "Config",
  description: "Preview the welcome message.",
  async run(ctx) {
    const text = ctx.config.welcome.message
      .replaceAll("{user}", `${ctx.message.member}`)
      .replaceAll("{username}", ctx.message.member.displayName)
      .replaceAll("{server}", ctx.message.guild.name);
    await ctx.message.reply(text);
  }
});

define({
  name: "autorole",
  category: "Config",
  description: "Set or clear the auto role.",
  usage: "autorole @role | off",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const role = mentionRole(ctx.message);
    const off = ctx.args[0]?.toLowerCase() === "off";
    if (!role && !off) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }

    await ctx.store.updateGuild(ctx.message.guild.id, { autoRoleId: off ? "" : role.id });
    await ctx.message.reply(off ? "Auto role cleared." : `Auto role set to ${role}.`);
  }
});

define({
  name: "logchannel",
  category: "Config",
  description: "Set or clear moderation log channel.",
  usage: "logchannel #channel | off",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const off = ctx.args[0]?.toLowerCase() === "off";
    const channel = ctx.message.mentions.channels.first();
    if (!channel && !off) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }

    await ctx.store.updateGuild(ctx.message.guild.id, {
      moderation: { ...ctx.config.moderation, logChannelId: off ? "" : channel.id }
    });
    await ctx.message.reply(off ? "Log channel cleared." : `Log channel set to ${channel}.`);
  }
});

define({
  name: "automod",
  category: "Config",
  description: "Turn automod on or off.",
  usage: "automod on|off",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const enabled = ctx.args[0]?.toLowerCase() === "on";
    const disabled = ctx.args[0]?.toLowerCase() === "off";
    if (!enabled && !disabled) {
      await ctx.message.reply(`Automod is currently ${ctx.config.automod.enabled ? "on" : "off"}. Use \`${usage(ctx.config, this)}\`.`);
      return;
    }

    await ctx.store.updateGuild(ctx.message.guild.id, {
      automod: { ...ctx.config.automod, enabled }
    });
    await ctx.message.reply(`Automod turned ${enabled ? "on" : "off"}.`);
  }
});

define({
  name: "blockword",
  category: "Config",
  description: "Add an automod blocked word.",
  usage: "blockword word",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const word = normalizeBlockedWord(ctx.rest);
    if (!word) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }

    const existingWords = (ctx.config.automod.blockedWords || []).map(normalizeBlockedWord).filter(Boolean);
    const blockedWords = [...new Set([...existingWords, word])];
    const alreadyBlocked = existingWords.includes(word);
    await ctx.store.updateGuild(ctx.message.guild.id, {
      automod: { ...ctx.config.automod, enabled: true, blockedWords }
    });
    await ctx.message.reply(
      alreadyBlocked
        ? `\`${word}\` was already blocked. Automod is now on.`
        : `Added blocked word: \`${word}\`. Automod is now on.`
    );
  }
});

define({
  name: "unblockword",
  category: "Config",
  description: "Remove an automod blocked word.",
  usage: "unblockword word",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const word = normalizeBlockedWord(ctx.rest);
    if (!word) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }

    const blockedWords = (ctx.config.automod.blockedWords || [])
      .map(normalizeBlockedWord)
      .filter((item) => item && item !== word);
    await ctx.store.updateGuild(ctx.message.guild.id, {
      automod: { ...ctx.config.automod, blockedWords }
    });
    await ctx.message.reply("Blocked word list updated.");
  }
});

define({
  name: "ai",
  aliases: ["chipai"],
  category: "AI",
  description: "Turn Chipkittle AI on/off or show status.",
  usage: "ai on|off|status",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const action = ctx.args[0]?.toLowerCase() || "status";
    if (action === "status") {
      await ctx.message.reply(
        `AI config: ${ctx.config.ai.enabled ? "on" : "off"} | channels: ${channelMentionList(ctx.config.ai.channelIds)} | blacklisted: ${channelMentionList(ctx.config.ai.blacklistedChannelIds || [])} | model: ${ctx.config.ai.model || ctx.defaultAiModel} | cooldown: ${ctx.config.ai.apiCooldownSeconds}s | API key: ${ctx.ai.enabled ? "present" : "missing"}`
      );
      return;
    }

    if (!["on", "off"].includes(action)) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }

    await ctx.store.updateGuild(ctx.message.guild.id, {
      ai: { ...ctx.config.ai, enabled: action === "on" }
    });
    await ctx.message.reply(`Chipkittle AI turned ${action}.`);
  }
});

define({
  name: "aichannel",
  category: "AI",
  description: "Add, remove, or list AI chat channels.",
  usage: "aichannel add #channel | remove #channel | list",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const action = ctx.args[0]?.toLowerCase() || "list";
    const channel = targetTextChannel(ctx.message);
    const channelIds = new Set(ctx.config.ai.channelIds || []);

    if (action === "list") {
      await ctx.message.reply(`AI channels: ${channelMentionList([...channelIds])}.`);
      return;
    }

    if (action === "add") channelIds.add(channel.id);
    if (action === "remove") channelIds.delete(channel.id);
    if (!["add", "remove"].includes(action)) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }

    await ctx.store.updateGuild(ctx.message.guild.id, {
      ai: { ...ctx.config.ai, channelIds: [...channelIds] }
    });
    await ctx.message.reply(`AI channel list updated: ${channelMentionList([...channelIds])}.`);
  }
});

define({
  name: "aiblacklist",
  aliases: ["aiblockchannel"],
  category: "AI",
  description: "Add, remove, or list channels where AI may not reply.",
  usage: "aiblacklist add #channel | remove #channel | list",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const action = ctx.args[0]?.toLowerCase() || "list";
    const channel = targetTextChannel(ctx.message);
    const blacklistedChannelIds = new Set(ctx.config.ai.blacklistedChannelIds || []);

    if (action === "list") {
      await ctx.message.reply(`AI blacklisted channels: ${channelMentionList([...blacklistedChannelIds])}.`);
      return;
    }

    if (action === "add") blacklistedChannelIds.add(channel.id);
    if (action === "remove") blacklistedChannelIds.delete(channel.id);
    if (!["add", "remove"].includes(action)) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }

    await ctx.store.updateGuild(ctx.message.guild.id, {
      ai: { ...ctx.config.ai, blacklistedChannelIds: [...blacklistedChannelIds] }
    });
    await ctx.message.reply(`AI blacklist updated: ${channelMentionList([...blacklistedChannelIds])}.`);
  }
});

define({
  name: "aimodel",
  category: "AI",
  description: "Set the AI model name.",
  usage: "aimodel gpt-5.2",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const model = ctx.args[0]?.trim();
    if (!model) {
      await ctx.message.reply(`Current model: ${ctx.config.ai.model || ctx.defaultAiModel}`);
      return;
    }

    await ctx.store.updateGuild(ctx.message.guild.id, {
      ai: { ...ctx.config.ai, model }
    });
    await ctx.message.reply(`AI model set to \`${model}\`.`);
  }
});

define({
  name: "airatelimit",
  aliases: ["aicooldown"],
  category: "AI",
  description: "Set the per-user AI API cooldown in seconds.",
  usage: "airatelimit 30",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const seconds = Math.min(Math.max(Number(ctx.args[0]), 0), 3600);
    if (Number.isNaN(seconds)) {
      await ctx.message.reply(`Current AI API cooldown: ${ctx.config.ai.apiCooldownSeconds}s.`);
      return;
    }

    await ctx.store.updateGuild(ctx.message.guild.id, {
      ai: { ...ctx.config.ai, apiCooldownSeconds: seconds }
    });
    await ctx.message.reply(`AI API cooldown set to ${seconds}s per user.`);
  }
});

define({
  name: "aipersonality",
  category: "AI",
  description: "Set extra AI personality guidance.",
  usage: "aipersonality be more formal",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const personality = ctx.rest.slice(0, 1200);
    if (!personality) {
      await ctx.message.reply(ctx.config.ai.personality);
      return;
    }

    await ctx.store.updateGuild(ctx.message.guild.id, {
      ai: { ...ctx.config.ai, personality }
    });
    await ctx.message.reply("AI personality updated.");
  }
});

define({
  name: "ask",
  aliases: ["chat", "chipchat"],
  category: "AI",
  description: "Ask the Chipkittle AI directly.",
  usage: "ask what does the artifact want?",
  async run(ctx) {
    const prompt = ctx.rest;
    if (!prompt) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }

    if (isAiChannelBlacklisted(ctx.config, ctx.message.channel.id)) {
      await ctx.message.reply("Chipkittle AI is blacklisted in this channel.");
      return;
    }

    const rateLimit = checkAiRateLimit({
      guildId: ctx.message.guild.id,
      userId: ctx.message.author.id,
      cooldownSeconds: ctx.config.ai.apiCooldownSeconds,
      bucket: "chat"
    });

    if (rateLimit.limited) {
      await ctx.message.reply({
        content: `The artifact is cooling down. Try again in ${rateLimit.retryAfterSeconds}s.`,
        allowedMentions: NO_MENTIONS
      });
      return;
    }

    await ctx.message.channel.sendTyping();
    const reply = await ctx.ai.reply(ctx.message, ctx.config, prompt);
    await ctx.message.reply({ content: reply, allowedMentions: NO_MENTIONS });
  }
});

define({
  name: "thetruth",
  category: "Fun",
  description: "Reveal the truth about a user.",
  async run(ctx) {
    await ctx.message.reply("<@203025242753335296> is a PEDO");
  }
});

define({
  name: "apply",
  aliases: ["application", "ticket"],
  category: "Applications",
  description: "Open a private Chipkittle membership application thread.",
  async run(ctx) {
    await deleteCommandMessage(ctx.message);

    const settings = ctx.config.applications;
    const embedMeta = commandEmbedMeta({ command: ctx.command, config: ctx.config, message: ctx.message });
    if (isBlockedFromApplying(ctx.message.member, ctx.config) && !isApplicationStaff(ctx)) {
      return;
    }

    if (!settings.enabled) {
      await sendApplicationNotice(ctx, "Applications are not enabled right now.");
      return;
    }

    if (settings.channelId && ctx.message.channel.id !== settings.channelId) {
      await sendApplicationNotice(ctx, `Please start applications in #${ctx.message.guild.channels.cache.get(settings.channelId)?.name || "the application channel"}.`);
      return;
    }

    const cooldown = applicationCooldownStatus(ctx.config, ctx.message.author.id);
    if (cooldown.limited) {
      await sendApplicationNotice(ctx, `You can open another application in ${formatCooldown(cooldown.remainingMs)}.`);
      return;
    }

    const existing = await findOpenApplicationChannel(ctx.message.guild, ctx.message.author.id, ctx.config, ctx.client);
    if (existing) {
      await sendApplicationNotice(ctx, "You already have an open application. Staff will review it in the application thread.");
      return;
    }

    const botMember = ctx.message.guild.members.me;
    const reviewChannelId = settings.threadChannelId || settings.channelId;
    const parentChannel = reviewChannelId
      ? ctx.message.guild.channels.cache.get(reviewChannelId)
      : ctx.message.channel;

    if (!parentChannel?.threads?.create || parentChannel.type !== ChannelType.GuildText) {
      await sendApplicationNotice(ctx, "The review thread channel must be a normal text channel that supports private threads. Staff can fix this in the panel under Membership Applications.");
      console.warn(`[applications] Invalid review thread channel for guild ${ctx.message.guild.id}: ${reviewChannelId || "current channel"}`);
      return;
    }

    const parentPermissions = botMember?.permissionsIn(parentChannel);
    if (
      !parentPermissions?.has(PermissionsBitField.Flags.CreatePrivateThreads) ||
      !parentPermissions?.has(PermissionsBitField.Flags.ManageThreads) ||
      !parentPermissions?.has(PermissionsBitField.Flags.SendMessagesInThreads)
    ) {
      await sendApplicationNotice(ctx, "I need Create Private Threads, Manage Threads, and Send Messages in Threads in the review thread channel. Staff can fix my channel permissions and try again.");
      console.warn(`[applications] Missing thread permissions in ${parentChannel.id} for guild ${ctx.message.guild.id}`);
      return;
    }

    const questions = applicationQuestions(ctx.config);
    if (!questions.length) {
      await sendApplicationNotice(ctx, "No application questions are configured yet.");
      return;
    }

    const dmChannel = await ctx.message.author.createDM().catch(() => null);
    if (!dmChannel) {
      await sendApplicationNotice(ctx, "I could not open a DM with you. Please enable DMs from this server and try again.");
      return;
    }

    const reviewerRoleIds = settings.reviewerRoleIds || [];
    const thread = await parentChannel.threads.create({
      name: ticketNameFor(ctx.message.member),
      type: ChannelType.PrivateThread,
      invitable: false,
      autoArchiveDuration: 1440,
      reason: `Application for ${ctx.message.author.tag}`
    }).catch(async (error) => {
      console.error("Application thread creation failed:", error);
      await sendApplicationNotice(ctx, "I could not create your application thread. Staff should check my thread permissions in the configured review channel.");
      return null;
    });
    if (!thread) return;

    await saveApplicationTicket(ctx.store, ctx.message.guild.id, ctx.message.author.id, {
      channelId: thread.id,
      questionIndex: 0,
      completed: false
    });

    const questionList = questions.map((question, index) => `${index + 1}. ${question}`).join("\n");
    const reviewerMentions = reviewerRoleIds.map((roleId) => `<@&${roleId}>`).join(" ");

    await sendEmbedPayload(thread, {
      content: [
        `Application thread opened for ${ctx.message.author} (${ctx.message.author.tag}).`,
        reviewerMentions ? `Review team: ${reviewerMentions}` : "",
        "",
        "Applicant answers will appear here as they reply to the bot in DMs.",
        "Staff messages in this channel stay private unless sent with the reply command.",
        "",
        "Questions:",
        questionList,
        "",
        `Use \`${ctx.config.prefix}reply message\` to DM the applicant, \`${ctx.config.prefix}approve\` to approve, \`${ctx.config.prefix}deny reason\` to deny, or \`${ctx.config.prefix}closeapplication\` to close.`
      ].filter(Boolean).join("\n"),
      allowedMentions: { users: [], roles: reviewerRoleIds }
    }, embedMeta);

    const dmStarted = await sendEmbedPayload(dmChannel, [
      `Your Chipkittle application has started for **${ctx.message.guild.name}**.`,
      "Answer each question here in DMs. Staff can read your answers in the private review thread.",
      "",
      `Question 1/${questions.length}: ${questions[0]}`
    ].join("\n"), embedMeta).then(() => true).catch(() => false);

    if (!dmStarted) {
      await clearApplicationTicket(ctx.store, ctx.message.guild.id, ctx.message.author.id);
      await thread.setLocked(true, "Applicant DMs were closed").catch(() => {});
      await thread.setArchived(true, "Applicant DMs were closed").catch(() => {});
      await sendApplicationNotice(ctx, "I could not DM you. Please enable DMs from this server and try again.");
      return;
    }

    await saveApplicationCooldown(ctx.store, ctx.message.guild.id, ctx.message.author.id);
  }
});

define({
  name: "reply",
  aliases: ["ticketreply"],
  category: "Applications",
  description: "Send a staff reply from an application thread to the applicant's DMs.",
  usage: "reply message",
  async run(ctx) {
    await deleteCommandMessage(ctx.message);

    if (!isApplicationStaff(ctx)) {
      return;
    }

    const applicantId = applicantIdFromChannel(ctx.message.channel, ctx.config);
    if (!applicantId) {
      await ctx.message.channel.send("This does not look like an application thread.").catch(() => {});
      return;
    }

    const text = ctx.rest.trim();
    if (!text) {
      await ctx.message.channel.send(`Usage: \`${usage(ctx.config, this)}\``).catch(() => {});
      return;
    }

    const user = await ctx.client.users.fetch(applicantId).catch(() => null);
    if (!user) {
      await ctx.message.channel.send("I could not find that applicant.").catch(() => {});
      return;
    }

    const sent = await sendEmbedPayload(
      user,
      `**${ctx.message.guild.name} staff:** ${text}`,
      commandEmbedMeta({ command: ctx.command, config: ctx.config, message: ctx.message })
    ).then(() => true).catch(() => false);
    if (!sent) {
      await ctx.message.channel.send("I could not DM that applicant. Their DMs may be closed.").catch(() => {});
      return;
    }

    await ctx.message.channel.send({
      content: `Sent to applicant by ${ctx.message.member.displayName}:\n> ${text.slice(0, 1800)}`,
      allowedMentions: NO_MENTIONS
    });
  }
});

define({
  name: "approve",
  aliases: ["approveapplication"],
  category: "Applications",
  description: "Approve an application and assign the configured membership role.",
  usage: "approve [@user]",
  async run(ctx) {
    await deleteCommandMessage(ctx.message);

    if (!isApplicationStaff(ctx)) {
      return;
    }

    const mentionedApplicant = ctx.message.mentions.members.first();
    const applicantId = mentionedApplicant?.id || applicantIdFromChannel(ctx.message.channel, ctx.config);
    if (!applicantId) {
      await ctx.message.channel.send(`Usage: \`${usage(ctx.config, this)}\` inside an application thread, or mention a user.`).catch(() => {});
      return;
    }

    const member = await ctx.message.guild.members.fetch(applicantId).catch(() => null);
    if (!member) {
      await ctx.message.channel.send("I could not find that applicant in this server.").catch(() => {});
      return;
    }

    const dmSent = await sendEmbedPayload(
      member,
      `Your application to **${ctx.message.guild.name}** was accepted.`,
      commandEmbedMeta({ command: ctx.command, config: ctx.config, message: ctx.message })
    ).then(() => true).catch(() => false);

    if (ctx.config.applications.approvedRoleId) {
      await member.roles.add(ctx.config.applications.approvedRoleId).catch(() => null);
      await ctx.message.channel.send({
        content: `${member} was approved and received <@&${ctx.config.applications.approvedRoleId}>.${dmSent ? "" : " I could not DM them."}`,
        allowedMentions: { users: [member.id], roles: [] }
      });
    } else {
      await ctx.message.channel.send(`${member} was approved.${dmSent ? "" : " I could not DM them."} Set an approved membership role in the panel to assign full access automatically.`);
    }

    await clearApplicationTicket(ctx.store, ctx.message.guild.id, applicantId);
    closeThreadLater(ctx.client, ctx.message.channelId, "Application accepted", 10_000);
  }
});

define({
  name: "deny",
  aliases: ["denyapplication"],
  category: "Applications",
  description: "Deny an application and message the applicant.",
  usage: "deny [reason]",
  async run(ctx) {
    await deleteCommandMessage(ctx.message);

    if (!isApplicationStaff(ctx)) {
      return;
    }

    const mentionedApplicant = ctx.message.mentions.members.first();
    const applicantId = mentionedApplicant?.id || applicantIdFromChannel(ctx.message.channel, ctx.config);
    if (!applicantId) {
      await ctx.message.channel.send(`Usage: \`${usage(ctx.config, this)}\` inside an application thread, or mention a user.`).catch(() => {});
      return;
    }

    const user = await ctx.client.users.fetch(applicantId).catch(() => null);
    if (!user) {
      await ctx.message.channel.send("I could not find that applicant.").catch(() => {});
      return;
    }

    const reason = (mentionedApplicant ? ctx.args.slice(1).join(" ") : ctx.rest).trim();
    const dmText = reason
      ? `Your application to **${ctx.message.guild.name}** was denied.\nReason: ${reason}`
      : `Your application to **${ctx.message.guild.name}** was denied.`;
    const dmSent = await sendEmbedPayload(
      user,
      dmText,
      commandEmbedMeta({ command: ctx.command, config: ctx.config, message: ctx.message })
    ).then(() => true).catch(() => false);

    await ctx.message.channel.send({
      content: `Application denied for <@${applicantId}>${reason ? `: ${reason}` : "."}${dmSent ? "" : " I could not DM them."}`,
      allowedMentions: NO_MENTIONS
    });
    await clearApplicationTicket(ctx.store, ctx.message.guild.id, applicantId);
    closeThreadLater(ctx.client, ctx.message.channelId, "Application denied", 10_000);
  }
});

define({
  name: "closeapplication",
  aliases: ["closeticket", "close"],
  category: "Applications",
  description: "Close and lock the current application thread.",
  async run(ctx) {
    await deleteCommandMessage(ctx.message);

    if (!isApplicationStaff(ctx)) {
      return;
    }

    const applicantId = applicantIdFromChannel(ctx.message.channel, ctx.config);
    if (!applicantId) {
      await ctx.message.channel.send("This does not look like an application thread.").catch(() => {});
      return;
    }

    await ctx.message.channel.send("Closing and locking this application thread in 5 seconds.").catch(() => {});
    closeThreadLater(ctx.client, ctx.message.channelId, "Application thread closed", 5000);
    await clearApplicationTicket(ctx.store, ctx.message.guild.id, applicantId);
  }
});

export function createCommandHandler(options) {
  const aliases = new Map();
  for (const command of commandDefinitions) {
    aliases.set(command.name, command);
    for (const alias of command.aliases || []) {
      aliases.set(alias, command);
    }
  }

  async function runCommand(command, message, config, args, rest) {
    const commandMessage = PLAIN_OUTPUT_COMMANDS.has(command.name)
      ? message
      : createEmbedMessageProxy(message, commandEmbedMeta({ command, config, message }));

    try {
      await command.run({
        ...options,
        message: commandMessage,
        config,
        args,
        rest,
        command,
        commands: aliases,
        commandList: commandDefinitions
      });
    } catch (error) {
      console.error(`Command ${command.name} failed:`, error);
      const fallbackPayload = toEmbedPayload(
        "That command failed. Check my permissions and try again.",
        commandEmbedMeta({ command, config, message })
      );
      await commandMessage.reply(fallbackPayload)
        .catch(() => message.channel.send(fallbackPayload).catch(() => {}));
    }

    return true;
  }

  async function handleCommand(message, config) {
    if (!message.content.startsWith(config.prefix)) return false;

    const { commandName, args, rest } = splitArgs(message.content, config.prefix);
    const command = aliases.get(commandName);
    if (!command) return false;

    return runCommand(command, message, config, args, rest);
  }

  async function handleCommandByName(commandName, message, config, input = "") {
    const command = aliases.get(commandName);
    if (!command) return false;

    const parts = input ? input.split(/\s+/) : [];
    return runCommand(command, message, config, parts, input);
  }

  return {
    handleCommand,
    handleCommandByName,
    commandList: commandDefinitions
  };
}

