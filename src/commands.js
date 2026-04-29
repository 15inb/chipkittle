import fs from "node:fs";
import path from "node:path";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionsBitField,
  StringSelectMenuBuilder
} from "discord.js";
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
  randomChipkittleQuote,
  randomChipkittleName
} from "./chipkittleLore.js";
import { NO_MENTIONS, neutralizeMentions } from "./discordSafety.js";
import { redeemDashClaim } from "./dashClaims.js";
import {
  addArtifact,
  addAuditLog,
  artifactOfTheDay,
  communityState,
  communitySnapshot,
  derivedAchievements,
  incrementMetric,
  profileFor,
  purchaseShopItem,
  recordCommandUsage,
  shopCatalog,
  topCommands,
  updateProfile
} from "./communityFeatures.js";
import {
  buildPrettyEmbed,
  commandEmbedMeta,
  createEmbedMessageProxy,
  sendEmbedPayload,
  toEmbedPayload
} from "./embedOutput.js";
import {
  canGrantPanelAccess,
  hashPanelPassword,
  normalizePanelAccessLevel,
  panelAccessAtLeast,
  panelAccessLabel,
  panelAccessRank,
  panelAccessUsers,
  randomPanelPassword
} from "./panelAccess.js";
import {
  captionMedia,
  convertToGif,
  gifBoomerang,
  gifResize,
  gifReverse,
  gifSpeed,
  gifWiggle
} from "./mediaEditing.js";

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
const GIF_CONTENT_TYPES = new Set(["image/gif"]);
const MEDIA_CONTENT_TYPES = new Set([...IMAGE_CONTENT_TYPES, ...GIF_CONTENT_TYPES]);
const MAX_CHIPIFY_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const PLAIN_OUTPUT_COMMANDS = new Set(["ask", "chipify", "gif", "caption"]);
const MAX_REMINDER_TIMEOUT_MS = 2_147_000_000;
const PROFILE_BIO_MAX = 220;

const pendingDateRequests = new Map();

const BUILT_IN_BLOCKED_SUGGESTION_TERMS = [
  "fuck",
  "shit",
  "bitch",
  "asshole",
  "bastard",
  "cunt",
  "dick",
  "pussy",
  "fag",
  "faggot",
  "nigger",
  "nigga",
  "kike",
  "spic",
  "chink",
  "gook",
  "retard"
];
const currentDates = new Map();
const PUBLIC_GAME_IDS = ["dash", "runner", "mines", "catch"];

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

const HELP_COMMANDS_PER_PAGE = 7;
const HELP_CATEGORIES_PER_PAGE = 8;
const HELP_CATEGORY_ORDER = [
  "General",
  "Info",
  "Utility",
  "Games",
  "Gambling",
  "Chipkittle",
  "AI",
  "Applications",
  "Moderation",
  "Config",
  "Fun",
  "Dating"
];

function commandCategoryMap(commandList) {
  const byCategory = new Map();
  for (const item of commandList) {
    const category = item.category || "Other";
    byCategory.set(category, [...(byCategory.get(category) || []), item]);
  }
  for (const [category, commands] of byCategory.entries()) {
    byCategory.set(category, [...commands].sort((a, b) => a.name.localeCompare(b.name)));
  }
  return new Map(
    [...byCategory.entries()].sort((a, b) => {
      const leftIndex = HELP_CATEGORY_ORDER.indexOf(a[0]);
      const rightIndex = HELP_CATEGORY_ORDER.indexOf(b[0]);
      const leftRank = leftIndex === -1 ? HELP_CATEGORY_ORDER.length : leftIndex;
      const rightRank = rightIndex === -1 ? HELP_CATEGORY_ORDER.length : rightIndex;
      return leftRank - rightRank || a[0].localeCompare(b[0]);
    })
  );
}

function chunkItems(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function helpCustomId(messageId, action) {
  return `help:${messageId}:${action}`;
}

function formatHelpCommand(config, command) {
  const aliases = command.aliases?.length ? ` • aliases: ${command.aliases.join(", ")}` : "";
  return `\`${config.prefix}${command.name}\` — ${command.description || "No description."}${aliases}`;
}

function helpNormalized(value = "") {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function helpSortedCategories(byCategory) {
  return [...byCategory.entries()];
}

function helpCategoryChunks(byCategory) {
  return chunkItems(helpSortedCategories(byCategory), HELP_CATEGORIES_PER_PAGE);
}

function resolveHelpTarget(commandList, rawTarget = "") {
  const normalized = helpNormalized(rawTarget);
  if (!normalized) return { type: "overview" };

  const command = commandList.find((entry) =>
    helpNormalized(entry.name) === normalized ||
    (entry.aliases || []).some((alias) => helpNormalized(alias) === normalized)
  );
  if (command) return { type: "command", command };

  const category = [...new Set(commandList.map((entry) => entry.category || "Other"))]
    .find((entry) => helpNormalized(entry) === normalized);
  if (category) return { type: "category", category };

  return null;
}

function helpDetailEmbed(ctx, command) {
  const aliases = command.aliases?.length ? command.aliases.join(", ") : "None";
  return buildPrettyEmbed({
    title: `Help: ${ctx.config.prefix}${command.name}`,
    description: [
      command.description || "No description.",
      "",
      `**Category:** ${command.category || "Other"}`,
      `**Usage:** \`${usage(ctx.config, command)}\``,
      `**Aliases:** ${aliases}`,
      "",
      "Tip: you can also run this as a slash command by typing `/` in Discord."
    ].join("\n"),
    color: 0x65d6ad,
    footer: `Requested by ${ctx.message.author.tag}`
  });
}

function helpOverviewEmbed(ctx, byCategory, overviewPage = 0) {
  const categoryPages = helpCategoryChunks(byCategory);
  const pageItems = categoryPages[overviewPage] || categoryPages[0] || [];
  const totalCommands = ctx.commandList.length;
  const categoryLines = pageItems
    .map(([category, items]) => `**${category}** — ${items.length} command${items.length === 1 ? "" : "s"}`)
    .join("\n");

  return buildPrettyEmbed({
    title: "Chipkittle Help",
    description: [
      `This bot currently has **${totalCommands}** commands across **${byCategory.size}** categories.`,
      `Prefix commands use \`${ctx.config.prefix}\` and most also work as slash commands.`,
      "",
      categoryLines || "No command categories found.",
      "",
      `Use \`${ctx.config.prefix}help command\` for one command, or pick a category below.`
    ].join("\n"),
    color: 0x65d6ad,
    footer: `Category page ${overviewPage + 1}/${Math.max(categoryPages.length, 1)} • Requested by ${ctx.message.author.tag}`
  });
}

function helpCategoryEmbed(ctx, category, commands, page) {
  const pages = chunkItems(commands, HELP_COMMANDS_PER_PAGE);
  const pageItems = pages[page] || pages[0] || [];
  const commandLines = pageItems.map((command) => formatHelpCommand(ctx.config, command)).join("\n");

  return buildPrettyEmbed({
    title: `${category} Commands`,
    description: [
      `Showing **${pageItems.length}** of **${commands.length}** command${commands.length === 1 ? "" : "s"}.`,
      "",
      commandLines || "No commands in this category.",
      "",
      "Use the command picker below to open details for one command."
    ].join("\n"),
    color: 0x65d6ad,
    footer: `Page ${page + 1}/${Math.max(pages.length, 1)} • Requested by ${ctx.message.author.tag}`
  });
}

function helpRenderEmbed(ctx, byCategory, state) {
  if (state.view === "command" && state.command) return helpDetailEmbed(ctx, state.command);
  if (state.view === "category" && state.category) {
    return helpCategoryEmbed(ctx, state.category, byCategory.get(state.category) || [], state.categoryPage || 0);
  }
  return helpOverviewEmbed(ctx, byCategory, state.overviewPage || 0);
}

function helpComponents(ctx, byCategory, state, disabled = false) {
  const categoryOptions = helpSortedCategories(byCategory)
    .slice(0, 25)
    .map(([category, commands]) => ({
      label: category,
      value: category,
      description: `${commands.length} command${commands.length === 1 ? "" : "s"}`,
      default: category === state.category
    }));

  const rows = [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(helpCustomId(ctx.message.id, "category"))
        .setPlaceholder("Choose a command category")
        .setDisabled(disabled)
        .addOptions(categoryOptions)
    )
  ];

  const categoryPages = helpCategoryChunks(byCategory);
  const categoryCommands = state.category ? byCategory.get(state.category) || [] : [];
  const commandPages = chunkItems(categoryCommands, HELP_COMMANDS_PER_PAGE);
  const activePageCount = state.view === "overview"
    ? Math.max(categoryPages.length, 1)
    : Math.max(commandPages.length, 1);
  const activePage = state.view === "overview" ? (state.overviewPage || 0) : (state.categoryPage || 0);

  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(helpCustomId(ctx.message.id, "home"))
        .setLabel("Overview")
        .setStyle(state.view === "overview" ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(helpCustomId(ctx.message.id, "back"))
        .setLabel("Back")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || (state.view === "overview" && !state.category)),
      new ButtonBuilder()
        .setCustomId(helpCustomId(ctx.message.id, "prev"))
        .setLabel("Previous")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || activePage <= 0),
      new ButtonBuilder()
        .setCustomId(helpCustomId(ctx.message.id, "next"))
        .setLabel("Next")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || activePage >= activePageCount - 1)
    )
  );

  if (state.category && categoryCommands.length) {
    const pageCommands = commandPages[state.categoryPage || 0] || commandPages[0] || [];
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(helpCustomId(ctx.message.id, "command"))
          .setPlaceholder("Open help for a command in this category")
          .setDisabled(disabled)
          .addOptions(
            pageCommands.map((command) => ({
              label: `${ctx.config.prefix}${command.name}`.slice(0, 100),
              value: command.name,
              description: String(command.description || "No description.").slice(0, 100),
              default: state.command?.name === command.name
            }))
          )
      )
    );
  }

  return rows;
}

function mentionUser(message) {
  return message.mentions.members.first() || message.member;
}

function mentionRole(message) {
  return message.mentions.roles.first();
}

function mentionTargetUser(message) {
  return message.mentions.members.first() || message.member;
}

function cleanText(value = "", maxLength = 120) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizeSuggestionModerationText(value = "") {
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

function blockedSuggestionTerm(value = "", config = {}) {
  const normalized = normalizeSuggestionModerationText(value);
  if (!normalized) return "";
  const configuredTerms = Array.isArray(config.publicSite?.games?.blockedLeaderboardWords)
    ? config.publicSite.games.blockedLeaderboardWords
    : [];
  const blockedTerms = [...BUILT_IN_BLOCKED_SUGGESTION_TERMS, ...configuredTerms];
  return blockedTerms.find((term) => normalized.includes(normalizeSuggestionModerationText(term))) || "";
}

function splitPipe(text = "") {
  return String(text || "").split("|").map((part) => part.trim());
}

function formatInventory(profile) {
  const entries = Object.entries(profile.inventory || {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([itemId, amount]) => {
      const item = shopCatalog().find((entry) => entry.id === itemId);
      return `• ${item?.name || itemId} x${amount}`;
    });
  return entries.length ? entries.join("\n") : "No items yet.";
}

function formatAchievementLines(achievements = []) {
  return achievements.length
    ? achievements.map((achievement) => `• ${achievement}`).join("\n")
    : "No achievements yet.";
}

function formatVouchLines(profile) {
  return profile.vouches.length
    ? profile.vouches.slice(0, 5).map((entry) => `• ${entry.name || "Unknown"}: ${entry.reason || "Trusted by the artifact."}`).join("\n")
    : "No vouches yet.";
}

function dailyQuestFor(userId = "") {
  return questFor({}, userId, "daily").detail;
}

function weeklyQuestFor(userId = "") {
  return questFor({}, userId, "weekly").detail;
}

function stableIndex(seed = "", length = 1) {
  return Math.abs(String(seed).split("").reduce((sum, char) => sum + char.charCodeAt(0), 0)) % Math.max(length, 1);
}

function currentQuestPeriods() {
  const today = new Date();
  const day = today.toISOString().slice(0, 10);
  const firstDay = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
  const week = `${today.getUTCFullYear()}-W${Math.floor((Date.now() - firstDay.getTime()) / (7 * 86_400_000))}`;
  return { day, week };
}

const DAILY_QUESTS = [
  {
    id: "daily-claim",
    title: "Collect the Daily Loaf",
    detail: "Use your daily bread claim today.",
    target: 1,
    progress(config, userId) {
      return String(config.economy?.dailyClaims?.[userId] || "").startsWith(currentQuestPeriods().day) ? 1 : 0;
    }
  },
  {
    id: "daily-bank",
    title: "Bank Something Before It Gets Weird",
    detail: "Have at least 500 bread in the bank.",
    target: 500,
    progress(config, userId) {
      return bankBalance(normalizeEconomy(config.economy || {}), userId);
    }
  },
  {
    id: "daily-profile",
    title: "Polish the Public Mask",
    detail: "Have a visible profile with a bio, title, and favorite artifact.",
    target: 3,
    progress(config, userId) {
      const profile = profileFor(config, userId);
      return [profile.publicVisible, profile.bio && !profile.bio.startsWith("No ceremonial"), profile.title, profile.favoriteArtifact].filter(Boolean).length;
    }
  },
  {
    id: "daily-inventory",
    title: "Carry a Suspicious Object",
    detail: "Own at least one shop item.",
    target: 1,
    progress(config, userId) {
      return Object.keys(profileFor(config, userId).inventory || {}).length;
    }
  },
  {
    id: "daily-bread",
    title: "Do Not Be Breadless",
    detail: "Keep at least 1,000 bread total between wallet and bank.",
    target: 1000,
    progress(config, userId) {
      return totalBreadWealth(normalizeEconomy(config.economy || {}), userId);
    }
  }
];

const WEEKLY_QUESTS = [
  {
    id: "weekly-games",
    title: "Survive the Casino Fog",
    detail: "Play 10 tracked gambling games.",
    target: 10,
    progress(config, userId) {
      return Math.max(Number(config.economy?.stats?.[userId]?.gamesPlayed) || 0, 0);
    }
  },
  {
    id: "weekly-vouches",
    title: "Earn the Den's Suspicious Trust",
    detail: "Receive 2 vouches.",
    target: 2,
    progress(config, userId) {
      return profileFor(config, userId).vouches.length;
    }
  },
  {
    id: "weekly-collector",
    title: "Pocket the Little Relics",
    detail: "Own 3 different shop items.",
    target: 3,
    progress(config, userId) {
      return Object.keys(profileFor(config, userId).inventory || {}).length;
    }
  },
  {
    id: "weekly-vault",
    title: "Become Harder to Mug",
    detail: "Reach 5,000 total bread wealth.",
    target: 5000,
    progress(config, userId) {
      return totalBreadWealth(normalizeEconomy(config.economy || {}), userId);
    }
  },
  {
    id: "weekly-upgrades",
    title: "Improve the Bread Machine",
    detail: "Own 3 total economy upgrade levels.",
    target: 3,
    progress(config, userId) {
      return Object.values(config.economy?.upgrades?.[userId] || {}).reduce((sum, level) => sum + Math.max(Number(level) || 0, 0), 0);
    }
  }
];

function questFor(config = {}, userId = "", type = "daily") {
  const periods = currentQuestPeriods();
  const quests = type === "weekly" ? WEEKLY_QUESTS : DAILY_QUESTS;
  const period = type === "weekly" ? periods.week : periods.day;
  const quest = quests[stableIndex(`${period}:${userId}`, quests.length)];
  const progress = Math.min(Math.max(Math.floor(Number(quest.progress(config, userId)) || 0), 0), quest.target);
  const claimed = Boolean(config.community?.questClaims?.[userId]?.[questClaimKey({ ...quest, type, period })]);
  return { ...quest, type, period, progress, complete: progress >= quest.target, claimed };
}

function formatQuest(quest) {
  const status = quest.claimed ? "claimed" : quest.complete ? "ready to claim" : `${quest.progress}/${quest.target}`;
  return `**${quest.title}** (${status})\n${quest.detail}`;
}

function questClaimKey(quest) {
  return `${quest.type}:${quest.period}:${quest.id}`;
}

async function markQuestClaims(ctx, userId, quests = []) {
  const today = currentQuestPeriods().day;
  const existingStreak = ctx.config.community?.questStreaks?.[userId] || {};
  const previousDaily = String(existingStreak.lastDailyClaimedAt || "");
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const claimedDaily = quests.some((quest) => quest.type === "daily");
  const dailyStreak = claimedDaily
    ? previousDaily === yesterday
      ? Math.max(Number(existingStreak.daily) || 0, 0) + 1
      : previousDaily === today
        ? Math.max(Number(existingStreak.daily) || 0, 0)
        : 1
    : Math.max(Number(existingStreak.daily) || 0, 0);
  const bestDaily = Math.max(Math.max(Number(existingStreak.bestDaily) || 0, 0), dailyStreak);
  const claimEntries = Object.fromEntries(
    quests.map((quest) => [
      questClaimKey(quest),
      {
        title: quest.title,
        reward: quest.reward,
        claimedAt: new Date().toISOString()
      }
    ])
  );

  await ctx.store.updateGuild(ctx.message.guild.id, {
    community: {
      questClaims: {
        ...(ctx.config.community?.questClaims || {}),
        [userId]: {
          ...(ctx.config.community?.questClaims?.[userId] || {}),
          ...claimEntries
        }
      },
      questStreaks: {
        ...(ctx.config.community?.questStreaks || {}),
        [userId]: {
          ...existingStreak,
          daily: dailyStreak,
          bestDaily,
          lastDailyClaimedAt: claimedDaily ? today : existingStreak.lastDailyClaimedAt || ""
        }
      }
    }
  });
  return { daily: dailyStreak, bestDaily };
}

function profileEmbedFor(ctx, member) {
  const profile = profileFor(ctx.config, member.id, member.displayName);
  const achievements = derivedAchievements(ctx.config, member.id, member.displayName);
  const balance = Number(ctx.config.economy?.balances?.[member.id] || 0);
  const artifactList = profile.artifacts.length ? profile.artifacts.slice(0, 4).map((artifact) => `• ${artifact}`).join("\n") : "No artifacts claimed.";

  return buildPrettyEmbed({
    title: `${member.displayName}'s Profile`,
    description: [
      `**Title:** ${profile.title}`,
      `**Bread:** ${balance}`,
      `**Reputation:** ${profile.reputation}`,
      `**Bio:** ${profile.bio}`,
      "",
      `**Badges**\n${profile.badges.length ? profile.badges.map((badge) => `• ${badge}`).join("\n") : "No badges yet."}`,
      "",
      `**Achievements**\n${formatAchievementLines(achievements)}`,
      "",
      `**Artifacts**\n${artifactList}`,
      "",
      `**Recent Vouches**\n${formatVouchLines(profile)}`
    ].join("\n"),
    color: 0x22c55e,
    footer: `Requested by ${ctx.message.author.tag}`
  });
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

function hasAdministratorBypass(member) {
  return Boolean(member?.permissions?.has?.(PermissionsBitField.Flags.Administrator));
}

function isCommandDisabled(config, commandName) {
  return Boolean(config.commandRoles?.disabled?.[commandName]);
}

function isCategoryDisabled(config, categoryName) {
  return Boolean(config.commandRoles?.disabledCategories?.[categoryName || "Other"]);
}

function commandAllowedChannelIds(config, commandName) {
  const channelIds = config.commandRoles?.channelAllowlist?.[commandName];
  return Array.isArray(channelIds) ? channelIds.map(String).filter(Boolean) : [];
}

function messageChannelKeys(message) {
  const keys = [];
  const directId = String(message.channelId || message.channel?.id || "");
  const parentId = String(message.channel?.parentId || "");
  if (directId) keys.push(directId);
  if (parentId && parentId !== directId) keys.push(parentId);
  return keys;
}

function commandChannelAllowed(message, allowedChannelIds = []) {
  if (!message.guild || !allowedChannelIds.length) return true;
  const allowedSet = new Set(allowedChannelIds);
  return messageChannelKeys(message).some((channelId) => allowedSet.has(channelId));
}

function channelCommandRestrictions(config, message) {
  if (!message.guild) return { commands: [], categories: [] };
  const channelKeys = messageChannelKeys(message);
  const allowedCommandsByChannel = config.commandRoles?.channelCommandAllowlist || {};
  const allowedCategoriesByChannel = config.commandRoles?.channelCategoryAllowlist || {};
  const commands = [];
  const categories = [];

  for (const channelId of channelKeys) {
    commands.push(...(Array.isArray(allowedCommandsByChannel[channelId]) ? allowedCommandsByChannel[channelId] : []));
    categories.push(...(Array.isArray(allowedCategoriesByChannel[channelId]) ? allowedCategoriesByChannel[channelId] : []));
  }

  return {
    commands: [...new Set(commands.map(String).filter(Boolean))],
    categories: [...new Set(categories.map(String).filter(Boolean))]
  };
}

function commandRestrictionMessage(command, message, config) {
  if (hasAdministratorBypass(message.member)) {
    return "";
  }

  if (isCategoryDisabled(config, command.category || "Other")) {
    return `The ${command.category || "Other"} category is currently disabled in this server.`;
  }

  if (isCommandDisabled(config, command.name)) {
    return "That command is currently disabled in this server.";
  }

  const allowedChannelIds = commandAllowedChannelIds(config, command.name);
  if (!commandChannelAllowed(message, allowedChannelIds)) {
    return `That command can only be used in ${allowedChannelIds.map((channelId) => `<#${channelId}>`).join(", ")}.`;
  }

  const channelRestrictions = channelCommandRestrictions(config, message);
  if (channelRestrictions.commands.length || channelRestrictions.categories.length) {
    const commandAllowed = channelRestrictions.commands.includes(command.name);
    const categoryAllowed = channelRestrictions.categories.includes(command.category || "Other");
    if (!commandAllowed && !categoryAllowed) {
      const parts = [];
      if (channelRestrictions.commands.length) {
        parts.push(`commands: ${channelRestrictions.commands.map((name) => `\`${config.prefix}${name}\``).join(", ")}`);
      }
      if (channelRestrictions.categories.length) {
        parts.push(`categories: ${channelRestrictions.categories.join(", ")}`);
      }
      return `That command is not allowed in this channel. Allowed here: ${parts.join(" | ")}.`;
    }
  }

  return "";
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

function requirePanelRoot(ctx) {
  const user = ctx.config.panelAccess?.users?.[ctx.message.author.id];
  if (user && !user.revokedAt && normalizePanelAccessLevel(user.level) === "root") {
    return true;
  }
  ctx.message.reply("Only root panel users can use that command.");
  return false;
}

function botModerationPermissionMessage(action, permissionName) {
  return `I cannot ${action} that member. Make sure my bot role is above their highest role and I have ${permissionName}.`;
}

async function canModerateTarget(ctx, member, action, botCapability, permissionName) {
  if (member.id === ctx.message.author.id) {
    await ctx.message.reply(`You cannot ${action} yourself.`);
    return false;
  }

  if (member.id === ctx.client.user.id) {
    await ctx.message.reply(`I cannot ${action} myself.`);
    return false;
  }

  if (member.id === ctx.message.guild.ownerId) {
    await ctx.message.reply(`I cannot ${action} the server owner.`);
    return false;
  }

  if (ctx.message.author.id !== ctx.message.guild.ownerId) {
    const actorRole = ctx.message.member?.roles.highest;
    const targetRole = member.roles.highest;
    if (actorRole && targetRole && targetRole.position >= actorRole.position) {
      await ctx.message.reply(`You cannot ${action} a member with an equal or higher role.`);
      return false;
    }
  }

  if (!member[botCapability]) {
    await ctx.message.reply(botModerationPermissionMessage(action, permissionName));
    return false;
  }

  return true;
}

async function runModerationAction(ctx, member, action, callback, permissionName) {
  try {
    await callback();
    return true;
  } catch (error) {
    if (error?.code === 50013) {
      await ctx.message.reply(botModerationPermissionMessage(action, permissionName));
      return false;
    }
    throw error;
  }
}

function isAiChannelBlacklisted(config, channelId) {
  return (config.ai.blacklistedChannelIds || []).includes(channelId);
}

function aiAllowedForMember(config, member) {
  const allowedRoleIds = config.ai.allowedRoleIds || [];
  if (!allowedRoleIds.length) return true;
  return allowedRoleIds.some((roleId) => member?.roles?.cache?.has(roleId));
}

function aiMonthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

function aiUsageState(config) {
  const usage = config.ai?.usage || {};
  const month = aiMonthKey();
  return usage.month === month
    ? {
        month,
        requests: Math.max(Math.floor(Number(usage.requests) || 0), 0),
        estimatedTokens: Math.max(Math.floor(Number(usage.estimatedTokens) || 0), 0)
      }
    : { month, requests: 0, estimatedTokens: 0 };
}

function aiBudgetStatus(config) {
  const budget = Math.max(Math.floor(Number(config.ai?.monthlyBudget) || 0), 0);
  const usage = aiUsageState(config);
  return {
    budget,
    usage,
    exceeded: budget > 0 && usage.estimatedTokens >= budget,
    remaining: budget > 0 ? Math.max(budget - usage.estimatedTokens, 0) : null
  };
}

async function recordAiUsage(store, guildId, config, usage = {}) {
  if (!guildId) return;
  const latestConfig = store.getGuild(guildId);
  const current = aiUsageState(latestConfig);
  const estimatedTokens = Math.max(Math.floor(Number(usage.totalTokens || usage.estimatedTokens) || 0), 1);
  await store.updateGuild(guildId, {
    ai: {
      ...latestConfig.ai,
      usage: {
        month: current.month,
        requests: current.requests + 1,
        estimatedTokens: current.estimatedTokens + estimatedTokens
      }
    }
  });
}

async function sendAiResult(ctx, aiResult) {
  const result = typeof aiResult === "string" ? { text: aiResult, usage: { totalTokens: 1 } } : aiResult;
  const text = neutralizeMentions(result?.text || "The artifact is quiet right now.");
  await recordAiUsage(ctx.store, ctx.message.guild?.id, ctx.config, result?.usage);
  await incrementMetric(ctx.store, ctx.message.guild.id, "aiReplies", 1).catch(() => {});
  await ctx.message.reply({ content: text, allowedMentions: NO_MENTIONS });
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
  if (ms < 60_000) {
    return `${Math.max(Math.ceil(ms / 1000), 1)}s`;
  }
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
  const exactMs = input.match(/^ms:(\d+)$/i);
  if (exactMs) return Number(exactMs[1]);

  const match = input.match(/^(\d+)(s|m|h|d|w|mo|y)$/i);
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const day = 86_400_000;
  const multipliers = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: day,
    w: 7 * day,
    mo: 30 * day,
    y: 365 * day
  };
  return amount * multipliers[unit];
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (days < 30) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (days < 365) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
}

function scheduleReminder(callback, delayMs) {
  const startedAt = Date.now();

  function scheduleNext() {
    const remaining = delayMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      callback();
      return;
    }

    setTimeout(scheduleNext, Math.min(remaining, MAX_REMINDER_TIMEOUT_MS));
  }

  scheduleNext();
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

async function sendPunishmentNotice(member, { guildName, action, reason, durationLabel = "", moderatorTag = "" }) {
  const lines = [
    `You have been ${action} in ${guildName}.`,
    durationLabel ? `Duration: ${durationLabel}` : "",
    `Reason: ${reason || "No reason provided."}`,
    moderatorTag ? `Moderator: ${moderatorTag}` : ""
  ].filter(Boolean);

  return member
    .send({
      content: lines.join("\n"),
      allowedMentions: NO_MENTIONS
    })
    .then(() => true)
    .catch(() => false);
}

async function recordModerationAudit(ctx, { action, member, reason, durationMs = 0, details = "" }) {
  await addAuditLog(ctx.store, ctx.message.guild.id, {
    type: "moderation",
    label: `${action.charAt(0).toUpperCase()}${action.slice(1)} issued`,
    action,
    details: details || `${member.user.tag} received ${action}.`,
    actor: ctx.message.author.tag,
    targetId: member.id,
    targetTag: member.user.tag,
    moderatorId: ctx.message.author.id,
    moderatorTag: ctx.message.author.tag,
    durationMs
  }).catch(() => {});
}

function targetTextChannel(message) {
  return message.mentions.channels.first() || message.channel;
}

function targetRole(message) {
  return message.mentions.roles.first();
}

function isSupportedImageAttachment(attachment) {
  const contentType = attachment.contentType?.toLowerCase() || "";
  const extension = attachment.name?.split(".").pop()?.toLowerCase();
  return (
    IMAGE_CONTENT_TYPES.has(contentType) ||
    ["png", "jpg", "jpeg", "webp"].includes(extension)
  );
}

function isSupportedMediaAttachment(attachment) {
  const contentType = attachment.contentType?.toLowerCase() || "";
  const extension = attachment.name?.split(".").pop()?.toLowerCase();
  return (
    MEDIA_CONTENT_TYPES.has(contentType) ||
    ["png", "jpg", "jpeg", "webp", "gif"].includes(extension)
  );
}

function isGifAttachment(attachment) {
  const contentType = attachment.contentType?.toLowerCase() || "";
  const extension = attachment.name?.split(".").pop()?.toLowerCase();
  return GIF_CONTENT_TYPES.has(contentType) || extension === "gif";
}

async function findAttachmentBy(message, predicate) {
  const directAttachment = message.attachments.find(predicate);
  if (directAttachment) return directAttachment;

  const referencedMessageId = message.reference?.messageId;
  if (!referencedMessageId) return null;

  const referencedMessage = await message.channel.messages.fetch(referencedMessageId).catch(() => null);
  return referencedMessage?.attachments.find(predicate) || null;
}

async function findImageAttachment(message) {
  return findAttachmentBy(message, isSupportedImageAttachment);
}

async function findMediaAttachment(message) {
  return findAttachmentBy(message, isSupportedMediaAttachment);
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

async function downloadMediaAttachment(attachment) {
  if (attachment.size && attachment.size > MAX_MEDIA_BYTES) {
    throw new Error("That file is too large. Please use media under 25 MB.");
  }

  const response = await fetch(attachment.url);
  if (!response.ok) {
    throw new Error("I could not download that file from Discord.");
  }

  const contentType = (response.headers.get("content-type") || attachment.contentType || "").split(";")[0].toLowerCase();
  if (!isSupportedMediaAttachment({ contentType, name: attachment.name })) {
    throw new Error("Please use a PNG, JPG, WebP, or GIF.");
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_MEDIA_BYTES) {
    throw new Error("That file is too large. Please use media under 25 MB.");
  }

  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType: contentType || "image/png",
    filename: attachment.name || "media.png"
  };
}

function splitCaptionText(text) {
  const value = String(text || "").trim();
  if (!value) return { topText: "", bottomText: "" };
  const [topText, bottomText] = value.split("|").map((part) => part.trim());
  return { topText: topText || "", bottomText: bottomText || "" };
}

function slashGifOptions(ctx) {
  const slashOptions = ctx.message.slashOptions;
  if (!slashOptions) return null;

  const subcommand = slashOptions.getSubcommand();
  const attachment = slashOptions.getAttachment("file");
  return {
    subcommand,
    attachment,
    text: slashOptions.getString("text") || "",
    bottomText: slashOptions.getString("bottom_text") || "",
    factor: slashOptions.getNumber("factor") || 0,
    width: slashOptions.getInteger("width") || 0,
    height: slashOptions.getInteger("height") || 0,
    seconds: slashOptions.getInteger("seconds") || 0
  };
}

function prefixGifOptions(ctx) {
  const subcommand = (ctx.args[0] || "").toLowerCase();
  if (!subcommand) return null;
  const rest = ctx.args.slice(1).join(" ").trim();
  const { topText, bottomText } = splitCaptionText(rest);
  const firstNumber = Number(ctx.args[1]);
  return {
    subcommand,
    attachment: null,
    text: topText || rest,
    bottomText,
    factor: Number.isFinite(firstNumber) ? firstNumber : 0,
    width: Number.isInteger(Number(ctx.args[1])) ? Number(ctx.args[1]) : 0,
    height: Number.isInteger(Number(ctx.args[2])) ? Number(ctx.args[2]) : 0,
    seconds: Number.isInteger(Number(ctx.args[1])) ? Number(ctx.args[1]) : 0
  };
}

function gifUsageText(config) {
  return [
    `\`${config.prefix}gifedit caption some text\` + attach or reply to an image/GIF`,
    `\`${config.prefix}gifedit speed 2\` + attach or reply to a GIF`,
    `\`${config.prefix}gifedit reverse\` + attach or reply to a GIF`,
    `\`${config.prefix}gifedit boomerang\` + attach or reply to a GIF`,
    `\`${config.prefix}gifedit resize 320 320\` + attach or reply to a GIF`,
    `\`${config.prefix}gifedit wiggle 3\` + attach or reply to an image/GIF`
  ].join("\n");
}

function channelMentionList(ids) {
  return ids.length ? ids.map((id) => `<#${id}>`).join(", ") : "none";
}

function healthLine(ok, label, detail = "") {
  return `${ok ? "OK" : "Needs attention"} - **${label}**${detail ? `: ${detail}` : ""}`;
}

function textChannelById(guild, channelId = "") {
  if (!channelId) return null;
  const channel = guild.channels.cache.get(channelId);
  return channel?.isTextBased?.() ? channel : null;
}

function botCanSend(channel) {
  const me = channel?.guild?.members?.me;
  if (!channel || !me) return false;
  const permissions = me.permissionsIn(channel);
  return permissions.has(PermissionsBitField.Flags.ViewChannel) && permissions.has(PermissionsBitField.Flags.SendMessages);
}

function botPermissionSummary(channel, extraPermissions = []) {
  const me = channel?.guild?.members?.me;
  if (!channel || !me) return "missing channel";
  const permissions = me.permissionsIn(channel);
  const required = [
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    ...extraPermissions
  ];
  const missing = required.filter((permission) => !permissions.has(permission));
  return missing.length ? `missing ${missing.length} required permission${missing.length === 1 ? "" : "s"}` : "ready";
}

function configuredChannelRefs(config = {}) {
  const refs = [
    ["Welcome channel", config.welcome?.channelId],
    ["Moderation log", config.moderation?.logChannelId],
    ["Application start", config.applications?.channelId],
    ["Application threads", config.applications?.threadChannelId],
    ["Application category", config.applications?.categoryId],
    ["Game record alerts", config.publicSite?.games?.recordAlertChannelId],
    ...((config.ai?.channelIds || []).map((id) => [`AI chat ${id}`, id])),
    ...((config.ai?.blacklistedChannelIds || []).map((id) => [`AI blacklist ${id}`, id]))
  ];
  return refs.filter(([, id]) => id);
}

function configuredRoleRefs(config = {}) {
  const refs = [
    ["Autorole", config.autoRoleId],
    ["Application approved", config.applications?.approvedRoleId],
    ...((config.applications?.reviewerRoleIds || []).map((id) => [`Application reviewer ${id}`, id])),
    ...((config.applications?.blockedRoleIds || []).map((id) => [`Application blocked ${id}`, id])),
    ...((config.ai?.allowedRoleIds || []).map((id) => [`AI allowed ${id}`, id]))
  ];
  for (const [commandName, roleIds] of Object.entries(config.commandRoles?.overrides || {})) {
    for (const roleId of roleIds || []) refs.push([`Command override ${commandName}`, roleId]);
  }
  return refs.filter(([, id]) => id);
}

function missingConfiguredRefs(guild, config = {}) {
  const missingChannels = configuredChannelRefs(config)
    .filter(([, id]) => !guild.channels.cache.has(id))
    .map(([label, id]) => `${label}: ${id}`);
  const missingRoles = configuredRoleRefs(config)
    .filter(([, id]) => !guild.roles.cache.has(id))
    .map(([label, id]) => `${label}: ${id}`);
  return { missingChannels, missingRoles };
}

function compactRows(rows = [], limit = 12) {
  if (!rows.length) return "None.";
  const visible = rows.slice(0, limit);
  const hidden = rows.length - visible.length;
  return `${visible.join("\n")}${hidden > 0 ? `\n...and ${hidden} more.` : ""}`;
}

function localGitRevision() {
  try {
    const head = fs.readFileSync(path.join(process.cwd(), ".git", "HEAD"), "utf8").trim();
    if (head.startsWith("ref:")) {
      const refPath = head.replace("ref:", "").trim();
      return fs.readFileSync(path.join(process.cwd(), ".git", refPath), "utf8").trim().slice(0, 7);
    }
    return head.slice(0, 7);
  } catch {
    return "unknown";
  }
}

function countNestedEntries(value = {}) {
  return Object.values(value || {}).reduce((sum, entry) => {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      return sum + Object.keys(entry).length;
    }
    return sum + 1;
  }, 0);
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
const GAMBLING_COOLDOWN_MS = 5 * 1000;
const ROB_COOLDOWN_MS = 3 * 60 * 60 * 1000;
const CASINO_ROBBERY_COOLDOWN_MS = 8 * 60 * 60 * 1000;
const BANK_INTEREST_COOLDOWN_MS = 20 * 60 * 60 * 1000;
const BANK_INTEREST_RATE = 0.015;
const MAX_BANK_INTEREST = 1_000;
const DEFAULT_ECONOMY_SETTINGS = {
  dailyBread: DAILY_BREAD,
  maxBreadBet: MAX_BREAD_BET,
  gamblingCooldownSeconds: GAMBLING_COOLDOWN_MS / 1000,
  robCooldownMinutes: ROB_COOLDOWN_MS / 60000,
  casinoRobberyCooldownMinutes: CASINO_ROBBERY_COOLDOWN_MS / 60000,
  bankInterestCooldownHours: BANK_INTEREST_COOLDOWN_MS / 3600000,
  bankInterestRatePercent: BANK_INTEREST_RATE * 100,
  maxBankInterest: MAX_BANK_INTEREST,
  upgradeCosts: {}
};
const ECONOMY_UPGRADES = [
  {
    id: "daily-oven",
    name: "Daily Oven",
    description: "Adds 125 bread to every daily claim.",
    maxLevel: 5,
    baseCost: 1_500,
    costGrowth: 1.75,
    stat: "dailyBonus",
    valuePerLevel: 125
  },
  {
    id: "streak-vault",
    name: "Streak Vault",
    description: "Raises the daily streak bonus cap by 150 bread per level.",
    maxLevel: 4,
    baseCost: 2_000,
    costGrowth: 1.8,
    stat: "streakCapBonus",
    valuePerLevel: 150
  },
  {
    id: "interest-altar",
    name: "Interest Altar",
    description: "Adds 0.35% bank interest and 400 max interest per level.",
    maxLevel: 5,
    baseCost: 3_000,
    costGrowth: 1.9,
    stat: "interest"
  },
  {
    id: "interest-clock",
    name: "Interest Clock",
    description: "Shortens bank interest cooldown by 1 hour per level.",
    maxLevel: 5,
    baseCost: 2_800,
    costGrowth: 1.75,
    stat: "interestCooldown"
  },
  {
    id: "work-tools",
    name: "Work Tools",
    description: "Adds 60 bread to work payouts per level.",
    maxLevel: 5,
    baseCost: 1_250,
    costGrowth: 1.65,
    stat: "workBonus",
    valuePerLevel: 60
  },
  {
    id: "casino-disguise",
    name: "Casino Disguise",
    description: "Improves casino robbery payouts and lowers losses slightly.",
    maxLevel: 4,
    baseCost: 4_000,
    costGrowth: 2,
    stat: "casino"
  },
  {
    id: "bread-shield",
    name: "Bread Shield",
    description: "Keeps more of your wallet safe from member robberies.",
    maxLevel: 4,
    baseCost: 2_500,
    costGrowth: 1.8,
    stat: "robDefense",
    valuePerLevel: 0.04
  }
];
const ECONOMY_LOG_LIMIT = 60;
const BLACKJACK_SESSION_MS = 120_000;
const LOAN_GRACE_MS = 60 * 60 * 1000;
const LOAN_INTEREST_INTERVAL_MS = 30 * 60 * 1000;
const LOAN_INTEREST_RATE = 0.06;
const LOAN_SHARK_INTERVAL_MS = 60 * 60 * 1000;
const LOAN_MAX_INTEREST_TICKS = 24;
const LOAN_MAX_SHARK_TICKS = 12;
const LOAN_MAX_DEBT_MULTIPLIER = 5;
const blackjackSessions = new Map();

function normalizeEconomy(economy = {}) {
  return {
    ...economy,
    settings: {
      ...DEFAULT_ECONOMY_SETTINGS,
      ...(economy.settings || {}),
      upgradeCosts: {
        ...(economy.settings?.upgradeCosts || {}),
        ...(economy.upgradeCosts || {})
      }
    },
    balances: { ...(economy.balances || {}) },
    bankBalances: { ...(economy.bankBalances || {}) },
    upgrades: { ...(economy.upgrades || {}) },
    loans: { ...(economy.loans || {}) },
    dailyClaims: { ...(economy.dailyClaims || {}) },
    dailyStreaks: { ...(economy.dailyStreaks || {}) },
    stats: { ...(economy.stats || {}) },
    cooldowns: {
      ...(economy.cooldowns || {}),
      gambling: { ...(economy.cooldowns?.gambling || {}) },
      beg: { ...(economy.cooldowns?.beg || {}) },
      work: { ...(economy.cooldowns?.work || {}) },
      interest: { ...(economy.cooldowns?.interest || {}) },
      casinoRobbery: { ...(economy.cooldowns?.casinoRobbery || {}) },
      robbers: { ...(economy.cooldowns?.robbers || {}) },
      robVictims: { ...(economy.cooldowns?.robVictims || {}) }
    },
    transactions: Array.isArray(economy.transactions) ? economy.transactions.slice(-ECONOMY_LOG_LIMIT) : []
  };
}

function breadBalance(economy, userId) {
  return Math.max(Math.floor(Number(economy.balances?.[userId] ?? STARTING_BREAD) || 0), 0);
}

function setBreadBalance(economy, userId, amount) {
  economy.balances[userId] = Math.max(Math.floor(Number(amount) || 0), 0);
}

function bankBalance(economy, userId) {
  return Math.max(Math.floor(Number(economy.bankBalances?.[userId] || 0)), 0);
}

function setBankBalance(economy, userId, amount) {
  economy.bankBalances ||= {};
  economy.bankBalances[userId] = Math.max(Math.floor(Number(amount) || 0), 0);
}

function totalBreadWealth(economy, userId) {
  return breadBalance(economy, userId) + bankBalance(economy, userId);
}

function formatBread(amount) {
  return `${Math.floor(amount).toLocaleString()} bread`;
}

function maxLoanDebt(loan) {
  const principal = Math.max(Math.floor(Number(loan?.principal) || 0), 0);
  return principal * LOAN_MAX_DEBT_MULTIPLIER;
}

function clampLoanDebt(loan) {
  if (!loan) return loan;
  const cap = maxLoanDebt(loan);
  if (cap > 0) {
    loan.owed = Math.min(Math.max(Math.floor(Number(loan.owed) || 0), 0), cap);
  }
  return loan;
}

function userUpgrades(economy, userId) {
  return { ...(economy.upgrades?.[userId] || {}) };
}

function upgradeDefinition(upgradeId = "") {
  return ECONOMY_UPGRADES.find((upgrade) => upgrade.id === String(upgradeId || "").toLowerCase()) || null;
}

function upgradeLevel(economy, userId, upgradeId) {
  return Math.max(Math.floor(Number(economy.upgrades?.[userId]?.[upgradeId]) || 0), 0);
}

function clampEconomyNumber(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(numeric, min), max);
}

function economySettings(economy = {}) {
  const settings = {
    ...DEFAULT_ECONOMY_SETTINGS,
    ...(economy.settings || {})
  };
  return {
    dailyBread: Math.floor(clampEconomyNumber(settings.dailyBread, DAILY_BREAD, 0, 1_000_000)),
    maxBreadBet: Math.floor(clampEconomyNumber(settings.maxBreadBet, MAX_BREAD_BET, 1, 1_000_000)),
    gamblingCooldownMs: Math.floor(clampEconomyNumber(settings.gamblingCooldownSeconds, DEFAULT_ECONOMY_SETTINGS.gamblingCooldownSeconds, 0, 3600)) * 1000,
    robCooldownMs: Math.floor(clampEconomyNumber(settings.robCooldownMinutes, DEFAULT_ECONOMY_SETTINGS.robCooldownMinutes, 1, 10080)) * 60000,
    casinoRobberyCooldownMs: Math.floor(clampEconomyNumber(settings.casinoRobberyCooldownMinutes, DEFAULT_ECONOMY_SETTINGS.casinoRobberyCooldownMinutes, 1, 10080)) * 60000,
    bankInterestCooldownMs: Math.floor(clampEconomyNumber(settings.bankInterestCooldownHours, DEFAULT_ECONOMY_SETTINGS.bankInterestCooldownHours, 1, 168)) * 3600000,
    bankInterestRate: clampEconomyNumber(settings.bankInterestRatePercent, DEFAULT_ECONOMY_SETTINGS.bankInterestRatePercent, 0, 100) / 100,
    maxBankInterest: Math.floor(clampEconomyNumber(settings.maxBankInterest, MAX_BANK_INTEREST, 0, 1_000_000)),
    upgradeCosts: settings.upgradeCosts || {}
  };
}

function upgradeCost(upgrade, currentLevel, economy = {}) {
  const overrides = economySettings(economy).upgradeCosts?.[upgrade.id] || {};
  const baseCost = Math.floor(clampEconomyNumber(overrides.baseCost, upgrade.baseCost, 0, 10_000_000));
  const costGrowth = clampEconomyNumber(overrides.costGrowth, upgrade.costGrowth, 1, 10);
  return Math.max(Math.floor(baseCost * (costGrowth ** currentLevel)), 1);
}

function setUpgradeLevel(economy, userId, upgradeId, level) {
  economy.upgrades ||= {};
  economy.upgrades[userId] ||= {};
  economy.upgrades[userId][upgradeId] = Math.max(Math.floor(Number(level) || 0), 0);
}

function upgradeTotal(economy, userId, stat) {
  return ECONOMY_UPGRADES
    .filter((upgrade) => upgrade.stat === stat)
    .reduce((sum, upgrade) => sum + upgradeLevel(economy, userId, upgrade.id), 0);
}

function dailyBonusFor(economy, userId) {
  return upgradeTotal(economy, userId, "dailyBonus") * 125;
}

function dailyStreakCapFor(economy, userId) {
  return 500 + upgradeTotal(economy, userId, "streakCapBonus") * 150;
}

function workBonusFor(economy, userId) {
  return upgradeTotal(economy, userId, "workBonus") * 60;
}

function interestRateFor(economy, userId) {
  return economySettings(economy).bankInterestRate + upgradeTotal(economy, userId, "interest") * 0.0035;
}

function maxInterestFor(economy, userId) {
  return economySettings(economy).maxBankInterest + upgradeTotal(economy, userId, "interest") * 400;
}

function interestCooldownFor(economy, userId) {
  return Math.max(8 * 60 * 60 * 1000, economySettings(economy).bankInterestCooldownMs - upgradeTotal(economy, userId, "interestCooldown") * 60 * 60 * 1000);
}

function casinoUpgradeLevel(economy, userId) {
  return upgradeTotal(economy, userId, "casino");
}

function robDefenseFor(economy, userId) {
  return Math.min(upgradeTotal(economy, userId, "robDefense") * 0.04, 0.2);
}

function economyStatsFor(economy, userId) {
  const current = economy.stats?.[userId] || {};
  return {
    gamesPlayed: Math.max(Math.floor(Number(current.gamesPlayed) || 0), 0),
    gamesWon: Math.max(Math.floor(Number(current.gamesWon) || 0), 0),
    wagered: Math.max(Math.floor(Number(current.wagered) || 0), 0),
    profit: Math.floor(Number(current.profit) || 0),
    biggestWin: Math.max(Math.floor(Number(current.biggestWin) || 0), 0)
  };
}

function recordEconomyTransaction(economy, entry = {}) {
  economy.transactions ||= [];
  economy.transactions.push({
    ...entry,
    createdAt: entry.createdAt || new Date().toISOString()
  });
  economy.transactions = economy.transactions.slice(-ECONOMY_LOG_LIMIT);
}

function recordGamblingStats(economy, userId, { bet = 0, payout = 0, game = "Gambling" } = {}) {
  economy.stats ||= {};
  const wager = Math.max(Math.floor(Number(bet) || 0), 0);
  const grossPayout = Math.max(Math.floor(Number(payout) || 0), 0);
  const net = grossPayout - wager;
  const stats = economyStatsFor(economy, userId);
  stats.gamesPlayed += 1;
  if (grossPayout > wager) stats.gamesWon += 1;
  stats.wagered += wager;
  stats.profit += net;
  stats.biggestWin = Math.max(stats.biggestWin, net);
  economy.stats[userId] = stats;
  recordEconomyTransaction(economy, {
    userId,
    type: "gamble",
    game,
    bet: wager,
    payout: grossPayout,
    net,
    balance: breadBalance(economy, userId)
  });
}

function formatNetBread(net) {
  const amount = Math.abs(Math.floor(Number(net) || 0));
  if (!amount) return "even";
  return `${net > 0 ? "+" : "-"}${formatBread(amount)}`;
}

function activeLoan(economy, userId) {
  const loan = economy.loans?.[userId];
  if (!loan || loan.status === "paid") return null;
  return clampLoanDebt({
    principal: Math.max(Math.floor(Number(loan.principal) || 0), 0),
    owed: Math.max(Math.floor(Number(loan.owed) || 0), 0),
    borrowedAt: loan.borrowedAt || new Date().toISOString(),
    dueAt: loan.dueAt || loan.borrowedAt || new Date().toISOString(),
    lastInterestAt: loan.lastInterestAt || loan.dueAt || loan.borrowedAt || new Date().toISOString(),
    lastPenaltyAt: loan.lastPenaltyAt || loan.dueAt || loan.borrowedAt || new Date().toISOString(),
    strikes: Math.max(Math.floor(Number(loan.strikes) || 0), 0),
    status: loan.status || "active"
  });
}

function maxLoanAmount(economy, userId) {
  const wealth = totalBreadWealth(economy, userId);
  return Math.max(1_000, Math.min(15_000, Math.floor(750 + wealth * 0.35)));
}

function setLoan(economy, userId, loan) {
  economy.loans ||= {};
  if (!loan) {
    delete economy.loans[userId];
    return;
  }
  economy.loans[userId] = clampLoanDebt(loan);
}

function collectLoanSharkFee(economy, userId, amount) {
  let remaining = Math.max(Math.floor(Number(amount) || 0), 0);
  const wallet = breadBalance(economy, userId);
  const fromWallet = Math.min(wallet, remaining);
  if (fromWallet > 0) {
    setBreadBalance(economy, userId, wallet - fromWallet);
    remaining -= fromWallet;
  }
  const bank = bankBalance(economy, userId);
  const fromBank = Math.min(bank, remaining);
  if (fromBank > 0) {
    setBankBalance(economy, userId, bank - fromBank);
    remaining -= fromBank;
  }
  return {
    collected: fromWallet + fromBank,
    unpaid: remaining
  };
}

function applyLoanPressure(economy, userId, nowMs = Date.now()) {
  const loan = activeLoan(economy, userId);
  if (!loan || loan.owed < 1) return [];

  const notices = [];
  const dueMs = Date.parse(loan.dueAt);
  if (!Number.isFinite(dueMs) || nowMs <= dueMs) {
    setLoan(economy, userId, loan);
    return notices;
  }

  let interestAnchor = Math.max(Date.parse(loan.lastInterestAt) || dueMs, dueMs);
  const elapsedInterestTicks = Math.floor((nowMs - interestAnchor) / LOAN_INTEREST_INTERVAL_MS);
  const immediateInterest = elapsedInterestTicks === 0 && interestAnchor === dueMs && nowMs > dueMs;
  const interestTicks = Math.min(
    elapsedInterestTicks + (immediateInterest ? 1 : 0),
    LOAN_MAX_INTEREST_TICKS
  );
  let interestAdded = 0;
  for (let index = 0; index < interestTicks; index += 1) {
    const before = loan.owed;
    const interest = Math.max(1, Math.floor(loan.owed * LOAN_INTEREST_RATE));
    loan.owed += interest;
    clampLoanDebt(loan);
    interestAdded += loan.owed - before;
    interestAnchor = index === 0 && immediateInterest ? nowMs : interestAnchor + LOAN_INTEREST_INTERVAL_MS;
    if (loan.owed >= maxLoanDebt(loan)) break;
  }
  if (interestTicks > 0) {
    loan.lastInterestAt = new Date(interestAnchor).toISOString();
    notices.push(
      interestAdded > 0
        ? `Loan shark interest added **${formatBread(interestAdded)}**.`
        : `Loan shark interest hit the **${LOAN_MAX_DEBT_MULTIPLIER}x debt cap**.`
    );
    recordEconomyTransaction(economy, {
      userId,
      type: "loan-interest",
      amount: interestAdded,
      owed: loan.owed
    });
  }

  let penaltyAnchor = Math.max(Date.parse(loan.lastPenaltyAt) || dueMs, dueMs);
  const sharkTicks = Math.min(Math.floor((nowMs - penaltyAnchor) / LOAN_SHARK_INTERVAL_MS), LOAN_MAX_SHARK_TICKS);
  let collectedTotal = 0;
  let unpaidFees = 0;
  for (let index = 0; index < sharkTicks; index += 1) {
    loan.strikes += 1;
    const fee = Math.max(25, Math.floor(loan.owed * 0.035));
    const collection = collectLoanSharkFee(economy, userId, fee);
    collectedTotal += collection.collected;
    unpaidFees += collection.unpaid;
    if (collection.unpaid > 0) {
      const before = loan.owed;
      loan.owed += collection.unpaid;
      clampLoanDebt(loan);
      unpaidFees -= collection.unpaid - Math.max(loan.owed - before, 0);
    }
    penaltyAnchor += LOAN_SHARK_INTERVAL_MS;
  }
  if (sharkTicks > 0) {
    loan.lastPenaltyAt = new Date(penaltyAnchor).toISOString();
    notices.push(`Loan sharks made **${sharkTicks}** collection visit${sharkTicks === 1 ? "" : "s"} and took **${formatBread(collectedTotal)}**${unpaidFees ? `, adding **${formatBread(unpaidFees)}** unpaid fees to the debt` : ""}.`);
    recordEconomyTransaction(economy, {
      userId,
      type: "loan-collection",
      amount: -collectedTotal,
      feeAdded: unpaidFees,
      strikes: loan.strikes,
      owed: loan.owed,
      balance: breadBalance(economy, userId),
      bank: bankBalance(economy, userId)
    });
  }

  setLoan(economy, userId, loan);
  return notices;
}

function loanNoticeSummary(notices = []) {
  if (!notices.length) return "";
  return [`**Loan Shark Notice**`, ...notices].join("\n");
}

function persistentCooldownStatus(economy, bucket, id, cooldownMs) {
  const lastUsedAt = new Date(economy.cooldowns?.[bucket]?.[id] || 0).getTime();
  const remainingMs = cooldownMs - (Date.now() - lastUsedAt);
  return {
    limited: Number.isFinite(lastUsedAt) && remainingMs > 0,
    remainingMs: Math.max(remainingMs, 0)
  };
}

function setPersistentCooldown(economy, bucket, id) {
  economy.cooldowns ||= {};
  economy.cooldowns[bucket] ||= {};
  economy.cooldowns[bucket][id] = new Date().toISOString();
}

function publicLeaderboardPath() {
  return path.join(process.cwd(), "data", "game-leaderboard.json");
}

function cleanPublicGameId(value = "") {
  const gameId = String(value || "dash").toLowerCase().replace(/[^a-z0-9-]/g, "");
  return PUBLIC_GAME_IDS.includes(gameId) ? gameId : "dash";
}

function publicGameLabel(gameId = "") {
  const labels = {
    dash: "Chipkittle Dash",
    runner: "Ritual Runner",
    mines: "Bread Mines",
    catch: "Bread Catch"
  };
  return labels[cleanPublicGameId(gameId)] || "Chipkittle Dash";
}

function readPublicLeaderboardEntries() {
  try {
    const parsed = JSON.parse(fs.readFileSync(publicLeaderboardPath(), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function publicGameEntries(entries = [], gameId = "dash", limit = 10) {
  return entries
    .filter((entry) => cleanPublicGameId(entry.game) === cleanPublicGameId(gameId))
    .map((entry) => ({
      game: cleanPublicGameId(entry.game),
      name: String(entry.name || "Anonymous Chipkittle").slice(0, 24),
      score: Math.max(Math.floor(Number(entry.score) || 0), 0),
      bread: Math.max(Math.floor(Number(entry.bread) || 0), 0),
      createdAt: String(entry.createdAt || "")
    }))
    .sort((a, b) => b.score - a.score || b.bread - a.bread)
    .slice(0, limit);
}

function gameRecordChannelId(config = {}) {
  return String(config.publicSite?.games?.recordAlertChannelId || "");
}

function suggestionStaffUserId(config = {}) {
  return String(config.publicSite?.suggestions?.staffUserId || "203025242753335296").replace(/\D/g, "");
}

function suggestionId() {
  return `sug-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function suggestionStatusLabel(status = "submitted") {
  const labels = {
    submitted: "Submitted",
    under_consideration: "Under Consideration",
    accepted: "Accepted",
    denied: "Denied",
    implemented: "Implemented"
  };
  return labels[String(status || "submitted")] || labels.submitted;
}

function createSuggestionRecord({ source = "discord", authorId = "", authorTag = "", authorName = "", title = "", body = "" } = {}) {
  const now = new Date().toISOString();
  return {
    id: suggestionId(),
    source,
    authorId,
    authorTag,
    authorName: cleanText(authorName || authorTag || "Anonymous", 80),
    title: cleanText(title, 90),
    body: cleanText(body, 1000),
    status: "submitted",
    createdAt: now,
    updatedAt: now
  };
}

function storedSuggestions(config = {}) {
  return Array.isArray(config.community?.suggestions) ? config.community.suggestions : [];
}

function isPanelRootUser(config = {}, userId = "") {
  const users = panelAccessUsers(config);
  const entry = users[userId];
  return Boolean(entry && !entry.revokedAt && panelAccessAtLeast(normalizePanelAccessLevel(entry.level), "root"));
}

function buildSuggestionEmbed(suggestion = {}) {
  const body = [
    suggestion.title ? `**${suggestion.title}**` : "",
    suggestion.body || "No suggestion body provided.",
    "",
    `Source: **${suggestion.source === "website" ? "Website" : "Discord"}**`,
    `Status: **${suggestionStatusLabel(suggestion.status)}**`,
    `Author: **${suggestion.authorTag || suggestion.authorName || "Anonymous"}**`
  ].filter(Boolean).join("\n");

  return buildPrettyEmbed({
    title: "New Chipkittle Suggestion",
    description: body.slice(0, 3900),
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
    allowedMentions: NO_MENTIONS
  }).catch(() => null);
}

function rankForBalance(economy, userId) {
  const ids = new Set([
    ...Object.keys(economy.balances || {}),
    ...Object.keys(economy.bankBalances || {})
  ]);
  return [...ids]
    .map((id) => [id, totalBreadWealth(economy, id)])
    .sort((a, b) => b[1] - a[1])
    .findIndex(([id]) => id === userId) + 1;
}

function parseBreadAmount(input, balance, maxAmount = MAX_BREAD_BET) {
  const raw = String(input || "").trim().toLowerCase();
  if (raw === "all" || raw === "max") return Math.min(balance, maxAmount);
  if (raw === "half") return Math.min(Math.floor(balance / 2), maxAmount);

  const amount = Math.floor(Number(raw.replaceAll(",", "")));
  if (!Number.isFinite(amount)) return null;
  return amount;
}

function validateBreadBet(input, balance, economy = {}) {
  const maxBet = economySettings(economy).maxBreadBet;
  const amount = parseBreadAmount(input, balance, maxBet);
  if (!amount || amount < 1) return { ok: false, error: "Bet at least 1 bread." };
  if (amount > balance) return { ok: false, error: `You only have ${formatBread(balance)}.` };
  if (amount > maxBet) return { ok: false, error: `Max bet is ${formatBread(maxBet)}.` };
  return { ok: true, amount };
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function updateBreadEconomy(ctx, mutator) {
  const guildId = ctx.message.guild.id;
  const latestConfig = ctx.store.getGuild(guildId);
  const economy = normalizeEconomy(latestConfig.economy);
  const loanNotices = applyLoanPressure(economy, ctx.message.author.id);
  let result = await mutator(economy, latestConfig, loanNotices);
  if (typeof result === "string" && loanNotices.length) {
    result = `${result}\n\n${loanNoticeSummary(loanNotices)}`;
  }
  await ctx.store.updateGuild(guildId, { economy });
  return result;
}

async function runBreadBet(ctx, gameName, resolver) {
  const reply = await updateBreadEconomy(ctx, async (economy) => {
    const userId = ctx.message.author.id;
    const balance = breadBalance(economy, userId);
    const settings = economySettings(economy);
    const bet = validateBreadBet(ctx.args[0], balance, economy);
    if (!bet.ok) return bet.error;

    const cooldown = persistentCooldownStatus(economy, "gambling", userId, settings.gamblingCooldownMs);
    if (cooldown.limited) {
      return `Slow down a little. You can gamble again in ${formatCooldown(cooldown.remainingMs)}.`;
    }
    setPersistentCooldown(economy, "gambling", userId);

    const result = resolver(bet.amount, balance, economy);
    const payout = Math.max(Math.floor(Number(result.payout) || 0), 0);
    const nextBalance = balance - bet.amount + payout;
    setBreadBalance(economy, userId, nextBalance);
    recordGamblingStats(economy, userId, { bet: bet.amount, payout, game: gameName });
    const net = payout - bet.amount;

    return [
      `**${gameName}**`,
      result.text,
      `Bet: ${formatBread(bet.amount)}`,
      `Payout: ${formatBread(payout)}`,
      `Net: ${formatNetBread(net)}`,
      `Balance: ${formatBread(nextBalance)}`
    ].join("\n");
  });

  await ctx.message.reply(reply);
}

function createBlackjackDeck() {
  const ranks = [
    { name: "A", value: 11 },
    { name: "2", value: 2 },
    { name: "3", value: 3 },
    { name: "4", value: 4 },
    { name: "5", value: 5 },
    { name: "6", value: 6 },
    { name: "7", value: 7 },
    { name: "8", value: 8 },
    { name: "9", value: 9 },
    { name: "10", value: 10 },
    { name: "J", value: 10 },
    { name: "Q", value: 10 },
    { name: "K", value: 10 }
  ];
  return ["spades", "hearts", "diamonds", "clubs"].flatMap((suit) =>
    ranks.map((rank) => ({ ...rank, suit }))
  );
}

function drawBlackjackCard(deck) {
  const index = randomInt(0, deck.length - 1);
  return deck.splice(index, 1)[0];
}

function blackjackHandValue(hand) {
  let total = hand.reduce((sum, card) => sum + card.value, 0);
  let aces = hand.filter((card) => card.name === "A").length;
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return total;
}

function blackjackHandText(hand, hidden = false) {
  if (hidden) return `${hand[0].name} + hidden`;
  return `${hand.map((card) => card.name).join(", ")} (${blackjackHandValue(hand)})`;
}

function blackjackCurrentHand(session) {
  return session.hands?.[session.activeHandIndex || 0] || {
    cards: session.player || [],
    bet: session.bet || 0,
    doubled: Boolean(session.doubled)
  };
}

function blackjackTotalBet(session) {
  return (session.hands || []).reduce((sum, hand) => sum + Math.max(Math.floor(Number(hand.bet) || 0), 0), 0) || session.bet || 0;
}

function blackjackCanSplit(session) {
  const hand = blackjackCurrentHand(session);
  return !session.split && hand.cards?.length === 2 && hand.cards[0]?.value === hand.cards[1]?.value;
}

function blackjackOutcome(session, hand = blackjackCurrentHand(session)) {
  const playerTotal = blackjackHandValue(hand.cards || session.player);
  const dealerTotal = blackjackHandValue(session.dealer);
  const bet = hand.bet || session.bet;
  const natural = !hand.fromSplit && (hand.cards || session.player).length === 2 && playerTotal === 21;
  const dealerNatural = session.dealer.length === 2 && dealerTotal === 21;
  if (playerTotal > 21) return { payout: 0, label: "Bust. House wins." };
  if (natural && dealerNatural) return { payout: bet, label: "Both hands have natural blackjack. Push." };
  if (natural) return { payout: Math.floor(bet * 2.5), label: "Natural blackjack." };
  if (dealerNatural) return { payout: 0, label: "Dealer has natural blackjack." };
  if (dealerTotal > 21) return { payout: bet * 2, label: "Dealer busts. You win." };
  if (playerTotal > dealerTotal) return { payout: bet * 2, label: "You beat the dealer." };
  if (playerTotal === dealerTotal) return { payout: bet, label: "Push. Bet returned." };
  return { payout: 0, label: "Dealer wins." };
}

function blackjackButtons(session, disabled = false) {
  const hand = blackjackCurrentHand(session);
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`bj:${session.id}:hit`)
        .setLabel("Hit")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`bj:${session.id}:stand`)
        .setLabel("Stand")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`bj:${session.id}:double`)
        .setLabel("Double")
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled || hand.cards.length !== 2 || hand.doubled),
      new ButtonBuilder()
        .setCustomId(`bj:${session.id}:split`)
        .setLabel("Split")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || !blackjackCanSplit(session))
    )
  ];
}

function blackjackTableText(session, revealDealer = false, footer = "Choose hit, stand, or double.") {
  const hands = session.hands || [{ cards: session.player, bet: session.bet, doubled: session.doubled }];
  const handLines = hands.map((hand, index) => {
    const active = !session.settled && index === (session.activeHandIndex || 0) ? " ->" : "";
    const suffix = hand.settled ? " [done]" : hand.doubled ? " [doubled]" : "";
    return `${active} Hand ${index + 1}: **${blackjackHandText(hand.cards)}** - Bet ${formatBread(hand.bet)}${suffix}`;
  });
  return [
    `**Bread Blackjack**`,
    `Total bet: ${formatBread(blackjackTotalBet(session))}`,
    ...handLines,
    `Dealer hand: **${blackjackHandText(session.dealer, !revealDealer)}**`,
    footer
  ].join("\n");
}

define({
  name: "help",
  aliases: ["commands"],
  category: "General",
  description: "Show commands, or details for one command.",
  usage: "help [command]",
  async run(ctx) {
    const byCategory = commandCategoryMap(ctx.commandList);
    const resolved = resolveHelpTarget(ctx.commandList, ctx.rest || ctx.args[0] || "");
    if (resolved === null) {
      await ctx.message.reply(`I could not find a command or category named **${ctx.rest || ctx.args[0]}**.`);
      return;
    }

    const initialCategory = resolved?.type === "command"
      ? resolved.command.category || "Other"
      : resolved?.type === "category"
        ? resolved.category
        : "";

    let state = {
      view: resolved?.type === "command" ? "command" : resolved?.type === "category" ? "category" : "overview",
      category: initialCategory,
      categoryPage: 0,
      overviewPage: 0,
      command: resolved?.type === "command" ? resolved.command : null
    };

    if (initialCategory) {
      const categoryCommands = byCategory.get(initialCategory) || [];
      const commandIndex = resolved?.type === "command"
        ? categoryCommands.findIndex((entry) => entry.name === resolved.command.name)
        : 0;
      state.categoryPage = commandIndex >= 0 ? Math.floor(commandIndex / HELP_COMMANDS_PER_PAGE) : 0;
    }

    const sent = await ctx.message.reply({
      embeds: [helpRenderEmbed(ctx, byCategory, state)],
      components: helpComponents(ctx, byCategory, state)
    });

    const collector = sent.createMessageComponentCollector({ time: 180_000 });
    collector.on("collect", async (interaction) => {
      if (interaction.user.id !== ctx.message.author.id) {
        await interaction.reply({
          content: "Only the person who opened this help menu can use it.",
          ephemeral: true
        });
        return;
      }

      if (interaction.isStringSelectMenu()) {
        if (interaction.customId.endsWith(":category")) {
          state = {
            ...state,
            view: "category",
            category: interaction.values[0],
            categoryPage: 0,
            command: null
          };
        } else if (interaction.customId.endsWith(":command")) {
          const command = ctx.commandList.find((entry) => entry.name === interaction.values[0]) || null;
          if (command) {
            state = {
              ...state,
              view: "command",
              category: command.category || state.category,
              command
            };
          }
        }
      } else if (interaction.isButton()) {
        const categoryCommands = state.category ? byCategory.get(state.category) || [] : [];
        const commandPages = chunkItems(categoryCommands, HELP_COMMANDS_PER_PAGE);
        const categoryPages = helpCategoryChunks(byCategory);

        if (interaction.customId.endsWith(":home")) {
          state = { ...state, view: "overview", command: null };
        } else if (interaction.customId.endsWith(":back")) {
          state = state.view === "command" && state.category
            ? { ...state, view: "category", command: null }
            : { ...state, view: "overview", command: null };
        } else if (interaction.customId.endsWith(":prev")) {
          if (state.view === "overview") {
            state = { ...state, overviewPage: Math.max((state.overviewPage || 0) - 1, 0) };
          } else {
            state = {
              ...state,
              view: "category",
              command: null,
              categoryPage: Math.max((state.categoryPage || 0) - 1, 0)
            };
          }
        } else if (interaction.customId.endsWith(":next")) {
          if (state.view === "overview") {
            state = {
              ...state,
              overviewPage: Math.min((state.overviewPage || 0) + 1, Math.max(categoryPages.length - 1, 0))
            };
          } else {
            state = {
              ...state,
              view: "category",
              command: null,
              categoryPage: Math.min((state.categoryPage || 0) + 1, Math.max(commandPages.length - 1, 0))
            };
          }
        }
      }

      await interaction.update({
        embeds: [helpRenderEmbed(ctx, byCategory, state)],
        components: helpComponents(ctx, byCategory, state)
      });
    });

    collector.on("end", () => {
      sent.edit({
        components: helpComponents(ctx, byCategory, state, true)
      }).catch(() => {});
    });
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
  name: "healthcheck",
  aliases: ["bothealth", "checkconfig"],
  category: "Config",
  description: "Check common bot setup problems without changing settings.",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const guild = ctx.message.guild;
    const config = ctx.config;
    const logChannel = textChannelById(guild, config.moderation?.logChannelId);
    const appChannel = textChannelById(guild, config.applications?.channelId);
    const appThreadChannel = textChannelById(guild, config.applications?.threadChannelId || config.applications?.channelId);
    const recordChannel = textChannelById(guild, gameRecordChannelId(config));
    const aiChannels = (config.ai.channelIds || []).map((id) => textChannelById(guild, id)).filter(Boolean);
    const missingAiChannels = (config.ai.channelIds || []).filter((id) => !textChannelById(guild, id));
    const rows = [
      healthLine(Boolean(ctx.client.user), "Bot session", ctx.client.user ? `online as ${ctx.client.user.tag}` : "not ready"),
      healthLine(Boolean(logChannel), "Moderation log channel", logChannel ? `${logChannel} ${botCanSend(logChannel) ? "can send" : "cannot send"}` : "not configured or missing"),
      healthLine(!config.applications?.enabled || Boolean(appThreadChannel), "Application review channel", config.applications?.enabled ? (appThreadChannel ? `${appThreadChannel}` : "missing") : "applications disabled"),
      healthLine(!appThreadChannel || botCanSend(appThreadChannel), "Application channel permissions", appThreadChannel ? (botCanSend(appThreadChannel) ? "can send" : "cannot send") : "no channel"),
      healthLine(!recordChannel || botCanSend(recordChannel), "Game record alerts", recordChannel ? `${recordChannel} ${botCanSend(recordChannel) ? "can send" : "cannot send"}` : "not configured"),
      healthLine(config.ai.enabled ? ctx.ai.enabled : true, "AI API key", config.ai.enabled ? (ctx.ai.enabled ? "configured" : "missing OPENAI_API_KEY") : "AI disabled"),
      healthLine(missingAiChannels.length === 0, "AI channels", aiChannels.length ? `${aiChannels.length} configured` : (missingAiChannels.length ? `${missingAiChannels.length} missing` : "none configured")),
      healthLine(Boolean(config.prefix), "Legacy prefix", `\`${config.prefix || "!"}\``)
    ];

    await ctx.message.reply(rows.join("\n"));
  }
});

define({
  name: "oauthcheck",
  aliases: ["paneloauth", "redirectcheck"],
  category: "Config",
  description: "Show the exact Discord OAuth redirect URI the panel expects.",
  async run(ctx) {
    if (!requirePanelRoot(ctx)) return;
    const publicUrl = String(ctx.publicUrl || "").replace(/\/+$/, "");
    const redirectUri = publicUrl
      ? `${publicUrl}/auth/discord/callback`
      : "PUBLIC_URL is not configured";
    const rows = [
      `**Panel OAuth Check**`,
      `PUBLIC_URL: ${ctx.publicUrl || "not configured"}`,
      `Expected Discord redirect URI:`,
      `\`${redirectUri}\``,
      "",
      "Discord Developer Portal path: Application -> OAuth2 -> Redirects.",
      "The saved redirect must match exactly, including https and no extra slash."
    ];
    await ctx.message.reply(rows.join("\n"));
  }
});

define({
  name: "configdoctor",
  aliases: ["doctor", "configaudit"],
  category: "Config",
  description: "Find missing channel and role references in saved config.",
  usage: "configdoctor [repair]",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const repair = ctx.args[0]?.toLowerCase() === "repair";
    const { missingChannels, missingRoles } = missingConfiguredRefs(ctx.message.guild, ctx.config);

    if (!repair) {
      await ctx.message.reply([
        `**Config Doctor**`,
        `Missing channels: **${missingChannels.length}**`,
        compactRows(missingChannels),
        "",
        `Missing roles: **${missingRoles.length}**`,
        compactRows(missingRoles),
        "",
        `Run \`${ctx.config.prefix}configdoctor repair\` to remove missing AI/app/public references that are safe to clean automatically.`
      ].join("\n"));
      return;
    }

    if (!requirePanelRoot(ctx)) return;
    const guild = ctx.message.guild;
    const keepChannel = (id) => !id || guild.channels.cache.has(id);
    const keepRole = (id) => !id || guild.roles.cache.has(id);
    const nextCommandOverrides = Object.fromEntries(
      Object.entries(ctx.config.commandRoles?.overrides || {})
        .map(([commandName, roleIds]) => [
          commandName,
          (roleIds || []).filter((roleId) => guild.roles.cache.has(roleId))
        ])
        .filter(([, roleIds]) => roleIds.length)
    );

    await ctx.store.updateGuild(ctx.message.guild.id, {
      welcome: { ...ctx.config.welcome, channelId: keepChannel(ctx.config.welcome.channelId) ? ctx.config.welcome.channelId : "" },
      autoRoleId: keepRole(ctx.config.autoRoleId) ? ctx.config.autoRoleId : "",
      moderation: { ...ctx.config.moderation, logChannelId: keepChannel(ctx.config.moderation.logChannelId) ? ctx.config.moderation.logChannelId : "" },
      applications: {
        ...ctx.config.applications,
        channelId: keepChannel(ctx.config.applications.channelId) ? ctx.config.applications.channelId : "",
        threadChannelId: keepChannel(ctx.config.applications.threadChannelId) ? ctx.config.applications.threadChannelId : "",
        categoryId: keepChannel(ctx.config.applications.categoryId) ? ctx.config.applications.categoryId : "",
        approvedRoleId: keepRole(ctx.config.applications.approvedRoleId) ? ctx.config.applications.approvedRoleId : "",
        reviewerRoleIds: (ctx.config.applications.reviewerRoleIds || []).filter(keepRole),
        blockedRoleIds: (ctx.config.applications.blockedRoleIds || []).filter(keepRole)
      },
      ai: {
        ...ctx.config.ai,
        channelIds: (ctx.config.ai.channelIds || []).filter(keepChannel),
        blacklistedChannelIds: (ctx.config.ai.blacklistedChannelIds || []).filter(keepChannel),
        allowedRoleIds: (ctx.config.ai.allowedRoleIds || []).filter(keepRole)
      },
      publicSite: {
        ...ctx.config.publicSite,
        games: {
          ...ctx.config.publicSite.games,
          recordAlertChannelId: keepChannel(ctx.config.publicSite?.games?.recordAlertChannelId) ? ctx.config.publicSite.games.recordAlertChannelId : ""
        }
      },
      commandRoles: {
        ...ctx.config.commandRoles,
        overrides: nextCommandOverrides
      }
    });
    await ctx.message.reply(`Config repair complete. Removed **${missingChannels.length}** missing channel reference${missingChannels.length === 1 ? "" : "s"} and **${missingRoles.length}** missing role reference${missingRoles.length === 1 ? "" : "s"} where safe.`);
  }
});

define({
  name: "permissionaudit",
  aliases: ["permaudit", "botperms"],
  category: "Config",
  description: "Audit bot permissions in important configured channels.",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const rows = [
      ["Moderation log", textChannelById(ctx.message.guild, ctx.config.moderation?.logChannelId), []],
      ["Application start", textChannelById(ctx.message.guild, ctx.config.applications?.channelId), []],
      ["Application threads", textChannelById(ctx.message.guild, ctx.config.applications?.threadChannelId || ctx.config.applications?.channelId), [
        PermissionsBitField.Flags.CreatePrivateThreads,
        PermissionsBitField.Flags.ManageThreads,
        PermissionsBitField.Flags.SendMessagesInThreads
      ]],
      ["Game record alerts", textChannelById(ctx.message.guild, gameRecordChannelId(ctx.config)), []],
      ...((ctx.config.ai.channelIds || []).map((id) => [`AI channel ${id}`, textChannelById(ctx.message.guild, id), []]))
    ].map(([label, channel, extras]) => `${channel ? `${channel}` : "Missing"} - **${label}**: ${botPermissionSummary(channel, extras)}`);

    await ctx.message.reply([`**Bot Permission Audit**`, compactRows(rows, 16)].join("\n"));
  }
});

define({
  name: "securitycheck",
  aliases: ["accessaudit", "panelsecurity"],
  category: "Config",
  description: "Review risky panel, AI, and command-access settings.",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const panelUsers = Object.values(panelAccessUsers(ctx.config)).filter((user) => !user.revokedAt);
    const rootUsers = panelUsers.filter((user) => normalizePanelAccessLevel(user.level) === "root");
    const grantOverrides = ctx.config.commandRoles?.overrides?.grantaccess || [];
    const rows = [
      healthLine(rootUsers.length > 0, "Root panel users", `${rootUsers.length} active`),
      healthLine(grantOverrides.length > 0, "Grant access roles", grantOverrides.length ? grantOverrides.map((roleId) => `<@&${roleId}>`).join(", ") : "only root users through fallback"),
      healthLine((ctx.config.ai.allowedRoleIds || []).length > 0 || !ctx.config.ai.enabled, "AI role gate", ctx.config.ai.enabled ? ((ctx.config.ai.allowedRoleIds || []).length ? "restricted" : "everyone can use AI") : "AI disabled"),
      healthLine(ctx.config.ai.monthlyBudget > 0 || !ctx.config.ai.enabled, "AI monthly budget", ctx.config.ai.enabled ? (ctx.config.ai.monthlyBudget ? `${ctx.config.ai.monthlyBudget.toLocaleString()} estimated tokens` : "unlimited") : "AI disabled"),
      healthLine(true, "Backups", "restore center is root-only"),
      healthLine(Boolean(ctx.config.moderation?.logChannelId), "Moderation logs", ctx.config.moderation?.logChannelId ? `<#${ctx.config.moderation.logChannelId}>` : "not configured")
    ];
    await ctx.message.reply([`**Security Check**`, ...rows].join("\n"));
  }
});

define({
  name: "appcleanup",
  aliases: ["applicationcleanup", "cleanstaleapps"],
  category: "Applications",
  description: "Clean saved application tickets whose review threads are gone.",
  usage: "appcleanup [run]",
  async run(ctx) {
    if (!isApplicationStaff(ctx) && !requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const run = ctx.args[0]?.toLowerCase() === "run";
    const tickets = Object.entries(ctx.config.applications?.tickets || {});
    const stale = [];
    for (const [userId, ticket] of tickets) {
      const channel = ticket.channelId ? await ctx.client.channels.fetch(ticket.channelId).catch(() => null) : null;
      if (!channel || channel.archived || channel.locked) stale.push([userId, ticket]);
    }

    if (!run) {
      await ctx.message.reply([
        `**Application Cleanup**`,
        `Open ticket records: **${tickets.length}**`,
        `Stale or closed records: **${stale.length}**`,
        stale.length ? compactRows(stale.map(([userId, ticket]) => `<@${userId}> - ${ticket.channelId || "missing channel"}`), 10) : "Nothing to clean.",
        stale.length ? `Run \`${ctx.config.prefix}appcleanup run\` to remove stale records.` : ""
      ].filter(Boolean).join("\n"));
      return;
    }

    for (const [userId] of stale) {
      await clearApplicationTicket(ctx.store, ctx.message.guild.id, userId);
    }
    await ctx.message.reply(`Application cleanup removed **${stale.length}** stale ticket record${stale.length === 1 ? "" : "s"}.`);
  }
});

define({
  name: "economyaudit",
  aliases: ["breadaudit", "loanreport"],
  category: "Gambling",
  description: "Review economy totals, active loans, and debt-cap health.",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const economy = normalizeEconomy(ctx.config.economy || {});
    const walletTotal = Object.values(economy.balances || {}).reduce((sum, amount) => sum + Math.max(Math.floor(Number(amount) || 0), 0), 0);
    const bankTotal = Object.values(economy.bankBalances || {}).reduce((sum, amount) => sum + Math.max(Math.floor(Number(amount) || 0), 0), 0);
    const loans = Object.entries(economy.loans || {})
      .map(([userId, loan]) => [userId, activeLoan(economy, userId) || loan])
      .filter(([, loan]) => loan && loan.status !== "paid" && Number(loan.owed) > 0);
    const capped = loans.filter(([, loan]) => Math.floor(Number(loan.owed) || 0) >= maxLoanDebt(loan));
    await ctx.message.reply([
      `**Bread Economy Audit**`,
      `Wallet total: **${formatBread(walletTotal)}**`,
      `Bank total: **${formatBread(bankTotal)}**`,
      `Tracked users: **${new Set([...Object.keys(economy.balances || {}), ...Object.keys(economy.bankBalances || {})]).size}**`,
      `Active loans: **${loans.length}**`,
      `Loans at 5x cap: **${capped.length}**`,
      loans.length ? compactRows(loans.sort((a, b) => Number(b[1].owed) - Number(a[1].owed)).slice(0, 8).map(([userId, loan]) => `<@${userId}> owes **${formatBread(loan.owed)}** / cap **${formatBread(maxLoanDebt(loan))}**`), 8) : "No active loans."
    ].join("\n"));
  }
});

define({
  name: "loancapsweep",
  aliases: ["caploans", "fixloans"],
  category: "Gambling",
  description: "Clamp all active loan debt to the 5x principal cap.",
  async run(ctx) {
    if (!requirePanelRoot(ctx)) return;
    const economy = normalizeEconomy(ctx.config.economy || {});
    let changed = 0;
    for (const [userId, loan] of Object.entries(economy.loans || {})) {
      const before = Math.max(Math.floor(Number(loan.owed) || 0), 0);
      clampLoanDebt(loan);
      if (loan.owed !== before) {
        changed += 1;
        recordEconomyTransaction(economy, {
          userId,
          type: "loan-cap-sweep",
          amount: loan.owed - before,
          owed: loan.owed
        });
      }
    }
    await ctx.store.updateGuild(ctx.message.guild.id, { economy });
    await ctx.message.reply(`Loan cap sweep complete. Adjusted **${changed}** loan${changed === 1 ? "" : "s"}.`);
  }
});

define({
  name: "commandhealth",
  aliases: ["commandaudit", "commandreport"],
  category: "Config",
  description: "Summarize disabled commands, disabled categories, and top usage.",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const disabledCommands = Object.keys(ctx.config.commandRoles?.disabled || {}).filter((name) => ctx.config.commandRoles.disabled[name]);
    const disabledCategories = Object.keys(ctx.config.commandRoles?.disabledCategories || {}).filter((name) => ctx.config.commandRoles.disabledCategories[name]);
    const top = topCommands(ctx.config, 8).map((item) => `${item.name}: ${item.count} uses`);
    await ctx.message.reply([
      `**Command Health**`,
      `Registered commands: **${commandDefinitions.length}**`,
      `Disabled commands: **${disabledCommands.length}**`,
      compactRows(disabledCommands, 10),
      "",
      `Disabled categories: **${disabledCategories.length}**`,
      compactRows(disabledCategories, 10),
      "",
      `Top usage:`,
      compactRows(top, 8)
    ].join("\n"));
  }
});

define({
  name: "panelusers",
  aliases: ["accesslist", "panelaccesslist"],
  category: "Config",
  description: "List active panel users and access levels.",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const users = Object.entries(panelAccessUsers(ctx.config))
      .filter(([, user]) => !user.revokedAt)
      .sort((a, b) => panelAccessRank(b[1].level) - panelAccessRank(a[1].level))
      .map(([userId, user]) => `<@${userId}> - **${panelAccessLabel(user.level)}**${user.passwordResetRequired ? " - reset required" : ""}`);
    await ctx.message.reply([`**Panel Users**`, compactRows(users, 15)].join("\n"));
  }
});

define({
  name: "configsummary",
  aliases: ["serversummary", "setupsummary"],
  category: "Config",
  description: "Show a compact overview of the current bot setup.",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const config = ctx.config;
    await ctx.message.reply([
      `**Chipkittle Setup Summary**`,
      `Prefix: \`${config.prefix}\` | AI: **${config.ai.enabled ? config.ai.mode || "on" : "off"}** | Applications: **${config.applications.enabled ? "on" : "off"}**`,
      `Moderation log: ${config.moderation.logChannelId ? `<#${config.moderation.logChannelId}>` : "not set"}`,
      `AI channels: **${(config.ai.channelIds || []).length}** | AI blocked channels: **${(config.ai.blacklistedChannelIds || []).length}** | AI allowed roles: **${(config.ai.allowedRoleIds || []).length || "everyone"}**`,
      `Application reviewers: **${(config.applications.reviewerRoleIds || []).length}** | Approved role: ${config.applications.approvedRoleId ? `<@&${config.applications.approvedRoleId}>` : "not set"}`,
      `Public members: **${(config.publicSite.members || []).length}** | Suggestions: **${storedSuggestions(config).length}** | Artifacts: **${(config.community.artifacts || []).length}**`,
      `Panel users: **${Object.values(panelAccessUsers(config)).filter((user) => !user.revokedAt).length}** | Command overrides: **${Object.keys(config.commandRoles.overrides || {}).length}**`
    ].join("\n"));
  }
});

define({
  name: "cooldownaudit",
  aliases: ["cooldowns", "cooldownreport"],
  category: "Config",
  description: "Show persistent cooldown counts for economy and applications.",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const economyCooldowns = ctx.config.economy?.cooldowns || {};
    const appCooldowns = ctx.config.applications?.cooldowns || {};
    await ctx.message.reply([
      `**Cooldown Audit**`,
      `Application cooldowns: **${Object.keys(appCooldowns).length}**`,
      `Economy cooldown entries: **${countNestedEntries(economyCooldowns)}**`,
      `Gambling: **${Object.keys(economyCooldowns.gambling || {}).length}**`,
      `Robbers: **${Object.keys(economyCooldowns.robbers || {}).length}** | Victims: **${Object.keys(economyCooldowns.robVictims || {}).length}**`,
      `Beg: **${Object.keys(economyCooldowns.beg || {}).length}** | Work: **${Object.keys(economyCooldowns.work || {}).length}** | Interest: **${Object.keys(economyCooldowns.interest || {}).length}**`
    ].join("\n"));
  }
});

define({
  name: "prunecooldowns",
  aliases: ["cooldownprune"],
  category: "Config",
  description: "Root-only cleanup for very old persistent cooldown records.",
  usage: "prunecooldowns",
  async run(ctx) {
    if (!requirePanelRoot(ctx)) return;
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const economy = normalizeEconomy(ctx.config.economy || {});
    let removed = 0;
    for (const bucket of Object.keys(economy.cooldowns || {})) {
      const entries = economy.cooldowns[bucket];
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
      for (const [key, value] of Object.entries(entries)) {
        const time = Date.parse(value);
        if (Number.isFinite(time) && time < cutoff) {
          delete entries[key];
          removed += 1;
        }
      }
    }
    const applicationCooldowns = { ...(ctx.config.applications?.cooldowns || {}) };
    for (const [userId, entry] of Object.entries(applicationCooldowns)) {
      const time = Date.parse(entry?.lastAppliedAt || "");
      if (Number.isFinite(time) && time < cutoff) {
        delete applicationCooldowns[userId];
        removed += 1;
      }
    }
    await ctx.store.updateGuild(ctx.message.guild.id, {
      economy,
      applications: {
        ...ctx.config.applications,
        cooldowns: applicationCooldowns
      }
    });
    await ctx.message.reply(`Cooldown prune complete. Removed **${removed}** record${removed === 1 ? "" : "s"} older than 30 days.`);
  }
});

define({
  name: "deployversion",
  aliases: ["version", "build"],
  category: "Info",
  description: "Show the running bot version and local git revision.",
  async run(ctx) {
    await ctx.message.reply([
      `**Chipkittle Runtime**`,
      `Git revision: **${localGitRevision()}**`,
      `Node: **${process.version}**`,
      `Uptime: **${formatUptime(Math.round(process.uptime()))}**`,
      `Public URL: ${ctx.publicUrl || "not configured"}`
    ].join("\n"));
  }
});

define({
  name: "modsetup",
  aliases: ["modconfig", "moderationsetup"],
  category: "Moderation",
  description: "Show moderation setup, logging, warning totals, and automod state.",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const warnings = ctx.config.moderation?.warnings || {};
    const warningTotal = Object.values(warnings).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
    await ctx.message.reply([
      `**Moderation Setup**`,
      `Log channel: ${ctx.config.moderation.logChannelId ? `<#${ctx.config.moderation.logChannelId}>` : "not configured"}`,
      `Automod: **${ctx.config.automod.enabled ? "on" : "off"}**`,
      `Blocked words: **${(ctx.config.automod.blockedWords || []).length}**`,
      `Delete invites: **${ctx.config.automod.deleteInvites ? "yes" : "no"}** | Delete links: **${ctx.config.automod.deleteLinks ? "yes" : "no"}**`,
      `Warning ledger: **${warningTotal}** warning${warningTotal === 1 ? "" : "s"} across **${Object.keys(warnings).length}** member${Object.keys(warnings).length === 1 ? "" : "s"}`
    ].join("\n"));
  }
});

define({
  name: "prioritystatus",
  aliases: ["top15", "opsstatus"],
  category: "Config",
  description: "Show the completed operational priority checklist.",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const priorities = [
      "Detailed Discord commit changelogs",
      "Config health check",
      "Missing config reference doctor",
      "Bot permission audit",
      "Panel/security access audit",
      "Application ticket cleanup",
      "AI role gates",
      "AI monthly budget and usage tracking",
      "AI lore/chaos/length tuning",
      "AI channel personalities",
      "AI channel memory reset",
      "Loan debt capped at 5x principal",
      "Loan cap sweep",
      "Economy audit",
      "Cooldown audit and pruning"
    ];
    await ctx.message.reply([
      `**Top 15 Priority Status**`,
      priorities.map((item, index) => `${index + 1}. ${item} - done`).join("\n")
    ].join("\n"));
  }
});

define({
  name: "grantaccess",
  aliases: ["panelaccess", "grantpanel", "grantacces"],
  category: "Config",
  description: "Grant a Discord user access to the web panel.",
  usage: "grantaccess @user round table|keeper|artifact contributor|root [duration]",
  async run(ctx) {
    const existingUsers = panelAccessUsers(ctx.config);
    const hasAnyPanelUsers = Object.values(existingUsers).some((entry) => !entry?.revokedAt);
    const hasGrantCommandOverride = hasCommandRoleOverride(ctx.message.member, ctx.config, "grantaccess");
    if (!canGrantPanelAccess(ctx.config, ctx.message.author.id) && !hasGrantCommandOverride) {
      if (hasAnyPanelUsers || !hasPermission(ctx.message.member, PermissionsBitField.Flags.ManageGuild)) {
        await ctx.message.reply("Only configured panel grant roles can use this command.");
        return;
      }
    }

    const member = ctx.message.mentions.members.first();
    const accessArgs = ctx.args.slice(1);
    const possibleDuration = accessArgs.at(-1);
    const durationMs = parseDuration(possibleDuration || "");
    if (durationMs) accessArgs.pop();
    const template = ctx.config.panelAccess?.roleTemplates?.[String(accessArgs.join("_")).toLowerCase()];
    const level = normalizePanelAccessLevel(template?.level || accessArgs.join(" "));
    if (!member || !level) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }
    const expiresAt = durationMs
      ? new Date(Date.now() + durationMs).toISOString()
      : template?.days
        ? new Date(Date.now() + Number(template.days) * 24 * 60 * 60 * 1000).toISOString()
        : "";
    const grantorLevel = hasGrantCommandOverride
      ? "root"
      : normalizePanelAccessLevel(existingUsers[ctx.message.author.id]?.level || (hasAnyPanelUsers ? "" : "root"));
    if (grantorLevel !== "root" && !panelAccessAtLeast(grantorLevel, level)) {
      await ctx.message.reply("You cannot grant an access level higher than your own.");
      return;
    }

    const existingEntry = existingUsers[member.id];
    const existingActiveUser = existingEntry && !existingEntry.revokedAt && existingEntry.passwordHash;
    if (grantorLevel !== "root" && existingActiveUser && panelAccessAtLeast(existingEntry.level, grantorLevel)) {
      await ctx.message.reply("You cannot change access for someone at your rank or higher.");
      return;
    }
    const password = existingActiveUser ? "" : randomPanelPassword();
    let dmSent = true;
    const dmLines = existingActiveUser
      ? [
          "**Chipkittle Panel Access Updated**",
          `Username: \`${member.user.username}\``,
          `Access level: **${panelAccessLabel(level)}**`,
          `Expires: **${expiresAt ? `<t:${Math.floor(Date.parse(expiresAt) / 1000)}:R>` : "never"}**`,
          `Panel: ${ctx.publicUrl}`,
          "",
          "Sign in with Discord OAuth. Your recovery password did not change."
        ]
      : [
          "**Chipkittle Panel Access Granted**",
          `Discord account: \`${member.user.tag}\``,
          `Temporary recovery password: \`${password}\``,
          `Access level: **${panelAccessLabel(level)}**`,
          `Expires: **${expiresAt ? `<t:${Math.floor(Date.parse(expiresAt) / 1000)}:R>` : "never"}**`,
          `Panel: ${ctx.publicUrl}`,
          "",
          "Sign in with Discord OAuth. Password login is disabled; this recovery password is only shown once."
        ];
    await member.send(dmLines.join("\n")).catch(() => {
      dmSent = false;
    });

    if (!dmSent) {
      await ctx.message.reply("I could not DM that user, so panel access was not changed.");
      return;
    }

    await ctx.store.updateGuild(ctx.message.guild.id, {
      panelAccess: {
        ...ctx.config.panelAccess,
        users: {
          ...existingUsers,
          [member.id]: {
            ...(existingEntry || {}),
            username: member.user.username,
            level,
            passwordHash: existingActiveUser ? existingEntry.passwordHash : hashPanelPassword(password),
            grantedBy: ctx.message.author.id,
            grantedAt: new Date().toISOString(),
            expiresAt,
            revokedAt: ""
          }
        }
      }
    });

    await addAuditLog(ctx.store, ctx.message.guild.id, {
      type: "panel-access",
      label: existingActiveUser ? "Panel access changed" : "Panel access granted",
      details: `${ctx.message.author.tag} ${existingActiveUser ? "changed" : "granted"} ${member.user.tag} to ${panelAccessLabel(level)}${expiresAt ? ` until ${expiresAt}` : ""}.`,
      actor: ctx.message.author.tag
    }).catch(() => {});

    await ctx.message.reply(`${existingActiveUser ? "Changed" : "Granted"} ${member.user.tag} to ${panelAccessLabel(level)}${expiresAt ? ` until <t:${Math.floor(Date.parse(expiresAt) / 1000)}:R>` : ""} and sent them a DM.`);
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
      `Invite link: https://discord.com/oauth2/authorize?client_id=${ctx.clientId}&permissions=361048837200&scope=bot%20applications.commands`
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
  aliases: ["serverinfo", "membercount", "members", "guildcount", "serverstats", "servericon", "guildicon", "icon", "serverbanner", "guildbanner", "banner"],
  category: "Info",
  description: "Show server details.",
  async run(ctx) {
    const guild = ctx.message.guild;
    const humans = guild.members.cache.filter((member) => !member.user.bot).size;
    const bots = guild.members.cache.filter((member) => member.user.bot).size;
    const snapshot = communitySnapshot(ctx.config);
    const iconUrl = guild.iconURL({ size: 1024 });
    const bannerUrl = guild.bannerURL({ size: 2048 });
    await ctx.message.reply(
      [
        `**${guild.name}**`,
        `Members: ${guild.memberCount}`,
        `Humans: ${humans}`,
        `Bots: ${bots}`,
        `Channels: ${guild.channels.cache.size}`,
        `Roles: ${guild.roles.cache.size}`,
        `Created: <t:${Math.floor(guild.createdTimestamp / 1000)}:D>`,
        `Commands Run: ${snapshot.commandsRun}`,
        `AI Replies: ${snapshot.aiReplies}`,
        iconUrl ? `Icon: ${iconUrl}` : "Icon: none set",
        bannerUrl ? `Banner: ${bannerUrl}` : "Banner: none set"
      ].join("\n")
    );
  }
});

define({
  name: "user",
  aliases: ["userinfo", "joined", "joindate", "joinedat"],
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
  aliases: ["roleinfo", "role", "roledata"],
  category: "Info",
  description: "List server roles or inspect a mentioned role.",
  usage: "roles [@role]",
  async run(ctx) {
    const role = mentionRole(ctx.message);
    if (role) {
      await ctx.message.reply([
        `**Role Info: ${role.name}**`,
        `ID: \`${role.id}\``,
        `Members: **${role.members.size}**`,
        `Color: \`${role.hexColor}\``,
        `Mentionable: **${role.mentionable ? "Yes" : "No"}**`,
        `Hoisted: **${role.hoist ? "Yes" : "No"}**`
      ].join("\n"));
      return;
    }

    const roles = ctx.message.guild.roles.cache
      .filter((entry) => entry.name !== "@everyone")
      .sort((a, b) => b.position - a.position)
      .map((entry) => entry.name)
      .slice(0, 50)
      .join(", ");
    await ctx.message.reply(roles || "No roles found.");
  }
});

define({
  name: "channels",
  aliases: ["channelinfo", "channel", "channeldata"],
  category: "Info",
  description: "List text channels or inspect one channel.",
  usage: "channels [#channel]",
  async run(ctx) {
    if (ctx.message.mentions.channels.size || ctx.args[0]) {
      const channel = targetTextChannel(ctx.message);
      await ctx.message.reply([
        `**Channel Info: #${channel.name}**`,
        `ID: \`${channel.id}\``,
        `Type: **${channel.type}**`,
        `NSFW: **${channel.nsfw ? "Yes" : "No"}**`,
        `Topic: ${channel.topic || "No topic set."}`
      ].join("\n"));
      return;
    }

    const channels = ctx.message.guild.channels.cache
      .filter((channel) => channel.isTextBased())
      .map((channel) => `#${channel.name}`)
      .slice(0, 50)
      .join(", ");
    await ctx.message.reply(channels || "No text channels found.");
  }
});

define({
  name: "fun",
  aliases: ["coinflip", "coin", "roll", "dice", "choose", "8ball", "rate", "curse", "ship", "randommember", "pickmember", "memberroulette"],
  category: "Fun",
  description: "Run the random Chipkittle fun tools from one command hub.",
  usage: "fun [coin|roll|choose|8ball|rate|curse|ship|member] ...",
  async run(ctx) {
    const invoked = (ctx.invokedName || ctx.command.name).toLowerCase();
    const explicitMode = (ctx.args[0] || "").toLowerCase();
    const mode = (
      ["coinflip", "coin", "roll", "dice", "choose", "8ball", "rate", "curse", "ship", "randommember", "pickmember", "memberroulette"].includes(invoked)
        ? invoked
        : explicitMode
    );

    if (mode === "coinflip" || mode === "coin") {
      await ctx.message.reply(Math.random() > 0.5 ? "Heads." : "Tails.");
      return;
    }

    if (mode === "roll" || mode === "dice") {
      const dice = (["roll", "dice"].includes(invoked) ? ctx.args[0] : ctx.args[1]) || "1d6";
      const match = dice.match(/^(\d{1,2})d(\d{1,4})$/i);
      if (!match) {
        await ctx.message.reply(`Usage: \`${ctx.config.prefix}fun roll 2d20\``);
        return;
      }
      const count = Math.min(Number(match[1]), 20);
      const sides = Math.min(Number(match[2]), 1000);
      const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
      await ctx.message.reply(`Rolled ${dice}: ${rolls.join(", ")} = **${rolls.reduce((a, b) => a + b, 0)}**`);
      return;
    }

    if (mode === "choose") {
      const source = invoked === "choose" ? ctx.rest : ctx.args.slice(1).join(" ");
      const options = source.split(",").map((item) => item.trim()).filter(Boolean);
      if (options.length < 2) {
        await ctx.message.reply(`Usage: \`${ctx.config.prefix}fun choose pizza, tacos, soup\``);
        return;
      }
      await ctx.message.reply(`I choose: **${options[Math.floor(Math.random() * options.length)]}**.`);
      return;
    }

    if (mode === "8ball") {
      await ctx.message.reply(eightBallAnswers[Math.floor(Math.random() * eightBallAnswers.length)]);
      return;
    }

    if (mode === "rate") {
      const thing = safeContent(invoked === "rate" ? ctx.rest : ctx.args.slice(1).join(" "), "that");
      const score = Math.floor(Math.random() * 101);
      await ctx.message.reply(`${thing} is ${score}/100 on the artifact scale.`);
      return;
    }

    if (mode === "curse") {
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
      return;
    }

    if (mode === "ship") {
      const users = [...ctx.message.mentions.users.values()];
      const first = users[0]?.username || ctx.message.author.username;
      const second = users[1]?.username || (invoked === "ship" ? ctx.args.join(" ") : ctx.args.slice(1).join(" ")) || "the ancient artifact";
      await ctx.message.reply(`${first} + ${second}: ${Math.floor(Math.random() * 101)}% Chipkittle harmony.`);
      return;
    }

    if (mode === "randommember" || mode === "pickmember" || mode === "memberroulette" || mode === "member") {
      const role = mentionRole(ctx.message);
      const pool = role
        ? [...role.members.values()].filter((member) => !member.user.bot)
        : ctx.message.guild.members.cache.filter((member) => !member.user.bot).map((member) => member);
      if (!pool.length) {
        await ctx.message.reply("No eligible members were found for that pick.");
        return;
      }
      const winner = pool[randomInt(0, pool.length - 1)];
      await ctx.message.reply(role ? `Random pick from **${role.name}**: ${winner}` : `Random member: ${winner}`);
      return;
    }

    await ctx.message.reply(`Usage: \`${ctx.config.prefix}fun [coin|roll|choose|8ball|rate|curse|ship|member]\``);
  }
});



define({
  name: "date",
  aliases: ["dateaccept", "datedeny", "datebreak", "datehelp", "dateinfo", "kiss", "hug", "holdhands", "sex", "cheat", "homewreck", "tickle", "creampie", "drug"],
  category: "Dating",
  description: "Manage Chipkittle dating, status, and relationship interactions.",
  usage: "date [@user|accept|deny|status|break|help|kiss|hug|holdhands|sex|cheat|homewreck|tickle|creampie|drug] ...",
  async run(ctx) {
    const invoked = (ctx.invokedName || ctx.command.name).toLowerCase();
    const explicitMode = (ctx.args[0] || "").toLowerCase();
    const mode = (
      ["dateaccept", "datedeny", "datebreak", "datehelp", "dateinfo", "kiss", "hug", "holdhands", "sex", "cheat", "homewreck", "tickle", "creampie", "drug"].includes(invoked)
        ? invoked
        : explicitMode
    );

    if (mode === "datehelp" || mode === "help") {
      const lines = [
        `${ctx.config.prefix}date @user`,
        `${ctx.config.prefix}date accept`,
        `${ctx.config.prefix}date deny`,
        `${ctx.config.prefix}date status`,
        `${ctx.config.prefix}date break`,
        `${ctx.config.prefix}date kiss @user`,
        `${ctx.config.prefix}date hug @user`,
        `${ctx.config.prefix}date holdhands @user`,
        `${ctx.config.prefix}date sex @user`,
        `${ctx.config.prefix}date cheat @user`,
        `${ctx.config.prefix}date homewreck @user`,
        `${ctx.config.prefix}date tickle @user`,
        `${ctx.config.prefix}date creampie @user`,
        `${ctx.config.prefix}date drug @user`
      ];
      const embed = new EmbedBuilder()
        .setTitle("Date Commands")
        .setDescription("Use the dating hub for requests, relationship status, and chaotic romance actions.")
        .addFields([{ name: "Available", value: lines.join("\n"), inline: false }])
        .setColor(0x99ccff);
      await ctx.message.reply({ embeds: [embed], allowedMentions: NO_MENTIONS });
      return;
    }

    if (mode === "dateaccept" || mode === "accept") {
      const recipient = ctx.message.author;
      const key = pendingDateKey(ctx.message.guild.id, recipient.id);
      const request = pendingDateRequests.get(key);
      if (!request) {
        const embed = new EmbedBuilder().setTitle("No Date Request").setDescription("You do not have any pending date invitations.").setColor(0xffcc99);
        await ctx.message.reply({ embeds: [embed], allowedMentions: NO_MENTIONS });
        return;
      }
      if (isUserDating(recipient.id)) {
        pendingDateRequests.delete(key);
        const embed = new EmbedBuilder().setTitle("Already Dating").setDescription("You are already dating someone else, so this invitation cannot be accepted.").setColor(0xffcc99);
        await ctx.message.reply({ embeds: [embed], allowedMentions: NO_MENTIONS });
        return;
      }
      if (isUserDating(request.requesterId)) {
        pendingDateRequests.delete(key);
        const embed = new EmbedBuilder().setTitle("Requester Already Dating").setDescription(`${request.requesterMention} is already dating someone else, so this invitation cannot be accepted.`).setColor(0xffcc99);
        await ctx.message.reply({ embeds: [embed], allowedMentions: NO_MENTIONS });
        return;
      }
      pendingDateRequests.delete(key);
      currentDates.set(recipient.id, request.requesterId);
      currentDates.set(request.requesterId, recipient.id);
      const embed = new EmbedBuilder().setTitle("Date Accepted").setDescription(`${recipient} accepted ${request.requesterMention}'s date invitation. You are now officially dating.`).setColor(0x99ffcc);
      await ctx.message.channel.send({ embeds: [embed], allowedMentions: NO_MENTIONS });
      return;
    }

    if (mode === "datedeny" || mode === "deny") {
      const recipient = ctx.message.author;
      const key = pendingDateKey(ctx.message.guild.id, recipient.id);
      const request = pendingDateRequests.get(key);
      if (!request) {
        const embed = new EmbedBuilder().setTitle("No Date Request").setDescription("You do not have any pending date invitations.").setColor(0xffcc99);
        await ctx.message.reply({ embeds: [embed], allowedMentions: NO_MENTIONS });
        return;
      }
      pendingDateRequests.delete(key);
      const embed = new EmbedBuilder().setTitle("Date Denied").setDescription(`${recipient} declined ${request.requesterMention}'s date invitation. Maybe the artifact will bless someone else.`).setColor(0xff6666);
      await ctx.message.channel.send({ embeds: [embed], allowedMentions: NO_MENTIONS });
      return;
    }

    if (mode === "datebreak" || mode === "break") {
      const requester = ctx.message.author;
      const partnerId = currentDatePartner(requester.id);
      if (!partnerId) {
        const embed = new EmbedBuilder().setTitle("No Relationship").setDescription("You are not currently dating anyone.").setColor(0xffcc99);
        await ctx.message.reply({ embeds: [embed], allowedMentions: NO_MENTIONS });
        return;
      }
      clearDatePair(requester.id);
      const embed = new EmbedBuilder().setTitle("Date Broken").setDescription(`${requester} has ended their dating relationship with <@${partnerId}>. The ceremony is over.`).setColor(0xff9999);
      await ctx.message.channel.send({ embeds: [embed], allowedMentions: NO_MENTIONS });
      return;
    }

    if (mode === "dateinfo" || mode === "status") {
      const requester = ctx.message.author;
      const partnerId = currentDatePartner(requester.id);
      const embed = new EmbedBuilder()
        .setTitle("Dating Status")
        .setDescription(partnerId ? `You are dating <@${partnerId}>.` : "You are not currently dating anyone.")
        .setColor(partnerId ? 0x99ffcc : 0xffcc99);
      await ctx.message.reply({ embeds: [embed], allowedMentions: NO_MENTIONS });
      return;
    }

    if (["kiss", "hug", "holdhands", "sex", "cheat", "homewreck", "tickle", "creampie", "drug"].includes(mode)) {
      const mentions = [...ctx.message.mentions.users.values()];
      const requester = ctx.message.author;
      const target = mentions[0];
      if (!target) {
        await ctx.message.reply(`Usage: \`${ctx.config.prefix}date ${mode} @user\``);
        return;
      }
      if (target.id === requester.id) {
        await ctx.message.reply(`You cannot ${mode === "holdhands" ? "hold hands with" : mode} yourself.`);
        return;
      }
      if (target.bot) {
        await ctx.message.reply("Bots are not part of Chipkittle romance.");
        return;
      }
      const modeEmbeds = {
        kiss: ["Sweet Kiss", `${requester} gives ${target} a gentle Chipkittle kiss. Romance is in the air.`, 0xff99cc],
        hug: ["Warm Hug", `${requester} wraps ${target} in a comforting Chipkittle hug. Cozy vibes all around.`, 0x99ccff],
        holdhands: ["Hand Holding", `${requester} takes ${target}'s hand and walks in silent Chipkittle solidarity.`, 0xccaaff],
        sex: ["Hot Chipkittle Moment", `${requester} and ${target} shared a very intimate Chipkittle moment. Keep it spicy.`, 0xff3399],
        tickle: ["Tickled", `${requester} tickled ${target} until they started giggling.`, 0xf9a8d4],
        creampie: ["Tiny Chipkittle Created", `${requester} and ${target} somehow produced a tiny Chipkittle named **${randomChipkittleName()}**.`, 0xfda4af],
        drug: ["Questionable Decisions", `${target} has been drugged with ${["caffeine", "weed", "sugar", "bread", "shrooms", "chocolate"].sort(() => Math.random() - 0.5).slice(0, 2).join(" and ")}.`, 0xc4b5fd]
      };
      if (mode === "cheat") {
        if (!isUserDating(requester.id)) {
          await ctx.message.reply("You are not currently dating anyone.");
          return;
        }
        const partnerId = currentDatePartner(requester.id);
        const embed = new EmbedBuilder().setTitle("Cheating Scandal").setDescription(`${requester} cheated on <@${partnerId}> with ${target}. The artifact is watching.`).setColor(0xff3366);
        await ctx.message.channel.send({ embeds: [embed], allowedMentions: NO_MENTIONS });
        return;
      }
      if (mode === "homewreck") {
        if (!isUserDating(target.id)) {
          await ctx.message.reply(`${target} is not in a relationship.`);
          return;
        }
        const partnerId = currentDatePartner(target.id);
        const embed = new EmbedBuilder().setTitle("Homewrecking Scandal").setDescription(`${requester} homewrecked ${target}'s relationship with <@${partnerId}> in a steamy Chipkittle moment. Drama ensues.`).setColor(0xff3366);
        await ctx.message.channel.send({ embeds: [embed], allowedMentions: NO_MENTIONS });
        return;
      }
      const [title, description, color] = modeEmbeds[mode];
      const embed = new EmbedBuilder().setTitle(title).setDescription(description).setColor(color);
      await ctx.message.channel.send({ embeds: [embed], allowedMentions: NO_MENTIONS });
      return;
    }

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
  aliases: ["balance", "bal", "wallet", "breadstats", "breadinfo", "walletstats", "breadcompare", "comparebread", "walletcompare"],
  category: "Gambling",
  description: "Check bread balances, wallet stats, or compare two members.",
  usage: "bread [@user|@user @user]",
  async run(ctx) {
    const economy = normalizeEconomy(ctx.store.getGuild(ctx.message.guild.id).economy);
    const invoked = (ctx.invokedName || ctx.command.name).toLowerCase();
    const mentions = [...ctx.message.mentions.members.values()];

    if (
      ["breadcompare", "comparebread", "walletcompare"].includes(invoked) ||
      mentions.length >= 2
    ) {
      const [first, second] = mentions.slice(0, 2);
      if (!first || !second) {
        await ctx.message.reply(`Usage: \`${ctx.config.prefix}breadcompare @user @user\``);
        return;
      }
      const firstBalance = breadBalance(economy, first.id);
      const secondBalance = breadBalance(economy, second.id);
      const firstBank = bankBalance(economy, first.id);
      const secondBank = bankBalance(economy, second.id);
      const firstTotal = firstBalance + firstBank;
      const secondTotal = secondBalance + secondBank;
      const diff = Math.abs(firstTotal - secondTotal);
      const winner = firstTotal === secondTotal ? null : firstTotal > secondTotal ? first : second;
      await ctx.message.reply([
        `**Bread Comparison**`,
        `${first.displayName}: **${formatBread(firstTotal)}** (${formatBread(firstBalance)} wallet, ${formatBread(firstBank)} bank)`,
        `${second.displayName}: **${formatBread(secondTotal)}** (${formatBread(secondBalance)} wallet, ${formatBread(secondBank)} bank)`,
        winner ? `Lead: **${winner.displayName}** by **${formatBread(diff)}**` : "They are perfectly tied."
      ].join("\n"));
      return;
    }

    const targetMember = mentionTargetUser(ctx.message);
    const targetId = targetMember.id;
    const balance = breadBalance(economy, targetId);
    const bank = bankBalance(economy, targetId);
    const stats = economyStatsFor(economy, targetId);
    const ids = new Set([
      ...Object.keys(economy.balances || {}),
      ...Object.keys(economy.bankBalances || {})
    ]);
    const sorted = [...ids]
      .map((userId) => [userId, totalBreadWealth(economy, userId)])
      .sort((a, b) => b[1] - a[1]);
    const rank = sorted.findIndex(([userId]) => userId === targetId);
    const lastClaim = new Date(economy.dailyClaims?.[targetId] || 0).getTime();
    const remaining = DAILY_COOLDOWN_MS - (Date.now() - lastClaim);
    await ctx.message.reply([
      `**${targetMember.displayName}'s Bread Wallet**`,
      `Wallet: **${formatBread(balance)}**`,
      `Bank: **${formatBread(bank)}**`,
      `Net worth: **${formatBread(balance + bank)}**`,
      `Wealth rank: **${rank === -1 ? "Unranked" : `#${rank + 1}`}**`,
      `Daily bread: ${remaining > 0 ? `ready in **${formatCooldown(remaining)}**` : "**ready now**"}`,
      `Games: **${stats.gamesPlayed.toLocaleString()}** played, **${stats.gamesWon.toLocaleString()}** wins`,
      `Wagered: **${formatBread(stats.wagered)}**`,
      `Profit: **${formatNetBread(stats.profit)}**`,
      `Biggest win: **${formatBread(stats.biggestWin)}**`
    ].join("\n"));
  }
});

define({
  name: "dailybread",
  aliases: ["daily", "breadclaim", "dailystatus", "dailycheck", "dailyinfo"],
  category: "Gambling",
  description: "Claim free daily bread.",
  async run(ctx) {
    const output = await updateBreadEconomy(ctx, async (economy) => {
      const userId = ctx.message.author.id;
      const settings = economySettings(economy);
      const lastClaim = new Date(economy.dailyClaims[userId] || 0).getTime();
      const remaining = DAILY_COOLDOWN_MS - (Date.now() - lastClaim);
      if (remaining > 0) {
        return `You already claimed daily bread. Try again in ${formatCooldown(remaining)}.`;
      }

      const previousStreak = Math.max(Math.floor(Number(economy.dailyStreaks?.[userId]?.streak) || 0), 0);
      const streak = lastClaim && Date.now() - lastClaim <= DAILY_COOLDOWN_MS * 2.2 ? previousStreak + 1 : 1;
      const bonus = randomInt(0, 150);
      const upgradeBonus = dailyBonusFor(economy, userId);
      const streakBonus = Math.min(streak * 25, dailyStreakCapFor(economy, userId));
      const amount = settings.dailyBread + bonus + streakBonus + upgradeBonus;
      const nextBalance = breadBalance(economy, userId) + amount;
      economy.dailyClaims[userId] = new Date().toISOString();
      economy.dailyStreaks[userId] = {
        streak,
        lastClaimedAt: economy.dailyClaims[userId]
      };
      setBreadBalance(economy, userId, nextBalance);
      recordEconomyTransaction(economy, {
        userId,
        type: "daily",
        amount,
        streak,
        balance: nextBalance
      });
      return [
        `You claimed **${formatBread(amount)}**.`,
        `Daily base: **${formatBread(settings.dailyBread)}** | random bonus: **${formatBread(bonus)}** | streak bonus: **${formatBread(streakBonus)}** | upgrade bonus: **${formatBread(upgradeBonus)}**`,
        `Streak: **${streak} day${streak === 1 ? "" : "s"}**`,
        `Wallet: **${formatBread(nextBalance)}**.`
      ].join("\n");
    });

    await ctx.message.reply(output);
  }
});

define({
  name: "claimdash",
  aliases: ["dashclaim", "claimbread"],
  category: "Gambling",
  description: "Claim bread collected in Chipkittle browser games.",
  usage: "claimdash CK123ABC",
  async run(ctx) {
    const code = ctx.args[0];
    const output = await updateBreadEconomy(ctx, async (economy) => {
      const claim = redeemDashClaim({
        code,
        guildId: ctx.message.guild.id,
        userId: ctx.message.author.id
      });

      if (!claim.ok) return claim.error;

      const userId = ctx.message.author.id;
      const nextBalance = breadBalance(economy, userId) + claim.bread;
      setBreadBalance(economy, userId, nextBalance);
      recordEconomyTransaction(economy, {
        userId,
        type: "game-claim",
        amount: claim.bread,
        score: claim.score,
        balance: nextBalance
      });

      return [
        `Claimed **${formatBread(claim.bread)}** from a Chipkittle game.`,
        `Run score: **${claim.score.toLocaleString()}**.`,
        `Balance: **${formatBread(nextBalance)}**.`
      ].join("\n");
    });

    await ctx.message.reply(output);
  }
});

define({
  name: "bank",
  aliases: ["vault", "breadbank", "networth"],
  category: "Gambling",
  description: "Show your wallet, bank, and total bread net worth.",
  usage: "bank [@user]",
  async run(ctx) {
    const economy = normalizeEconomy(ctx.store.getGuild(ctx.message.guild.id).economy);
    const target = mentionTargetUser(ctx.message);
    const wallet = breadBalance(economy, target.id);
    const bank = bankBalance(economy, target.id);
    const interest = Math.min(Math.floor(bank * interestRateFor(economy, target.id)), maxInterestFor(economy, target.id));
    const cooldown = persistentCooldownStatus(economy, "interest", target.id, interestCooldownFor(economy, target.id));
    const ownedUpgrades = Object.values(userUpgrades(economy, target.id)).reduce((sum, level) => sum + Math.max(Number(level) || 0, 0), 0);
    const loan = activeLoan(economy, target.id);
    await ctx.message.reply([
      `**${target.displayName}'s Bread Bank**`,
      `Wallet: **${formatBread(wallet)}**`,
      `Bank: **${formatBread(bank)}**`,
      `Net worth: **${formatBread(wallet + bank)}**`,
      loan ? `Loan debt: **${formatBread(loan.owed)}** due ${new Date(loan.dueAt).getTime() < Date.now() ? "**now**" : `<t:${Math.floor(new Date(loan.dueAt).getTime() / 1000)}:R>`}` : "Loan debt: **none**",
      `Interest rate: **${(interestRateFor(economy, target.id) * 100).toFixed(2)}%**`,
      `Next interest: **${formatBread(interest)}**`,
      `Interest status: ${cooldown.limited ? `ready in **${formatCooldown(cooldown.remainingMs)}**` : "**ready now**"}`,
      `Upgrade levels owned: **${ownedUpgrades}**`
    ].join("\n"));
  }
});

define({
  name: "deposit",
  aliases: ["dep", "bankdeposit"],
  category: "Gambling",
  description: "Move bread from your wallet into the bank.",
  usage: "deposit 500|half|all",
  async run(ctx) {
    const output = await updateBreadEconomy(ctx, async (economy) => {
      const userId = ctx.message.author.id;
      const wallet = breadBalance(economy, userId);
      const amount = parseBreadAmount(ctx.args[0], wallet, wallet);
      if (!amount || amount < 1) return `Usage: \`${usage(ctx.config, this)}\``;
      if (amount > wallet) return `You only have ${formatBread(wallet)} in your wallet.`;
      setBreadBalance(economy, userId, wallet - amount);
      setBankBalance(economy, userId, bankBalance(economy, userId) + amount);
      recordEconomyTransaction(economy, {
        userId,
        type: "deposit",
        amount,
        balance: breadBalance(economy, userId),
        bank: bankBalance(economy, userId)
      });
      return [
        `Deposited **${formatBread(amount)}**.`,
        `Wallet: **${formatBread(breadBalance(economy, userId))}**`,
        `Bank: **${formatBread(bankBalance(economy, userId))}**`
      ].join("\n");
    });
    await ctx.message.reply(output);
  }
});

define({
  name: "withdraw",
  aliases: ["with", "bankwithdraw"],
  category: "Gambling",
  description: "Move bread from your bank into your wallet.",
  usage: "withdraw 500|half|all",
  async run(ctx) {
    const output = await updateBreadEconomy(ctx, async (economy) => {
      const userId = ctx.message.author.id;
      const bank = bankBalance(economy, userId);
      const amount = parseBreadAmount(ctx.args[0], bank, bank);
      if (!amount || amount < 1) return `Usage: \`${usage(ctx.config, this)}\``;
      if (amount > bank) return `You only have ${formatBread(bank)} in the bank.`;
      setBankBalance(economy, userId, bank - amount);
      setBreadBalance(economy, userId, breadBalance(economy, userId) + amount);
      recordEconomyTransaction(economy, {
        userId,
        type: "withdraw",
        amount,
        balance: breadBalance(economy, userId),
        bank: bankBalance(economy, userId)
      });
      return [
        `Withdrew **${formatBread(amount)}**.`,
        `Wallet: **${formatBread(breadBalance(economy, userId))}**`,
        `Bank: **${formatBread(bankBalance(economy, userId))}**`
      ].join("\n");
    });
    await ctx.message.reply(output);
  }
});

define({
  name: "interest",
  aliases: ["bankinterest", "collectinterest"],
  category: "Gambling",
  description: "Collect bank interest once per cycle.",
  async run(ctx) {
    const output = await updateBreadEconomy(ctx, async (economy) => {
      const userId = ctx.message.author.id;
      const cooldown = persistentCooldownStatus(economy, "interest", userId, interestCooldownFor(economy, userId));
      if (cooldown.limited) return `Bank interest will be ready in ${formatCooldown(cooldown.remainingMs)}.`;
      const bank = bankBalance(economy, userId);
      if (bank < 100) return "You need at least 100 bread in the bank before it earns interest.";
      const amount = Math.min(Math.floor(bank * interestRateFor(economy, userId)), maxInterestFor(economy, userId));
      if (amount < 1) return "Your bank balance is too low to generate interest yet.";
      setPersistentCooldown(economy, "interest", userId);
      setBankBalance(economy, userId, bank + amount);
      recordEconomyTransaction(economy, {
        userId,
        type: "interest",
        amount,
        bank: bankBalance(economy, userId),
        balance: breadBalance(economy, userId)
      });
      return [
        `Collected **${formatBread(amount)}** in bank interest.`,
        `Bank: **${formatBread(bankBalance(economy, userId))}**`,
        `Net worth: **${formatBread(totalBreadWealth(economy, userId))}**`
      ].join("\n");
    });
    await ctx.message.reply(output);
  }
});

define({
  name: "loan",
  aliases: ["borrow", "repayloan", "payloan", "loans", "debt"],
  category: "Gambling",
  description: "Borrow bread, repay debt, or check loan shark pressure.",
  usage: "loan [status|take|pay] [amount]",
  async run(ctx) {
    const invoked = (ctx.invokedName || ctx.command.name).toLowerCase();
    const action = invoked === "borrow" ? "take" : ["repayloan", "payloan"].includes(invoked) ? "pay" : String(ctx.args[0] || "status").toLowerCase();
    const amountInput = invoked === "borrow" || ["repayloan", "payloan"].includes(invoked) ? ctx.args[0] : ["take", "borrow", "pay", "repay"].includes(action) ? ctx.args[1] : ctx.args[0];

    const output = await updateBreadEconomy(ctx, async (economy) => {
      const userId = ctx.message.author.id;
      const currentLoan = activeLoan(economy, userId);
      const maxLoan = maxLoanAmount(economy, userId);

      if (["status", "info", "debt"].includes(action)) {
        if (!currentLoan) {
          return [
            `**Bread Loan Office**`,
            `You do not have an active loan.`,
            `Available credit: **${formatBread(maxLoan)}**`,
            `Borrow with \`${ctx.config.prefix}loan take amount\`. Pay with \`${ctx.config.prefix}loan pay amount\`.`,
            `Loans are due after **1 hour**. After that, interest and loan shark visits begin, but debt caps at **${LOAN_MAX_DEBT_MULTIPLIER}x** the original loan.`
          ].join("\n");
        }
        const dueMs = Date.parse(currentLoan.dueAt);
        const overdueMs = Date.now() - dueMs;
        return [
          `**Bread Loan Office**`,
          `Principal: **${formatBread(currentLoan.principal)}**`,
          `Current debt: **${formatBread(currentLoan.owed)}**`,
          `Debt cap: **${formatBread(maxLoanDebt(currentLoan))}**`,
          `Due: ${overdueMs > 0 ? `**overdue by ${formatCooldown(overdueMs)}**` : `<t:${Math.floor(dueMs / 1000)}:R>`}`,
          `Loan shark strikes: **${currentLoan.strikes}**`,
          `Wallet: **${formatBread(breadBalance(economy, userId))}** | Bank: **${formatBread(bankBalance(economy, userId))}**`
        ].join("\n");
      }

      if (["take", "borrow"].includes(action)) {
        if (currentLoan) return `You already owe **${formatBread(currentLoan.owed)}**. Pay it off before borrowing again.`;
        const amount = parseBreadAmount(amountInput, maxLoan, maxLoan);
        if (!amount || amount < 100) return `Borrow at least **100 bread**. Your current max loan is **${formatBread(maxLoan)}**.`;
        if (amount > maxLoan) return `Your current max loan is **${formatBread(maxLoan)}**.`;
        const now = new Date();
        const dueAt = new Date(now.getTime() + LOAN_GRACE_MS);
        setBreadBalance(economy, userId, breadBalance(economy, userId) + amount);
        setLoan(economy, userId, {
          principal: amount,
          owed: amount,
          borrowedAt: now.toISOString(),
          dueAt: dueAt.toISOString(),
          lastInterestAt: dueAt.toISOString(),
          lastPenaltyAt: dueAt.toISOString(),
          strikes: 0,
          status: "active"
        });
        recordEconomyTransaction(economy, {
          userId,
          type: "loan-borrow",
          amount,
          owed: amount,
          balance: breadBalance(economy, userId)
        });
        return [
          `**Loan approved.**`,
          `Borrowed: **${formatBread(amount)}**`,
          `Due: <t:${Math.floor(dueAt.getTime() / 1000)}:R>`,
          `Debt cap: **${formatBread(amount * LOAN_MAX_DEBT_MULTIPLIER)}**`,
          `Wallet: **${formatBread(breadBalance(economy, userId))}**`,
          `Pay it back with \`${ctx.config.prefix}loan pay amount\`. After 1 hour, the loan sharks start adding interest and taking bread.`
        ].join("\n");
      }

      if (["pay", "repay"].includes(action)) {
        if (!currentLoan) return "You do not have an active loan to repay.";
        const available = totalBreadWealth(economy, userId);
        const amount = parseBreadAmount(amountInput, Math.min(available, currentLoan.owed), Math.min(available, currentLoan.owed));
        if (!amount || amount < 1) return `Usage: \`${usage(ctx.config, ctx.command)}\``;
        if (amount > available) return `You only have **${formatBread(available)}** between wallet and bank.`;
        let remainingPayment = amount;
        const wallet = breadBalance(economy, userId);
        const fromWallet = Math.min(wallet, remainingPayment);
        setBreadBalance(economy, userId, wallet - fromWallet);
        remainingPayment -= fromWallet;
        if (remainingPayment > 0) {
          setBankBalance(economy, userId, bankBalance(economy, userId) - remainingPayment);
        }
        currentLoan.owed = Math.max(currentLoan.owed - amount, 0);
        recordEconomyTransaction(economy, {
          userId,
          type: "loan-pay",
          amount: -amount,
          owed: currentLoan.owed,
          balance: breadBalance(economy, userId),
          bank: bankBalance(economy, userId)
        });
        if (currentLoan.owed <= 0) {
          setLoan(economy, userId, {
            ...currentLoan,
            owed: 0,
            paidAt: new Date().toISOString(),
            status: "paid"
          });
          return [
            `**Loan paid off.**`,
            `Paid: **${formatBread(amount)}**`,
            `The loan sharks have been told to stop looking at you.`,
            `Wallet: **${formatBread(breadBalance(economy, userId))}** | Bank: **${formatBread(bankBalance(economy, userId))}**`
          ].join("\n");
        }
        setLoan(economy, userId, currentLoan);
        return [
          `Paid **${formatBread(amount)}** toward your loan.`,
          `Remaining debt: **${formatBread(currentLoan.owed)}**`,
          `Wallet: **${formatBread(breadBalance(economy, userId))}** | Bank: **${formatBread(bankBalance(economy, userId))}**`
        ].join("\n");
      }

      return `Usage: \`${usage(ctx.config, ctx.command)}\``;
    });

    await ctx.message.reply(output);
  }
});

define({
  name: "upgrades",
  aliases: ["breadupgrades", "economyupgrades"],
  category: "Gambling",
  description: "Browse bread economy upgrades and your current levels.",
  usage: "upgrades [@user]",
  async run(ctx) {
    const economy = normalizeEconomy(ctx.store.getGuild(ctx.message.guild.id).economy);
    const target = mentionTargetUser(ctx.message);
    const lines = ECONOMY_UPGRADES.map((upgrade) => {
      const level = upgradeLevel(economy, target.id, upgrade.id);
      const maxed = level >= upgrade.maxLevel;
      const nextCost = maxed ? "maxed" : formatBread(upgradeCost(upgrade, level, economy));
      return `**${upgrade.name}** \`${upgrade.id}\` - level **${level}/${upgrade.maxLevel}** - next: **${nextCost}**\n${upgrade.description}`;
    });
    await ctx.message.reply([
      `**${target.displayName}'s Bread Upgrades**`,
      ...lines,
      "",
      `Buy with \`${ctx.config.prefix}buyupgrade upgrade-id\`.`
    ].join("\n"));
  }
});

define({
  name: "buyupgrade",
  aliases: ["upgradebuy", "upgrade"],
  category: "Gambling",
  description: "Buy a bread economy upgrade.",
  usage: "buyupgrade upgrade-id",
  async run(ctx) {
    const upgradeId = cleanText(ctx.args[0], 80).toLowerCase();
    const upgrade = upgradeDefinition(upgradeId);
    if (!upgrade) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\`\nUse \`${ctx.config.prefix}upgrades\` to see upgrade IDs.`);
      return;
    }

    const output = await updateBreadEconomy(ctx, async (economy) => {
      const userId = ctx.message.author.id;
      const currentLevel = upgradeLevel(economy, userId, upgrade.id);
      if (currentLevel >= upgrade.maxLevel) return `**${upgrade.name}** is already maxed.`;
      const cost = upgradeCost(upgrade, currentLevel, economy);
      const wallet = breadBalance(economy, userId);
      if (wallet < cost) return `You need **${formatBread(cost)}** in your wallet to buy **${upgrade.name}**.`;
      setBreadBalance(economy, userId, wallet - cost);
      setUpgradeLevel(economy, userId, upgrade.id, currentLevel + 1);
      recordEconomyTransaction(economy, {
        userId,
        type: "upgrade",
        upgradeId: upgrade.id,
        upgradeName: upgrade.name,
        amount: -cost,
        balance: breadBalance(economy, userId),
        bank: bankBalance(economy, userId)
      });
      return [
        `Bought **${upgrade.name}** level **${currentLevel + 1}/${upgrade.maxLevel}** for **${formatBread(cost)}**.`,
        upgrade.description,
        `Wallet: **${formatBread(breadBalance(economy, userId))}**`
      ].join("\n");
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
      recordEconomyTransaction(economy, {
        userId: ctx.message.author.id,
        targetId: target.id,
        type: "transfer-out",
        amount: -amount,
        balance: breadBalance(economy, ctx.message.author.id)
      });
      recordEconomyTransaction(economy, {
        userId: target.id,
        sourceId: ctx.message.author.id,
        type: "transfer-in",
        amount,
        balance: breadBalance(economy, target.id)
      });
      return `Sent **${formatBread(amount)}** to **${target.username || target.tag}**.`;
    });

    await ctx.message.reply(output);
  }
});

define({
  name: "breadtop",
  aliases: ["breadleaderboard", "breadlb", "breadpoor", "poorbread", "breadbottom", "breadworth", "economyworth", "breadtotal"],
  category: "Gambling",
  description: "Show economy leaderboards or server-wide bread totals.",
  async run(ctx) {
    const economy = normalizeEconomy(ctx.store.getGuild(ctx.message.guild.id).economy);
    const invoked = (ctx.invokedName || ctx.command.name).toLowerCase();
    const ids = new Set([
      ...Object.keys(economy.balances || {}),
      ...Object.keys(economy.bankBalances || {})
    ]);
    const balances = [...ids]
      .map((userId) => [userId, breadBalance(economy, userId), bankBalance(economy, userId), totalBreadWealth(economy, userId)]);

    if (["breadworth", "economyworth", "breadtotal"].includes(invoked)) {
      const walletTotal = balances.reduce((sum, [, wallet]) => sum + wallet, 0);
      const bankTotal = balances.reduce((sum, [, , bank]) => sum + bank, 0);
      const total = walletTotal + bankTotal;
      const average = balances.length ? Math.floor(total / balances.length) : 0;
      await ctx.message.reply([
        `**Server Bread Economy**`,
        `Tracked accounts: **${balances.length}**`,
        `Wallet bread: **${formatBread(walletTotal)}**`,
        `Bank bread: **${formatBread(bankTotal)}**`,
        `Total net worth: **${formatBread(total)}**`,
        `Average net worth: **${formatBread(average)}**`
      ].join("\n"));
      return;
    }

    const ascending = ["breadpoor", "poorbread", "breadbottom"].includes(invoked);
    const entries = balances
      .sort((a, b) => ascending ? a[3] - b[3] : b[3] - a[3])
      .slice(0, 10);

    if (!entries.length) {
      await ctx.message.reply(ascending ? "Nobody has touched their bread balance yet." : "No bread accounts have moved yet. Claim daily bread and start baking.");
      return;
    }

    await ctx.message.reply([
      ascending ? `**Bread Poverty Index**` : `**Bread Leaderboard**`,
      entries
        .map(([userId, wallet, bank, total], index) => `${index + 1}. <@${userId}> - **${formatBread(total)}** (${formatBread(wallet)} wallet, ${formatBread(bank)} bank)`)
        .join("\n")
    ].join("\n"));
  }
});

define({
  name: "breadhistory",
  aliases: ["breadlog", "economylog"],
  category: "Gambling",
  description: "Show recent bread economy activity for yourself or another member.",
  usage: "breadhistory [@user]",
  async run(ctx) {
    const economy = normalizeEconomy(ctx.store.getGuild(ctx.message.guild.id).economy);
    const target = mentionTargetUser(ctx.message);
    const entries = (economy.transactions || [])
      .filter((entry) => entry.userId === target.id)
      .slice(-8)
      .reverse();

    if (!entries.length) {
      await ctx.message.reply(`${target.displayName} has no bread history yet.`);
      return;
    }

    const lines = entries.map((entry) => {
      const when = entry.createdAt ? `<t:${Math.floor(new Date(entry.createdAt).getTime() / 1000)}:R>` : "recently";
      if (entry.type === "gamble") {
        return `${when} - ${entry.game || "Gambling"}: bet **${formatBread(entry.bet || 0)}**, net **${formatNetBread(entry.net || 0)}**`;
      }
      if (entry.type === "daily") return `${when} - Daily claim: **+${formatBread(entry.amount || 0)}**`;
      if (entry.type === "game-claim") return `${when} - Website game claim: **+${formatBread(entry.amount || 0)}**`;
      if (entry.type === "deposit") return `${when} - Deposit: **${formatBread(entry.amount || 0)}** into bank`;
      if (entry.type === "withdraw") return `${when} - Withdrawal: **${formatBread(entry.amount || 0)}** to wallet`;
      if (entry.type === "interest") return `${when} - Bank interest: **+${formatBread(entry.amount || 0)}**`;
      if (entry.type === "upgrade") return `${when} - Bought upgrade **${entry.upgradeName || entry.upgradeId || "unknown"}** for **${formatBread(Math.abs(entry.amount || 0))}**`;
      if (entry.type === "loan-borrow") return `${when} - Loan borrowed: **+${formatBread(entry.amount || 0)}**, owed **${formatBread(entry.owed || 0)}**`;
      if (entry.type === "loan-pay") return `${when} - Loan payment: **${formatBread(Math.abs(entry.amount || 0))}**, owed **${formatBread(entry.owed || 0)}**`;
      if (entry.type === "loan-interest") return `${when} - Loan interest: **+${formatBread(entry.amount || 0)}**, owed **${formatBread(entry.owed || 0)}**`;
      if (entry.type === "loan-collection") return `${when} - Loan shark collection: **${formatBread(Math.abs(entry.amount || 0))}** taken, owed **${formatBread(entry.owed || 0)}**`;
      if (entry.type === "casino-robbery") return `${when} - Casino robbery: **${formatNetBread(entry.net || 0)}**`;
      if (entry.type === "admin-set") return `${when} - Staff set wallet to **${formatBread(entry.amount || 0)}**`;
      if (entry.type === "admin-add") return `${when} - Staff added **${formatBread(entry.amount || 0)}**`;
      if (entry.type === "admin-take") return `${when} - Staff removed **${formatBread(Math.abs(entry.amount || 0))}**`;
      if (entry.type === "transfer-in") return `${when} - Received **${formatBread(entry.amount || 0)}** from <@${entry.sourceId}>`;
      if (entry.type === "transfer-out") return `${when} - Sent **${formatBread(Math.abs(entry.amount || 0))}** to <@${entry.targetId}>`;
      return `${when} - ${entry.type || "bread"}: **${formatBread(entry.amount || entry.net || 0)}**`;
    });

    await ctx.message.reply([
      `**${target.displayName}'s Bread History**`,
      lines.join("\n")
    ].join("\n"));
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
  description: "Spin weighted bread slots with bigger artifact jackpots.",
  usage: "slots 100",
  async run(ctx) {
    const reels = [
      ["crumb", "crumb", "crumb", "loaf", "loaf", "horns", "suit", "ck", "artifact"],
      ["crumb", "crumb", "loaf", "loaf", "horns", "horns", "suit", "ck", "artifact"],
      ["crumb", "loaf", "loaf", "horns", "suit", "suit", "ck", "artifact", "artifact"]
    ];
    await runBreadBet(ctx, "Bread Slots", (bet) => {
      const spin = reels.map((reel) => reel[randomInt(0, reel.length - 1)]);
      const counts = spin.reduce((map, symbol) => ({ ...map, [symbol]: (map[symbol] || 0) + 1 }), {});
      const maxMatches = Math.max(...Object.values(counts));
      const pairSymbol = Object.entries(counts).find(([, count]) => count === 2)?.[0];
      const payout = spin.every((symbol) => symbol === "artifact")
        ? bet * 30
        : maxMatches === 3
          ? bet * (spin[0] === "ck" ? 12 : spin[0] === "suit" ? 8 : 5)
          : pairSymbol === "artifact"
            ? bet * 3
            : maxMatches === 2
              ? Math.floor(bet * 1.35)
              : spin.includes("artifact") && spin.includes("ck")
                ? Math.floor(bet * 1.1)
                : 0;
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
  description: "Bet dice against the house, or call over/under for better control.",
  usage: "breaddice 100 [over|under|exact] [number]",
  async run(ctx) {
    const mode = (ctx.args[1] || "duel").toLowerCase();
    const target = Number(ctx.args[2]);
    await runBreadBet(ctx, "Bread Dice", (bet) => {
      if (["over", "under"].includes(mode) && (!Number.isInteger(target) || target < 2 || target > 11)) {
        return {
          payout: bet,
          text: "Invalid dice target. Use a number from 2 to 11. Bet returned."
        };
      }
      if (mode === "exact" && (!Number.isInteger(target) || target < 2 || target > 12)) {
        return {
          payout: bet,
          text: "Invalid exact target. Use a number from 2 to 12. Bet returned."
        };
      }
      if (["over", "under", "exact"].includes(mode)) {
        const total = randomInt(1, 6) + randomInt(1, 6);
        const won = mode === "over" ? total > target : mode === "under" ? total < target : total === target;
        const payout = won ? Math.floor(bet * (mode === "exact" ? 8 : 1.9)) : 0;
        return {
          payout,
          text: `Roll total: **${total}**. You called **${mode} ${target}**. ${won ? "Clean hit." : "Miss."}`
        };
      }
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
      const label = (value) => value === 1 ? "A" : value === 11 ? "J" : value === 12 ? "Q" : value === 13 ? "K" : String(value);
      const distance = Math.abs(second - first);
      const payout = tied ? bet : won ? Math.floor(bet * (distance >= 7 ? 2.4 : distance >= 4 ? 2.1 : 1.8)) : 0;
      return {
        payout,
        text: `First card: **${label(first)}**. Next card: **${label(second)}**. ${tied ? "Tie, bet returned." : won ? `You called it with a ${distance}-rank gap.` : "Wrong call."}`
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
      const redNumbers = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
      const roll = randomInt(0, 36);
      const color = roll === 0 ? "green" : redNumbers.has(roll) ? "red" : "black";
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
  description: "Play interactive blackjack for bread with hit, stand, and double buttons.",
  usage: "blackjack 100",
  async run(ctx) {
    const userId = ctx.message.author.id;
    const sessionKey = `${ctx.message.guild.id}:${userId}`;
    if (blackjackSessions.has(sessionKey)) {
      await ctx.message.reply("You already have an active blackjack hand. Finish that one first.");
      return;
    }

    const session = await updateBreadEconomy(ctx, async (economy) => {
      const balance = breadBalance(economy, userId);
      const settings = economySettings(economy);
      const bet = validateBreadBet(ctx.args[0], balance, economy);
      if (!bet.ok) return { error: bet.error };
      const cooldown = persistentCooldownStatus(economy, "gambling", userId, settings.gamblingCooldownMs);
      if (cooldown.limited) {
        return { error: `Slow down a little. You can gamble again in ${formatCooldown(cooldown.remainingMs)}.` };
      }
      setPersistentCooldown(economy, "gambling", userId);
      setBreadBalance(economy, userId, balance - bet.amount);
      const deck = createBlackjackDeck();
      const player = [drawBlackjackCard(deck), drawBlackjackCard(deck)];
      return {
        id: `${Date.now()}:${randomInt(1000, 9999)}`,
        key: sessionKey,
        userId,
        guildId: ctx.message.guild.id,
        bet: bet.amount,
        originalBet: bet.amount,
        deck,
        player,
        hands: [{ cards: player, bet: bet.amount, doubled: false, settled: false, fromSplit: false }],
        activeHandIndex: 0,
        dealer: [drawBlackjackCard(deck), drawBlackjackCard(deck)],
        doubled: false,
        settled: false
      };
    });

    if (session.error) {
      await ctx.message.reply(session.error);
      return;
    }

    blackjackSessions.set(sessionKey, session);

    const advanceOrSettle = async (interaction, reason = "") => {
      const hand = blackjackCurrentHand(session);
      hand.settled = true;
      while (session.activeHandIndex < session.hands.length - 1) {
        session.activeHandIndex += 1;
        if (!blackjackCurrentHand(session).settled) {
          await interaction.update({
            content: blackjackTableText(session, false, reason || "Next split hand. Hit, stand, double, or survive."),
            components: blackjackButtons(session),
            allowedMentions: NO_MENTIONS
          });
          return;
        }
      }
      await settle(reason || "All hands played. Dealer resolves the table.", interaction);
    };

    const settle = async (reason, interaction = null) => {
      if (session.settled) return;
      session.settled = true;
      const playableHands = session.hands.filter((hand) => blackjackHandValue(hand.cards) <= 21);
      const playerNatural = session.hands.length === 1 && session.hands[0].cards.length === 2 && blackjackHandValue(session.hands[0].cards) === 21;
      const dealerNatural = session.dealer.length === 2 && blackjackHandValue(session.dealer) === 21;
      while (playableHands.length && !playerNatural && !dealerNatural && blackjackHandValue(session.dealer) < 17) {
        session.dealer.push(drawBlackjackCard(session.deck));
      }
      const outcomes = session.hands.map((hand) => ({ hand, ...blackjackOutcome(session, hand) }));
      const payout = outcomes.reduce((sum, outcome) => sum + outcome.payout, 0);
      const totalBet = blackjackTotalBet(session);
      const balance = await updateBreadEconomy(ctx, async (economy) => {
        const current = breadBalance(economy, userId);
        setBreadBalance(economy, userId, current + payout);
        recordGamblingStats(economy, userId, { bet: totalBet, payout, game: "Bread Blackjack" });
        return breadBalance(economy, userId);
      });
      blackjackSessions.delete(sessionKey);
      const resultText = outcomes
        .map((outcome, index) => `Hand ${index + 1}: ${outcome.label} Payout ${formatBread(outcome.payout)}.`)
        .join("\n");
      const text = blackjackTableText(
        session,
        true,
        `${reason || "Dealer resolves the table."}\n${resultText}\nTotal payout: ${formatBread(payout)}\nNet: ${formatNetBread(payout - totalBet)}\nBalance: ${formatBread(balance)}`
      );
      if (interaction) {
        await interaction.update({ content: text, components: blackjackButtons(session, true), allowedMentions: NO_MENTIONS });
      } else if (session.message) {
        await session.message.edit({ content: text, components: blackjackButtons(session, true), allowedMentions: NO_MENTIONS }).catch(() => {});
      }
    };

    if (blackjackHandValue(session.hands[0].cards) === 21 || blackjackHandValue(session.dealer) === 21) {
      const message = await ctx.message.reply({
        content: blackjackTableText(session, true, "Natural check."),
        components: blackjackButtons(session, true),
        allowedMentions: NO_MENTIONS
      });
      session.message = message;
      await settle(null);
      return;
    }

    const message = await ctx.message.reply({
      content: blackjackTableText(session),
      components: blackjackButtons(session),
      allowedMentions: NO_MENTIONS
    });
    session.message = message;

    const collector = message.createMessageComponentCollector({
      filter: (interaction) => interaction.customId.startsWith(`bj:${session.id}:`),
      time: BLACKJACK_SESSION_MS
    });

    collector.on("collect", async (interaction) => {
      if (interaction.user.id !== userId) {
        await interaction.reply({ content: "This blackjack hand belongs to someone else.", ephemeral: true });
        return;
      }

      const action = interaction.customId.split(":").pop();
      const hand = blackjackCurrentHand(session);
      if (action === "hit") {
        hand.cards.push(drawBlackjackCard(session.deck));
        if (blackjackHandValue(hand.cards) >= 21) {
          await advanceOrSettle(interaction, blackjackHandValue(hand.cards) === 21 ? "Twenty-one. Moving along." : "Bust. Moving along.");
          if (session.settled) collector.stop("settled");
          return;
        }
        await interaction.update({
          content: blackjackTableText(session, false, "Card drawn. Hit, stand, or double."),
          components: blackjackButtons(session),
          allowedMentions: NO_MENTIONS
        });
        return;
      }

      if (action === "stand") {
        await advanceOrSettle(interaction, "Standing. Moving along.");
        if (session.settled) collector.stop("settled");
        return;
      }

      if (action === "double") {
        if (hand.cards.length !== 2 || hand.doubled) {
          await interaction.reply({ content: "You can only double on your first move.", ephemeral: true });
          return;
        }
        const doubled = await updateBreadEconomy(ctx, async (economy) => {
          const current = breadBalance(economy, userId);
          if (current < session.originalBet) return false;
          setBreadBalance(economy, userId, current - session.originalBet);
          return true;
        });
        if (!doubled) {
          await interaction.reply({ content: `You need another ${formatBread(session.originalBet)} to double.`, ephemeral: true });
          return;
        }
        hand.bet += session.originalBet;
        hand.doubled = true;
        hand.cards.push(drawBlackjackCard(session.deck));
        await advanceOrSettle(interaction, "Doubled down. Moving along.");
        if (session.settled) collector.stop("settled");
        return;
      }

      if (action === "split") {
        if (!blackjackCanSplit(session)) {
          await interaction.reply({ content: "You can only split your first two matching-value cards.", ephemeral: true });
          return;
        }
        const paid = await updateBreadEconomy(ctx, async (economy) => {
          const current = breadBalance(economy, userId);
          if (current < session.originalBet) return false;
          setBreadBalance(economy, userId, current - session.originalBet);
          return true;
        });
        if (!paid) {
          await interaction.reply({ content: `You need another ${formatBread(session.originalBet)} to split.`, ephemeral: true });
          return;
        }
        const [first, second] = hand.cards;
        session.split = true;
        session.hands = [
          { cards: [first, drawBlackjackCard(session.deck)], bet: session.originalBet, doubled: false, settled: false, fromSplit: true },
          { cards: [second, drawBlackjackCard(session.deck)], bet: session.originalBet, doubled: false, settled: false, fromSplit: true }
        ];
        session.player = session.hands[0].cards;
        session.activeHandIndex = 0;
        await interaction.update({
          content: blackjackTableText(session, false, "Split into two hands. Play hand 1 first."),
          components: blackjackButtons(session),
          allowedMentions: NO_MENTIONS
        });
      }
    });

    collector.on("end", async (_collected, reason) => {
      if (reason === "settled" || session.settled) return;
      session.settled = true;
      blackjackSessions.delete(sessionKey);
      const refund = blackjackTotalBet(session);
      const balance = await updateBreadEconomy(ctx, async (economy) => {
        const current = breadBalance(economy, userId);
        setBreadBalance(economy, userId, current + refund);
        return breadBalance(economy, userId);
      });
      await message.edit({
        content: blackjackTableText(session, true, `Hand expired. Refunded ${formatBread(refund)}.\nBalance: ${formatBread(balance)}`),
        components: blackjackButtons(session, true),
        allowedMentions: NO_MENTIONS
      }).catch(() => {});
    });
  }
});

define({
  name: "scratch",
  aliases: ["scratchcard"],
  category: "Gambling",
  description: "Buy a scratch card with match and artifact bonus prizes.",
  usage: "scratch 100",
  async run(ctx) {
    const symbols = ["crumb", "crumb", "loaf", "loaf", "horn", "suit", "ck", "artifact"];
    await runBreadBet(ctx, "Bread Scratch Card", (bet) => {
      const card = Array.from({ length: 9 }, () => symbols[randomInt(0, symbols.length - 1)]);
      const counts = card.reduce((map, symbol) => ({ ...map, [symbol]: (map[symbol] || 0) + 1 }), {});
      const maxMatches = Math.max(...Object.values(counts));
      const artifactCount = counts.artifact || 0;
      const payout = artifactCount >= 3
        ? bet * 20
        : maxMatches >= 6
          ? bet * 12
          : maxMatches === 5
            ? bet * 6
            : maxMatches === 4
              ? bet * 3
              : maxMatches === 3
                ? Math.floor(bet * 1.4)
                : 0;
      return {
        payout,
        text: `${card.slice(0, 3).join(" | ")}\n${card.slice(3, 6).join(" | ")}\n${card.slice(6).join(" | ")}\nBest match: **${maxMatches}**. Artifacts: **${artifactCount}**.`
      };
    });
  }
});

define({
  name: "cups",
  aliases: ["breadcups"],
  category: "Gambling",
  description: "Pick the cup hiding the bread. Choose 1-4 for higher risk.",
  usage: "cups 100 1",
  async run(ctx) {
    const pick = Number(ctx.args[1]);
    if (!Number.isInteger(pick) || pick < 1 || pick > 4) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }

    await runBreadBet(ctx, "Bread Cups", (bet) => {
      const winner = randomInt(1, 4);
      const won = pick === winner;
      return {
        payout: won ? bet * 4 : 0,
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
    const target = Math.min(Math.max(Number(ctx.args[1]) || 2, 1.1), 15);

    await runBreadBet(ctx, "Bread Crash", (bet) => {
      const roll = Math.random();
      const crashPoint = Math.min(Math.max(Math.floor((1 / Math.max(roll, 0.04)) * 0.82 * 100) / 100, 1), 30);
      const won = target <= crashPoint;
      return {
        payout: won ? Math.floor(bet * target) : 0,
        text: `Cashout target: **${target.toFixed(2)}x**.\nMarket crash: **${crashPoint.toFixed(2)}x**. ${won ? "You escaped with warm bread." : "Burnt toast."}`
      };
    });
  }
});

define({
  name: "jackpot",
  aliases: ["lottery"],
  category: "Gambling",
  description: "Buy a long-shot jackpot ticket with consolation prizes.",
  usage: "jackpot 100",
  async run(ctx) {
    await runBreadBet(ctx, "Bread Jackpot", (bet) => {
      const roll = randomInt(1, 100);
      const payout = roll === 100 ? bet * 75 : roll >= 96 ? bet * 25 : roll >= 86 ? bet * 4 : roll >= 76 ? Math.floor(bet * 1.5) : 0;
      return {
        payout,
        text: `Ticket roll: **${roll}**.\n${roll === 100 ? "Mythic jackpot." : roll >= 96 ? "Massive jackpot." : roll >= 86 ? "Small prize." : roll >= 76 ? "Consolation loaf." : "The bakery keeps the ticket."}`
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

    scheduleReminder(() => {
      ctx.message.channel.send(`${ctx.message.author}, reminder: ${safeContent(reminder)}`).catch(() => {});
    }, duration);
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
  aliases: ["oath", "principles", "rules", "chiprules", "chipname", "name", "rank", "suit", "donation", "lore", "figures", "chipfigures", "familyfigures", "randomprinciple", "ruleofthestep", "principleroll"],
  category: "Chipkittle",
  description: "Chipkittle lore hub for names, principles, ranks, suit, and family lore.",
  async run(ctx) {
    const invoked = (ctx.invokedName || ctx.command.name).toLowerCase();
    const mode = ["oath", "principles", "rules", "chiprules", "chipname", "name", "rank", "suit", "donation", "lore", "figures", "chipfigures", "familyfigures", "randomprinciple", "ruleofthestep", "principleroll"].includes(invoked)
      ? invoked
      : (ctx.args[0] || "").toLowerCase();

    if (["oath", "principles", "rules", "chiprules"].includes(mode)) {
      await ctx.message.reply(CHIPKITTLE_LORE.principles.map((rule, index) => `${index + 1}. ${rule}`).join("\n"));
      return;
    }
    if (["chipname", "name"].includes(mode)) {
      if (isAiChannelBlacklisted(ctx.config, ctx.message.channel.id)) {
        await ctx.message.reply("Chipkittle AI is blacklisted in this channel.");
        return;
      }
      if (!ctx.config.ai.enabled) {
        await ctx.message.reply("Chipkittle AI is disabled in the panel.");
        return;
      }
      if (!ctx.ai.enabled) {
        await ctx.message.reply("AI is not configured yet. Add `OPENAI_API_KEY` to `.env`, then restart the bot.");
        return;
      }
      if (!aiAllowedForMember(ctx.config, ctx.message.member)) {
        await ctx.message.reply("Chipkittle AI is currently limited to configured AI roles.");
        return;
      }
      const budget = aiBudgetStatus(ctx.config);
      if (budget.exceeded) {
        await ctx.message.reply("Chipkittle AI has reached the monthly usage budget.");
        return;
      }
      const rateLimit = checkAiRateLimit({
        guildId: ctx.message.guild.id,
        userId: ctx.message.author.id,
        cooldownSeconds: ctx.config.ai.apiCooldownSeconds,
        bucket: "chat"
      });
      if (rateLimit.limited) {
        await ctx.message.reply({ content: `The artifact is cooling down. Try again in ${rateLimit.retryAfterSeconds}s.`, allowedMentions: NO_MENTIONS });
        return;
      }
      await ctx.message.channel.sendTyping();
      const inspiration = ["chipname", "name"].includes(invoked) ? ctx.rest : ctx.args.slice(1).join(" ");
      const name = await ctx.ai.chipkittleName(ctx.message, ctx.config, inspiration);
      await recordAiUsage(ctx.store, ctx.message.guild.id, ctx.config, { estimatedTokens: 90 });
      await ctx.message.reply(`Your Chipkittle name is **${name}**.`);
      return;
    }
    if (mode === "rank") {
      const member = mentionUser(ctx.message);
      const rank = CHIPKITTLE_LORE.ranks[Math.floor(Math.random() * CHIPKITTLE_LORE.ranks.length)];
      await ctx.message.reply(`${member} is now recognized as **${rank}**.`);
      return;
    }
    if (mode === "suit") {
      await ctx.message.reply(CHIPKITTLE_LORE.visual);
      return;
    }
    if (mode === "donation") {
      const amount = (Math.random() * 8 + 0.2).toFixed(1);
      await ctx.message.reply(`${ctx.message.member.displayName} has pledged ${amount} million imaginary bread units to the Chipkittle Donation Fund.`);
      return;
    }
    if (["lore", "figures", "chipfigures", "familyfigures"].includes(mode)) {
      await ctx.message.reply(CHIPKITTLE_LORE.figures[Math.floor(Math.random() * CHIPKITTLE_LORE.figures.length)]);
      return;
    }
    if (["randomprinciple", "ruleofthestep", "principleroll"].includes(mode)) {
      const principle = CHIPKITTLE_LORE.principles[randomInt(0, CHIPKITTLE_LORE.principles.length - 1)];
      await ctx.message.reply(`**Today's Principle**\n${principle}`);
      return;
    }
    await ctx.message.reply(`${CHIPKITTLE_LORE.visual} The family exists to protect the ancient artifact, honor the roster, and move in silence.`);
  }
});

define({
  name: "artifact",
  aliases: ["quote", "chipquote", "artifactquote", "artifacttoday", "artifactrandom", "randomartifact", "artifactroll", "artifactregistry", "artifacts", "registry", "artifactsearch", "findartifact", "artifactfind", "artifactrarity", "raritysearch", "artifactsbyrarity", "artifactkeeper", "keeper", "findkeeper", "artifactcount", "artifactstats", "registrycount"],
  category: "Chipkittle",
  description: "Artifact hub for guidance, registry, search, rarity, keepers, and counts.",
  async run(ctx) {
    const invoked = (ctx.invokedName || ctx.command.name).toLowerCase();
    const mode = this.aliases.includes(invoked) ? invoked : (ctx.args[0] || "").toLowerCase();
    if (["artifacttoday"].includes(mode)) {
      const item = artifactOfTheDay(ctx.config);
      if (!item) {
        await ctx.message.reply("No artifact has been recorded yet.");
        return;
      }
      await ctx.message.reply([`**Artifact of the Day: ${item.name}**`, `Rarity: ${item.rarity}`, `Keeper: ${item.keeper}`, item.summary].join("\n"));
      return;
    }
    if (["artifactrandom", "randomartifact", "artifactroll"].includes(mode)) {
      const artifacts = ctx.config.community?.artifacts || [];
      if (!artifacts.length) {
        await ctx.message.reply("No artifacts are registered yet.");
        return;
      }
      const item = artifacts[Math.floor(Math.random() * artifacts.length)];
      await ctx.message.reply([`**Random Artifact: ${item.name}**`, `Rarity: ${item.rarity}`, `Keeper: ${item.keeper}`, item.summary].join("\n"));
      return;
    }
    if (["artifactregistry", "artifacts", "registry"].includes(mode)) {
      const artifacts = (ctx.config.community?.artifacts || []).slice(0, 12);
      if (!artifacts.length) {
        await ctx.message.reply("No artifacts are registered yet.");
        return;
      }
      await ctx.message.reply(artifacts.map((item) => `• **${item.name}** (${item.rarity}) - ${item.keeper}\n  ${item.summary}`).join("\n"));
      return;
    }
    if (["artifactsearch", "findartifact", "artifactfind"].includes(mode)) {
      const query = (["artifactsearch", "findartifact", "artifactfind"].includes(invoked) ? ctx.rest : ctx.args.slice(1).join(" ")).trim().toLowerCase();
      if (!query) {
        await ctx.message.reply(`Usage: \`${ctx.config.prefix}artifact search keyword\``);
        return;
      }
      const matches = (ctx.config.community?.artifacts || [])
        .filter((item) => [item.name, item.rarity, item.keeper, item.summary].some((field) => String(field || "").toLowerCase().includes(query)))
        .slice(0, 8);
      if (!matches.length) {
        await ctx.message.reply(`No artifacts matched **${query}**.`);
        return;
      }
      await ctx.message.reply(matches.map((item) => `• **${item.name}** (${item.rarity}) - ${item.keeper}\n  ${item.summary}`).join("\n"));
      return;
    }
    if (["artifactrarity", "raritysearch", "artifactsbyrarity"].includes(mode)) {
      const query = (["artifactrarity", "raritysearch", "artifactsbyrarity"].includes(invoked) ? ctx.rest : ctx.args.slice(1).join(" ")).trim().toLowerCase();
      if (!query) {
        await ctx.message.reply(`Usage: \`${ctx.config.prefix}artifact rarity rare\``);
        return;
      }
      const matches = (ctx.config.community?.artifacts || [])
        .filter((item) => String(item.rarity || "").toLowerCase().includes(query))
        .slice(0, 12);
      await ctx.message.reply([
        `**Artifacts Matching Rarity: ${query}**`,
        matches.length ? matches.map((item) => `• **${item.name}** - ${item.keeper}`).join("\n") : "No artifacts matched that rarity."
      ].join("\n"));
      return;
    }
    if (["artifactkeeper", "keeper", "findkeeper"].includes(mode)) {
      const query = (["artifactkeeper", "keeper", "findkeeper"].includes(invoked) ? ctx.rest : ctx.args.slice(1).join(" ")).trim().toLowerCase();
      if (!query) {
        await ctx.message.reply(`Usage: \`${ctx.config.prefix}artifact keeper artifact name\``);
        return;
      }
      const item = (ctx.config.community?.artifacts || []).find((entry) => String(entry.name || "").toLowerCase().includes(query));
      if (!item) {
        await ctx.message.reply(`No artifact matched **${query}**.`);
        return;
      }
      await ctx.message.reply(`**${item.name}** is kept by **${item.keeper || "Unknown Keeper"}**.\nRarity: ${item.rarity || "Unknown"}\n${item.summary || "No summary recorded."}`);
      return;
    }
    if (["artifactcount", "artifactstats", "registrycount"].includes(mode)) {
      const artifacts = ctx.config.community?.artifacts || [];
      const rarities = artifacts.reduce((map, item) => ({ ...map, [item.rarity || "Unknown"]: (map[item.rarity || "Unknown"] || 0) + 1 }), {});
      const rarityLine = Object.entries(rarities).slice(0, 5).map(([rarity, count]) => `${rarity}: ${count}`).join(" | ");
      await ctx.message.reply([`**Artifact Registry Stats**`, `Total artifacts: **${artifacts.length}**`, rarityLine || "No rarity data yet."].join("\n"));
      return;
    }
    await ctx.message.reply(randomChipkittleQuote());
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

    if (ctx.message.guild && isAiChannelBlacklisted(ctx.config, ctx.message.channel.id)) {
      await ctx.message.reply("Chipkittle AI is blacklisted in this channel.");
      return;
    }

    const attachment = await findImageAttachment(ctx.message);
    if (!attachment) {
      await ctx.message.reply(`Attach an image with \`${usage(ctx.config, this)}\`, or reply to an image with \`${ctx.config.prefix}chipify\`.`);
      return;
    }

    const rateLimit = checkAiRateLimit({
      guildId: ctx.message.guild?.id || "dm",
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
  name: "caption",
  aliases: ["meme", "captionimage"],
  category: "Utility",
  description: "Caption an attached image or GIF like an esmBot-style media tool.",
  usage: "caption text or top text | bottom text",
  async run(ctx) {
    const slashOptions = ctx.message.slashOptions;
    const attachment = slashOptions?.getAttachment("file") || await findMediaAttachment(ctx.message);
    if (!attachment) {
      await ctx.message.reply("Attach an image or GIF, or reply to one, and give me some caption text.");
      return;
    }

    const parsedCaption = splitCaptionText(ctx.rest || "");
    let topText = slashOptions ? (slashOptions.getString("text") || "") : parsedCaption.topText;
    let bottomText = slashOptions ? (slashOptions.getString("bottom_text") || "") : parsedCaption.bottomText;

    if (!bottomText.trim()) {
      bottomText = topText;
      topText = "";
    }

    if (!String(topText || "").trim() && !String(bottomText || "").trim()) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\`\nUse \`top | bottom\` if you want two caption lines.`);
      return;
    }

    const status = await ctx.message.reply("Captioning media...");
    try {
      const media = await downloadMediaAttachment(attachment);
      const output = await captionMedia(media, { topText, bottomText });
      const file = new AttachmentBuilder(output.buffer, { name: output.filename });
      await status.edit({
        content: `${ctx.message.author}, done.`,
        files: [file],
        allowedMentions: NO_MENTIONS
      });
    } catch (error) {
      console.error("Caption command failed:", error);
      await status.edit(error.message || "I could not caption that media.").catch(() => {});
    }
  }
});

define({
  name: "gif",
  aliases: ["getgif", "togif", "tgif", "gifify"],
  category: "Utility",
  description: "Convert an attached or replied-to image/GIF into a GIF, like esmBot's gif command.",
  usage: "gif [attach image or reply to image]",
  async run(ctx) {
    const slashOptions = ctx.message.slashOptions;
    const attachment = slashOptions?.getAttachment("file") || await findMediaAttachment(ctx.message);
    if (!attachment) {
      await ctx.message.reply("Attach or reply to an image/GIF first.");
      return;
    }

    const status = await ctx.message.reply("Converting that media to GIF...");

    try {
      const media = await downloadMediaAttachment(attachment);
      const output = await convertToGif(media);
      const file = new AttachmentBuilder(output.buffer, { name: output.filename });
      await status.edit({
        content: `${ctx.message.author}, done.`,
        files: [file],
        allowedMentions: NO_MENTIONS
      });
    } catch (error) {
      console.error("GIF command failed:", error);
      await status.edit(error.message || "I could not convert that media to GIF.").catch(() => {});
    }
  }
});

define({
  name: "gifedit",
  aliases: ["mediaedit", "giftools"],
  category: "Utility",
  description: "Deterministic GIF editing with caption, speed, reverse, boomerang, resize, and wiggle.",
  usage: "gifedit caption|speed|reverse|boomerang|resize|wiggle",
  async run(ctx) {
    const options = slashGifOptions(ctx) || prefixGifOptions(ctx);
    const subcommand = options?.subcommand || "";
    if (!subcommand) {
      await ctx.message.reply(gifUsageText(ctx.config));
      return;
    }

    const attachment = options.attachment || await findMediaAttachment(ctx.message);
    if (!attachment) {
      await ctx.message.reply("Attach or reply to an image/GIF first.\n\n" + gifUsageText(ctx.config));
      return;
    }

    const status = await ctx.message.reply(`Running \`${subcommand}\` on that media...`);

    try {
      const media = await downloadMediaAttachment(attachment);
      let output;

      if (subcommand === "caption") {
        const topText = options.bottomText ? options.text : "";
        const bottomText = options.bottomText || options.text;
        if (!String(topText || bottomText || "").trim()) {
          throw new Error("Give me caption text for `gifedit caption`.");
        }
        output = await captionMedia(media, {
          topText,
          bottomText,
          forceGif: true
        });
      } else if (subcommand === "speed") {
        if (!options.factor) {
          throw new Error("Give me a speed factor, like `2` or `0.5`.");
        }
        output = await gifSpeed(media, options.factor);
      } else if (subcommand === "reverse") {
        output = await gifReverse(media);
      } else if (subcommand === "boomerang") {
        output = await gifBoomerang(media);
      } else if (subcommand === "resize") {
        if (!options.width && !options.height) {
          throw new Error("Give me a width, or a width and height, for `gifedit resize`.");
        }
        output = await gifResize(media, {
          width: options.width || 0,
          height: options.height || 0
        });
      } else if (subcommand === "wiggle") {
        output = await gifWiggle(media, {
          seconds: options.seconds || 3
        });
      } else {
        throw new Error(`Unknown gif subcommand \`${subcommand}\`.`);
      }

      const file = new AttachmentBuilder(output.buffer, { name: output.filename });
      await status.edit({
        content: `${ctx.message.author}, done.`,
        files: [file],
        allowedMentions: NO_MENTIONS
      });
    } catch (error) {
      console.error("GIF command failed:", error);
      await status.edit(error.message || "I could not edit that GIF.").catch(() => {});
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
    const finalOutput = output;
    await sendPunishmentNotice(member, {
      guildName: ctx.message.guild.name,
      action: "warned",
      reason,
      moderatorTag: ctx.message.author.tag
    });
    await recordModerationAudit(ctx, {
      action: "warn",
      member,
      reason,
      details: finalOutput
    });
    await ctx.message.reply(finalOutput);
    await sendModerationLog(ctx, finalOutput);
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

    if (!(await canModerateTarget(ctx, member, "timeout", "moderatable", "Moderate Members"))) return;

    const timeoutDuration = Math.min(duration, 28 * 86_400_000);
    const completed = await runModerationAction(
      ctx,
      member,
      "timeout",
      () => member.timeout(timeoutDuration, reason),
      "Moderate Members"
    );
    if (!completed) return;

    const output = `${member} timed out for ${formatDuration(duration)}. Reason: ${reason}`;
    const finalOutput = output;
    await sendPunishmentNotice(member, {
      guildName: ctx.message.guild.name,
      action: "timed out",
      reason,
      durationLabel: formatDuration(timeoutDuration),
      moderatorTag: ctx.message.author.tag
    });
    await recordModerationAudit(ctx, {
      action: "timeout",
      member,
      reason,
      durationMs: timeoutDuration,
      details: finalOutput
    });
    await ctx.message.reply(finalOutput);
    await sendModerationLog(ctx, finalOutput);
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

    if (!(await canModerateTarget(ctx, member, "remove timeout from", "moderatable", "Moderate Members"))) return;

    const completed = await runModerationAction(
      ctx,
      member,
      "remove timeout from",
      () => member.timeout(null),
      "Moderate Members"
    );
    if (!completed) return;

    const output = `${member} is no longer timed out.`;
    const finalOutput = output;
    await sendPunishmentNotice(member, {
      guildName: ctx.message.guild.name,
      action: "removed from timeout",
      reason: "Timeout removed.",
      moderatorTag: ctx.message.author.tag
    });
    await recordModerationAudit(ctx, {
      action: "untimeout",
      member,
      reason: "Timeout removed.",
      details: finalOutput
    });
    await ctx.message.reply(finalOutput);
    await sendModerationLog(ctx, finalOutput);
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

    if (!(await canModerateTarget(ctx, member, "kick", "kickable", "Kick Members"))) return;

    await sendPunishmentNotice(member, {
      guildName: ctx.message.guild.name,
      action: "kicked",
      reason,
      moderatorTag: ctx.message.author.tag
    });

    const completed = await runModerationAction(
      ctx,
      member,
      "kick",
      () => member.kick(reason),
      "Kick Members"
    );
    if (!completed) return;

    const output = `${member.user.tag} was kicked. Reason: ${reason}`;
    const finalOutput = output;
    await recordModerationAudit(ctx, {
      action: "kick",
      member,
      reason,
      details: finalOutput
    });
    await ctx.message.reply(finalOutput);
    await sendModerationLog(ctx, finalOutput);
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

    if (!(await canModerateTarget(ctx, member, "ban", "bannable", "Ban Members"))) return;

    await sendPunishmentNotice(member, {
      guildName: ctx.message.guild.name,
      action: "banned",
      reason,
      moderatorTag: ctx.message.author.tag
    });

    const completed = await runModerationAction(
      ctx,
      member,
      "ban",
      () => member.ban({ reason }),
      "Ban Members"
    );
    if (!completed) return;

    const output = `${member.user.tag} was banned. Reason: ${reason}`;
    const finalOutput = output;
    await recordModerationAudit(ctx, {
      action: "ban",
      member,
      reason,
      details: finalOutput
    });
    await ctx.message.reply(finalOutput);
    await sendModerationLog(ctx, finalOutput);
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
        `AI config: ${ctx.config.ai.enabled ? "on" : "off"} | mode: ${ctx.config.ai.mode === "evil" ? "evil" : "normal"} | channels: ${channelMentionList(ctx.config.ai.channelIds)} | blacklisted: ${channelMentionList(ctx.config.ai.blacklistedChannelIds || [])} | model: ${ctx.config.ai.model || ctx.defaultAiModel} | cooldown: ${ctx.config.ai.apiCooldownSeconds}s | API key: ${ctx.ai.enabled ? "present" : "missing"}`
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
  name: "aimode",
  aliases: ["aipersona"],
  category: "AI",
  description: "Switch Chipkittle AI between normal and evil mode.",
  usage: "aimode normal|evil|status",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const mode = ctx.args[0]?.toLowerCase() || "status";

    if (mode === "status") {
      await ctx.message.reply(`AI mode is currently **${ctx.config.ai.mode === "evil" ? "evil" : "normal"}**.`);
      return;
    }

    if (!["normal", "evil"].includes(mode)) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }

    await ctx.store.updateGuild(ctx.message.guild.id, {
      ai: { ...ctx.config.ai, mode }
    });
    await ctx.message.reply(`AI mode set to **${mode}**.`);
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
    if (!requirePanelRoot(ctx)) return;
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
  name: "airoles",
  aliases: ["aiaccess"],
  category: "AI",
  description: "Limit AI usage to certain roles, or list the current role gate.",
  usage: "airoles add @role | remove @role | clear | list",
  async run(ctx) {
    if (!requirePanelRoot(ctx)) return;
    const action = ctx.args[0]?.toLowerCase() || "list";
    const allowedRoleIds = new Set(ctx.config.ai.allowedRoleIds || []);

    if (action === "list") {
      await ctx.message.reply(`AI allowed roles: ${allowedRoleIds.size ? [...allowedRoleIds].map((roleId) => `<@&${roleId}>`).join(", ") : "everyone"}.`);
      return;
    }

    if (action === "clear") {
      await ctx.store.updateGuild(ctx.message.guild.id, {
        ai: { ...ctx.config.ai, allowedRoleIds: [] }
      });
      await ctx.message.reply("AI role gate cleared. Everyone can use AI commands again.");
      return;
    }

    const role = targetRole(ctx.message);
    if (!role || !["add", "remove"].includes(action)) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }

    if (action === "add") allowedRoleIds.add(role.id);
    if (action === "remove") allowedRoleIds.delete(role.id);

    await ctx.store.updateGuild(ctx.message.guild.id, {
      ai: { ...ctx.config.ai, allowedRoleIds: [...allowedRoleIds] }
    });
    await ctx.message.reply(`AI allowed roles updated: ${allowedRoleIds.size ? [...allowedRoleIds].map((roleId) => `<@&${roleId}>`).join(", ") : "everyone"}.`);
  }
});

define({
  name: "aiusage",
  aliases: ["aistats", "aibudgetstatus"],
  category: "AI",
  description: "Show AI request and estimated token usage for this month.",
  async run(ctx) {
    const budget = aiBudgetStatus(ctx.config);
    await ctx.message.reply([
      `**Chipkittle AI Usage**`,
      `Month: **${budget.usage.month}**`,
      `Requests: **${budget.usage.requests.toLocaleString()}**`,
      `Estimated tokens: **${budget.usage.estimatedTokens.toLocaleString()}**`,
      budget.budget > 0
        ? `Budget: **${budget.budget.toLocaleString()}** estimated tokens (${budget.remaining.toLocaleString()} left)`
        : `Budget: **unlimited**`
    ].join("\n"));
  }
});

define({
  name: "aiclearmemory",
  aliases: ["clearai", "aimemoryreset"],
  category: "AI",
  description: "Clear Chipkittle AI conversation memory for the current channel.",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    if (typeof ctx.ai.clearHistory !== "function") {
      await ctx.message.reply("This AI service does not support memory clearing.");
      return;
    }
    ctx.ai.clearHistory(ctx.message);
    await ctx.message.reply("AI memory cleared for this channel.");
  }
});

define({
  name: "aibudget",
  category: "AI",
  description: "Set the monthly estimated AI token budget. Zero means unlimited.",
  usage: "aibudget 250000",
  async run(ctx) {
    if (!requirePanelRoot(ctx)) return;
    const monthlyBudget = Math.min(Math.max(Math.floor(Number(ctx.args[0]) || 0), 0), 50_000_000);
    await ctx.store.updateGuild(ctx.message.guild.id, {
      ai: { ...ctx.config.ai, monthlyBudget }
    });
    await ctx.message.reply(monthlyBudget ? `AI monthly budget set to **${monthlyBudget.toLocaleString()}** estimated tokens.` : "AI monthly budget disabled.");
  }
});

define({
  name: "airesetusage",
  aliases: ["resetaiusage"],
  category: "AI",
  description: "Reset this month's AI usage counter.",
  async run(ctx) {
    if (!requirePanelRoot(ctx)) return;
    await ctx.store.updateGuild(ctx.message.guild.id, {
      ai: { ...ctx.config.ai, usage: { month: aiMonthKey(), requests: 0, estimatedTokens: 0 } }
    });
    await ctx.message.reply("AI usage counter reset for this month.");
  }
});

define({
  name: "aichaos",
  aliases: ["chaosai"],
  category: "AI",
  description: "Set AI chaos level from 1 to 10.",
  usage: "aichaos 7",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const chaosLevel = Math.min(Math.max(Math.floor(Number(ctx.args[0]) || 3), 1), 10);
    await ctx.store.updateGuild(ctx.message.guild.id, {
      ai: { ...ctx.config.ai, chaosLevel }
    });
    await ctx.message.reply(`AI chaos level set to **${chaosLevel}/10**.`);
  }
});

define({
  name: "ailorestrict",
  aliases: ["lorestrict"],
  category: "AI",
  description: "Set how strictly the AI sticks to Chipkittle lore.",
  usage: "ailorestrict loose|balanced|strict",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const loreStrictness = String(ctx.args[0] || "").toLowerCase();
    if (!["loose", "balanced", "strict"].includes(loreStrictness)) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }
    await ctx.store.updateGuild(ctx.message.guild.id, {
      ai: { ...ctx.config.ai, loreStrictness }
    });
    await ctx.message.reply(`AI lore strictness set to **${loreStrictness}**.`);
  }
});

define({
  name: "airesponselength",
  aliases: ["ailength"],
  category: "AI",
  description: "Set default AI response length.",
  usage: "airesponselength short|normal|long",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const responseLength = String(ctx.args[0] || "").toLowerCase();
    if (!["short", "normal", "long"].includes(responseLength)) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }
    await ctx.store.updateGuild(ctx.message.guild.id, {
      ai: { ...ctx.config.ai, responseLength }
    });
    await ctx.message.reply(`AI response length set to **${responseLength}**.`);
  }
});

define({
  name: "aichannelpersona",
  aliases: ["channelpersona", "aichannelpersonality"],
  category: "AI",
  description: "Set channel-specific AI personality instructions.",
  usage: "aichannelpersona #channel text | clear #channel | list",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const action = ctx.args[0]?.toLowerCase() || "list";
    const personalities = { ...(ctx.config.ai.channelPersonalities || {}) };

    if (action === "list") {
      const rows = Object.entries(personalities).slice(0, 15).map(([channelId, text]) => `<#${channelId}> - ${String(text).slice(0, 120)}`);
      await ctx.message.reply(rows.length ? [`**AI Channel Personalities**`, ...rows].join("\n") : "No channel-specific AI personality rules are set.");
      return;
    }

    const channel = targetTextChannel(ctx.message);
    if (!channel?.id) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }

    if (action === "clear") {
      delete personalities[channel.id];
      await ctx.store.updateGuild(ctx.message.guild.id, {
        ai: { ...ctx.config.ai, channelPersonalities: personalities }
      });
      await ctx.message.reply(`AI personality cleared for ${channel}.`);
      return;
    }

    const text = ctx.rest
      .replace(/^(set|add|update)\s+/i, "")
      .replace(/<#\d+>\s*/g, "")
      .trim()
      .slice(0, 600);
    if (!text) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }

    personalities[channel.id] = text;
    await ctx.store.updateGuild(ctx.message.guild.id, {
      ai: { ...ctx.config.ai, channelPersonalities: personalities }
    });
    await ctx.message.reply(`AI personality updated for ${channel}.`);
  }
});

define({
  name: "loreask",
  aliases: ["asklore", "chipask"],
  category: "AI",
  description: "Ask a lore-focused Chipkittle question.",
  usage: "loreask what is the artifact?",
  async run(ctx) {
    const question = ctx.rest;
    if (!question) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }
    if (!ctx.config.ai.enabled || !ctx.ai.enabled) {
      await ctx.message.reply("Chipkittle AI is disabled or missing an API key.");
      return;
    }
    if (isAiChannelBlacklisted(ctx.config, ctx.message.channel.id)) {
      await ctx.message.reply("Chipkittle AI is blacklisted in this channel.");
      return;
    }
    if (!aiAllowedForMember(ctx.config, ctx.message.member)) {
      await ctx.message.reply("Chipkittle AI is currently limited to configured AI roles.");
      return;
    }
    const budget = aiBudgetStatus(ctx.config);
    if (budget.exceeded) {
      await ctx.message.reply("Chipkittle AI has reached the monthly usage budget.");
      return;
    }
    const rateLimit = checkAiRateLimit({
      guildId: ctx.message.guild.id,
      userId: ctx.message.author.id,
      cooldownSeconds: ctx.config.ai.apiCooldownSeconds,
      bucket: "chat"
    });
    if (rateLimit.limited) {
      await ctx.message.reply({ content: `The artifact is cooling down. Try again in ${rateLimit.retryAfterSeconds}s.`, allowedMentions: NO_MENTIONS });
      return;
    }
    await ctx.message.channel.sendTyping();
    const result = await ctx.ai.loreAnswer(ctx.message, ctx.config, question);
    await sendAiResult(ctx, result);
  }
});

define({
  name: "chipfact",
  aliases: ["lorefact", "randomlore"],
  category: "Chipkittle",
  description: "Pull a random Chipkittle lore fact without spending AI tokens.",
  async run(ctx) {
    const pool = [
      ...CHIPKITTLE_LORE.principles,
      ...CHIPKITTLE_LORE.figures,
      CHIPKITTLE_LORE.visual
    ];
    await ctx.message.reply(pool[randomInt(0, pool.length - 1)]);
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

    if (!ctx.config.ai.enabled) {
      await ctx.message.reply("Chipkittle AI is disabled in the panel.");
      return;
    }

    if (!ctx.ai.enabled) {
      await ctx.message.reply("AI is not configured yet. Add `OPENAI_API_KEY` to `.env`, then restart the bot.");
      return;
    }

    if (isAiChannelBlacklisted(ctx.config, ctx.message.channel.id)) {
      await ctx.message.reply("Chipkittle AI is blacklisted in this channel.");
      return;
    }

    if (!aiAllowedForMember(ctx.config, ctx.message.member)) {
      await ctx.message.reply("Chipkittle AI is currently limited to configured AI roles.");
      return;
    }

    const budget = aiBudgetStatus(ctx.config);
    if (budget.exceeded) {
      await ctx.message.reply("Chipkittle AI has reached the monthly usage budget.");
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
    await sendAiResult(ctx, reply);
  }
});

define({
  name: "tts",
  category: "Utility",
  description: "Join or leave voice-channel TTS for #ttsbot.",
  usage: "tts join|leave",
  async run(ctx) {
    const action = ctx.args[0]?.toLowerCase();

    if (action === "join") {
      const member = await ctx.message.guild.members
        .fetch(ctx.message.author.id)
        .catch(() => ctx.message.member);
      const error = await ctx.tts.join({
        member,
        channel: ctx.message.channel
      });
      if (error) {
        await ctx.message.reply(error);
      }
      return;
    }

    if (action === "leave") {
      const left = ctx.tts.leave(ctx.message.guild.id);
      await ctx.message.reply(left ? "TTS left the voice channel." : "TTS is not in a voice channel.");
      return;
    }

    await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
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
      parentChannelId: thread.parentId || parentChannel.id,
      guildId: ctx.message.guild.id,
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
    await incrementMetric(ctx.store, ctx.message.guild.id, "applicationsOpened", 1).catch(() => {});
    await addAuditLog(ctx.store, ctx.message.guild.id, {
      type: "application",
      label: "Application opened",
      details: `${ctx.message.author.tag} opened a membership application.`,
      actor: ctx.message.author.tag
    }).catch(() => {});
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
    await incrementMetric(ctx.store, ctx.message.guild.id, "applicationsApproved", 1).catch(() => {});
    await addAuditLog(ctx.store, ctx.message.guild.id, {
      type: "application",
      label: "Application approved",
      details: `${member.user.tag} was approved.`,
      actor: ctx.message.author.tag
    }).catch(() => {});
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
    await incrementMetric(ctx.store, ctx.message.guild.id, "applicationsDenied", 1).catch(() => {});
    await addAuditLog(ctx.store, ctx.message.guild.id, {
      type: "application",
      label: "Application denied",
      details: `${user.tag} was denied.${reason ? ` Reason: ${reason}` : ""}`,
      actor: ctx.message.author.tag
    }).catch(() => {});
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

define({
  name: "profile",
  aliases: ["title", "profiletitle", "mytitle", "badges", "profilebadges", "achievements"],
  category: "Chipkittle",
  description: "Show a member's Chipkittle profile card.",
  usage: "profile [@user]",
  async run(ctx) {
    const member = mentionTargetUser(ctx.message);
    await ctx.message.reply({ embeds: [profileEmbedFor(ctx, member)] });
  }
});

define({
  name: "settitle",
  category: "Chipkittle",
  description: "Set your public Chipkittle title.",
  usage: "settitle title",
  async run(ctx) {
    const title = cleanText(ctx.rest, 80);
    if (!title) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }
    await updateProfile(ctx.store, ctx.message.guild.id, ctx.message.author.id, (profile) => ({
      ...profile,
      displayName: ctx.message.member.displayName,
      title
    }), ctx.message.member.displayName);
    await addAuditLog(ctx.store, ctx.message.guild.id, {
      type: "profile",
      label: "Profile title updated",
      details: `${ctx.message.author.tag} is now "${title}".`,
      actor: ctx.message.author.tag
    }).catch(() => {});
    await ctx.message.reply(`Your title is now **${title}**.`);
  }
});

define({
  name: "setbio",
  category: "Chipkittle",
  description: "Set your public Chipkittle bio.",
  usage: "setbio bio text",
  async run(ctx) {
    const bio = cleanText(ctx.rest, PROFILE_BIO_MAX);
    if (!bio) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }
    await updateProfile(ctx.store, ctx.message.guild.id, ctx.message.author.id, (profile) => ({
      ...profile,
      displayName: ctx.message.member.displayName,
      bio
    }), ctx.message.member.displayName);
    await ctx.message.reply("Your Chipkittle bio has been updated.");
  }
});

define({
  name: "vouch",
  category: "Chipkittle",
  description: "Vouch for another member and increase their reputation.",
  usage: "vouch @user reason",
  async run(ctx) {
    const member = ctx.message.mentions.members.first();
    if (!member || member.id === ctx.message.author.id) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }
    const reason = cleanText(ctx.args.slice(1).join(" "), 160) || "Trusted by the artifact.";
    const existing = profileFor(ctx.config, member.id, member.displayName);
    if (existing.vouches.some((entry) => entry.from === ctx.message.author.id)) {
      await ctx.message.reply("You have already vouched for that member.");
      return;
    }
    await updateProfile(ctx.store, ctx.message.guild.id, member.id, (profile) => ({
      ...profile,
      displayName: member.displayName,
      reputation: (profile.reputation || 0) + 1,
      vouches: [
        {
          from: ctx.message.author.id,
          name: ctx.message.member.displayName,
          reason,
          createdAt: new Date().toISOString()
        },
        ...profile.vouches
      ].slice(0, 20)
    }), member.displayName);
    await incrementMetric(ctx.store, ctx.message.guild.id, "vouches", 1).catch(() => {});
    await addAuditLog(ctx.store, ctx.message.guild.id, {
      type: "vouch",
      label: "Member vouched",
      details: `${ctx.message.author.tag} vouched for ${member.user.tag}: ${reason}`,
      actor: ctx.message.author.tag
    }).catch(() => {});
    await ctx.message.reply(`${ctx.message.member} vouched for ${member}. Reputation increased.`);
  }
});

define({
  name: "reputation",
  aliases: ["rep", "repboard", "repleaderboard", "vouchboard"],
  category: "Chipkittle",
  description: "Show a member's reputation or the reputation leaderboard.",
  usage: "reputation [@user]",
  async run(ctx) {
    const invoked = (ctx.invokedName || ctx.command.name).toLowerCase();
    if (["repboard", "repleaderboard", "vouchboard"].includes(invoked)) {
      const profiles = Object.entries(ctx.config.community?.profiles || {})
        .map(([userId, profile]) => ({
          userId,
          displayName: profile.displayName || userId,
          reputation: Math.max(Number(profile.reputation) || 0, 0)
        }))
        .filter((entry) => entry.reputation > 0)
        .sort((a, b) => b.reputation - a.reputation || a.displayName.localeCompare(b.displayName))
        .slice(0, 10);
      if (!profiles.length) {
        await ctx.message.reply("No reputation has been recorded yet.");
        return;
      }
      await ctx.message.reply([
        `**Reputation Leaderboard**`,
        profiles.map((entry, index) => `${index + 1}. **${entry.displayName}** - ${entry.reputation} rep`).join("\n")
      ].join("\n"));
      return;
    }
    const member = mentionTargetUser(ctx.message);
    const profile = profileFor(ctx.config, member.id, member.displayName);
    await ctx.message.reply([
      `**${member.displayName}** has **${profile.reputation}** reputation.`,
      "",
      `**Recent Vouches**`,
      formatVouchLines(profile)
    ].join("\n"));
  }
});

define({
  name: "awardbadge",
  category: "Chipkittle",
  description: "Staff-only badge grant for a member profile.",
  usage: "awardbadge @user badge name",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const member = ctx.message.mentions.members.first();
    const badge = cleanText(ctx.args.slice(1).join(" "), 40);
    if (!member || !badge) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }
    await updateProfile(ctx.store, ctx.message.guild.id, member.id, (profile) => ({
      ...profile,
      displayName: member.displayName,
      badges: [...new Set([badge, ...(profile.badges || [])])].slice(0, 16)
    }), member.displayName);
    await addAuditLog(ctx.store, ctx.message.guild.id, {
      type: "badge",
      label: "Badge awarded",
      details: `${member.user.tag} received ${badge}.`,
      actor: ctx.message.author.tag
    }).catch(() => {});
    await ctx.message.reply(`Awarded **${badge}** to ${member}.`);
  }
});

define({
  name: "shop",
  category: "Gambling",
  description: "Browse the Chipkittle bread shop.",
  async run(ctx) {
    const lines = shopCatalog()
      .map((item) => `• **${item.name}** - ${item.cost} bread\n  ${item.description}`)
      .join("\n");
    await ctx.message.reply(`**Chipkittle Shop**\n${lines}\n\nUse \`${ctx.config.prefix}buy item-id\` to buy something.`);
  }
});

define({
  name: "shopitem",
  aliases: ["iteminfo", "catalogitem"],
  category: "Gambling",
  description: "Show details for one item in the Chipkittle shop.",
  usage: "shopitem item-id",
  async run(ctx) {
    const itemId = cleanText(ctx.args[0], 60).toLowerCase();
    if (!itemId) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }
    const item = shopCatalog().find((entry) => entry.id === itemId);
    if (!item) {
      await ctx.message.reply(`No shop item matches **${itemId}**.`);
      return;
    }
    await ctx.message.reply([
      `**${item.name}**`,
      `ID: \`${item.id}\``,
      `Cost: **${item.cost} bread**`,
      `Type: ${item.type || "unknown"}`,
      item.description || "No description."
    ].join("\n"));
  }
});

define({
  name: "buy",
  category: "Gambling",
  description: "Buy a shop item with bread.",
  usage: "buy item-id",
  async run(ctx) {
    const itemId = cleanText(ctx.args[0], 60).toLowerCase();
    if (!itemId) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }
    const result = await purchaseShopItem(ctx.store, ctx.message.guild.id, ctx.message.author.id, ctx.message.member.displayName, itemId);
    if (!result.ok) {
      await ctx.message.reply(result.error);
      return;
    }
    await addAuditLog(ctx.store, ctx.message.guild.id, {
      type: "shop",
      label: "Shop purchase",
      details: `${ctx.message.author.tag} bought ${result.item.name}.`,
      actor: ctx.message.author.tag
    }).catch(() => {});
    await ctx.message.reply(`Purchased **${result.item.name}** for **${result.item.cost} bread**.`);
  }
});

define({
  name: "inventory",
  category: "Gambling",
  description: "Show your bought items and collectibles.",
  usage: "inventory [@user]",
  async run(ctx) {
    const member = mentionTargetUser(ctx.message);
    const profile = profileFor(ctx.config, member.id, member.displayName);
    await ctx.message.reply(`**${member.displayName}'s Inventory**\n${formatInventory(profile)}`);
  }
});

define({
  name: "quests",
  aliases: ["quest"],
  category: "Chipkittle",
  description: "Show your daily and weekly Chipkittle quests.",
  async run(ctx) {
    const daily = questFor(ctx.config, ctx.message.author.id, "daily");
    const weekly = questFor(ctx.config, ctx.message.author.id, "weekly");
    await ctx.message.reply([
      "**Chipkittle Quests**",
      `Daily streak: **${ctx.config.community?.questStreaks?.[ctx.message.author.id]?.daily || 0}**`,
      "",
      "**Daily**",
      formatQuest({ ...daily, reward: 250 }),
      "",
      "**Weekly**",
      formatQuest({ ...weekly, reward: 1200 }),
      "",
      `Claim finished quests with \`${ctx.config.prefix}questclaim\`.`
    ].join("\n"));
  }
});

define({
  name: "questclaim",
  aliases: ["claimquest", "claimquests"],
  category: "Chipkittle",
  description: "Claim bread rewards for completed daily and weekly quests.",
  async run(ctx) {
    const quests = [
      { ...questFor(ctx.config, ctx.message.author.id, "daily"), reward: 250 },
      { ...questFor(ctx.config, ctx.message.author.id, "weekly"), reward: 1200 }
    ];
    const claimable = quests.filter((quest) => quest.complete && !quest.claimed);
    if (!claimable.length) {
      await ctx.message.reply("No completed unclaimed quests yet. Check `!quests` to see what the artifact wants today.");
      return;
    }

    const totalReward = claimable.reduce((sum, quest) => sum + quest.reward, 0);
    const result = await updateBreadEconomy(ctx, (economy) => {
      const nextBalance = breadBalance(economy, ctx.message.author.id) + totalReward;
      setBreadBalance(economy, ctx.message.author.id, nextBalance);
      recordEconomyTransaction(economy, {
        userId: ctx.message.author.id,
        type: "quest-claim",
        amount: totalReward,
        balance: nextBalance,
        note: claimable.map((quest) => quest.title).join(", ")
      });
      return { balance: nextBalance };
    });

    const streak = await markQuestClaims(ctx, ctx.message.author.id, claimable);
    await updateProfile(ctx.store, ctx.message.guild.id, ctx.message.author.id, (profile) => ({
      ...profile,
      displayName: ctx.message.member.displayName,
      manualAchievements: [...new Set([...(profile.manualAchievements || []), "Quest Claimer"])].slice(0, 20)
    }), ctx.message.member.displayName).catch(() => {});
    await addAuditLog(ctx.store, ctx.message.guild.id, {
      type: "quest",
      label: "Quest reward claimed",
      details: `${ctx.message.author.tag} claimed ${totalReward} bread from ${claimable.length} quest reward${claimable.length === 1 ? "" : "s"}.`,
      actor: ctx.message.author.tag,
      targetId: ctx.message.author.id,
      targetTag: ctx.message.author.tag
    }).catch(() => {});

    await ctx.message.reply([
      `Claimed **${totalReward} bread**.`,
      `New wallet balance: **${result.balance} bread**.`,
      `Daily quest streak: **${streak.daily}** day${streak.daily === 1 ? "" : "s"} (best **${streak.bestDaily}**).`,
      "",
      claimable.map((quest) => `- ${quest.title}`).join("\n")
    ].join("\n"));
  }
});

define({
  name: "achievementboard",
  aliases: ["achboard", "achievementleaderboard"],
  category: "Chipkittle",
  description: "Show who has stacked the most Chipkittle achievements.",
  async run(ctx) {
    const rows = Object.entries(ctx.config.community?.profiles || {})
      .map(([userId, profile]) => ({
        userId,
        displayName: profile.displayName || userId,
        achievements: derivedAchievements(ctx.config, userId, profile.displayName || userId)
      }))
      .filter((entry) => entry.achievements.length)
      .sort((a, b) => b.achievements.length - a.achievements.length || a.displayName.localeCompare(b.displayName))
      .slice(0, 10);
    if (!rows.length) {
      await ctx.message.reply("No achievements have been earned yet.");
      return;
    }
    await ctx.message.reply([
      "**Achievement Leaderboard**",
      rows.map((entry, index) => `${index + 1}. **${entry.displayName}** - ${entry.achievements.length} achievement${entry.achievements.length === 1 ? "" : "s"}`).join("\n")
    ].join("\n"));
  }
});

define({
  name: "registerartifact",
  category: "Chipkittle",
  description: "Staff-only command to add an artifact to the public registry.",
  usage: "registerartifact name | rarity | keeper | summary",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const [name, rarity, keeper, summary] = splitPipe(ctx.rest);
    if (!name || !summary) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }
    await addArtifact(ctx.store, ctx.message.guild.id, {
      name: cleanText(name, 80),
      rarity: cleanText(rarity || "Unknown", 40),
      keeper: cleanText(keeper || ctx.message.member.displayName, 80),
      summary: cleanText(summary, 260)
    });
    await addAuditLog(ctx.store, ctx.message.guild.id, {
      type: "artifact",
      label: "Artifact registered",
      details: `${name} was added to the registry.`,
      actor: ctx.message.author.tag
    }).catch(() => {});
    await ctx.message.reply(`Registered **${name}** in the artifact registry.`);
  }
});

define({
  name: "staffnote",
  category: "Moderation",
  description: "Add a private staff note for a member.",
  usage: "staffnote @user note",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const member = ctx.message.mentions.members.first();
    const note = cleanText(ctx.args.slice(1).join(" "), 180);
    if (!member || !note) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }
    const nextNotes = {
      ...(ctx.config.community?.staffNotes || {}),
      [member.id]: [
        {
          author: ctx.message.author.tag,
          note,
          createdAt: new Date().toISOString()
        },
        ...((ctx.config.community?.staffNotes?.[member.id] || []))
      ].slice(0, 20)
    };
    await ctx.store.updateGuild(ctx.message.guild.id, {
      community: {
        ...ctx.config.community,
        staffNotes: nextNotes
      }
    });
    await addAuditLog(ctx.store, ctx.message.guild.id, {
      type: "staff-note",
      label: "Staff note added",
      details: `A note was added for ${member.user.tag}.`,
      actor: ctx.message.author.tag
    }).catch(() => {});
    await ctx.message.reply(`Saved a staff note for ${member}.`);
  }
});

define({
  name: "notes",
  category: "Moderation",
  description: "Show staff notes for a member.",
  usage: "notes @user",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const member = ctx.message.mentions.members.first();
    if (!member) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }
    const notes = ctx.config.community?.staffNotes?.[member.id] || [];
    await ctx.message.reply(notes.length
      ? `**Staff notes for ${member.displayName}**\n${notes.slice(0, 8).map((entry) => `• ${entry.author}: ${entry.note}`).join("\n")}`
      : `No staff notes for ${member.displayName}.`);
  }
});

define({
  name: "clearnotes",
  aliases: ["clearstaffnotes", "noteclear"],
  category: "Moderation",
  description: "Clear private staff notes for a member.",
  usage: "clearnotes @user",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const member = ctx.message.mentions.members.first();
    if (!member) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }
    const nextNotes = { ...(ctx.config.community?.staffNotes || {}) };
    delete nextNotes[member.id];
    await ctx.store.updateGuild(ctx.message.guild.id, {
      community: {
        ...ctx.config.community,
        staffNotes: nextNotes
      }
    });
    await addAuditLog(ctx.store, ctx.message.guild.id, {
      type: "staff-note",
      label: "Staff notes cleared",
      details: `Cleared staff notes for ${member.user.tag}.`,
      actor: ctx.message.author.tag
    }).catch(() => {});
    await ctx.message.reply(`Cleared staff notes for ${member}.`);
  }
});

define({
  name: "leaderboard",
  aliases: ["gameleaderboard", "gamelb"],
  category: "Games",
  description: "Show the top scores for a public Chipkittle browser game.",
  usage: "leaderboard [dash|runner|mines|catch]",
  async run(ctx) {
    const gameId = cleanPublicGameId(ctx.args[0] || "dash");
    const limit = Math.max(Math.min(Number(ctx.config.publicSite?.games?.maxLeaderboardEntriesPerGame) || 10, 10), 1);
    const entries = publicGameEntries(readPublicLeaderboardEntries(), gameId, limit);
    if (!entries.length) {
      await ctx.message.reply(`No public scores are saved yet for **${publicGameLabel(gameId)}**.`);
      return;
    }
    await ctx.message.reply([
      `**${publicGameLabel(gameId)} Leaderboard**`,
      entries.map((entry, index) => `${index + 1}. **${entry.name}** — ${entry.score.toLocaleString()} points | ${entry.bread.toLocaleString()} bread`).join("\n")
    ].join("\n"));
  }
});

define({
  name: "gamerecords",
  aliases: ["records", "gameranks", "leaderboardall", "allleaderboards", "gameboards"],
  category: "Games",
  description: "Show the current top record holder for each public browser game.",
  async run(ctx) {
    const entries = readPublicLeaderboardEntries();
    const lines = PUBLIC_GAME_IDS
      .map((gameId) => {
        const top = publicGameEntries(entries, gameId, 1)[0];
        return top
          ? `• **${publicGameLabel(gameId)}** — ${top.name} with **${top.score.toLocaleString()}** points`
          : `• **${publicGameLabel(gameId)}** — no record yet`;
      });
    await ctx.message.reply([`**Public Game Records**`, ...lines].join("\n"));
  }
});

define({
  name: "ritualstatus",
  aliases: ["rituals", "communitystatus", "ritualpreview", "ritualinfo", "ritualpanel"],
  category: "Chipkittle",
  description: "Show the current Chipkittle ritual status and public event text.",
  async run(ctx) {
    const rituals = ctx.config.community?.rituals || {};
    const artifact = artifactOfTheDay(ctx.config);
    await ctx.message.reply([
      `**Chipkittle Ritual Status**`,
      `Current event: ${rituals.currentEvent || "No current event set."}`,
      `Seasonal message: ${rituals.seasonalMessage || "No seasonal message set."}`,
      `Next trial: ${rituals.nextTrial || "No next trial scheduled."}`,
      `Artifact of the day: ${artifact ? `${artifact.name} (${artifact.rarity})` : "None"}`
    ].join("\n"));
  }
});

define({
  name: "recordchannel",
  aliases: ["gamealerts", "recordalerts"],
  category: "Config",
  description: "Set which channel receives browser-game record alerts.",
  usage: "recordchannel [#channel|off]",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const raw = (ctx.args[0] || "").toLowerCase();
    if (!ctx.args[0]) {
      const channelId = gameRecordChannelId(ctx.config);
      await ctx.message.reply(channelId ? `Game record alerts go to <#${channelId}>.` : "No game record alert channel is configured.");
      return;
    }
    if (raw === "off" || raw === "none") {
      await ctx.store.updateGuild(ctx.message.guild.id, {
        publicSite: {
          games: {
            ...ctx.config.publicSite?.games,
            recordAlertChannelId: ""
          }
        }
      });
      await addAuditLog(ctx.store, ctx.message.guild.id, {
        type: "games",
        label: "Game record alerts disabled",
        details: "Disabled public game record alerts from a command.",
        actor: ctx.message.author.tag
      }).catch(() => {});
      await ctx.message.reply("Game record alerts are now disabled.");
      return;
    }
    const channel = targetTextChannel(ctx.message);
    if (!channel?.isTextBased?.()) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }
    await ctx.store.updateGuild(ctx.message.guild.id, {
      publicSite: {
        games: {
          ...ctx.config.publicSite?.games,
          recordAlertChannelId: channel.id
        }
      }
    });
    await addAuditLog(ctx.store, ctx.message.guild.id, {
      type: "games",
      label: "Game record alert channel updated",
      details: `Set game record alerts to #${channel.name}.`,
      actor: ctx.message.author.tag
    }).catch(() => {});
    await ctx.message.reply(`Game record alerts will now go to ${channel}.`);
  }
});

define({
  name: "suggestiondm",
  aliases: ["setsuggestiondm", "suggestionstaff", "suggestionchannel", "setsuggestionchannel", "suggestionlog"],
  category: "Config",
  description: "Set which Discord user receives suggestion DMs.",
  usage: "suggestiondm [discord-user-id|off]",
  async run(ctx) {
    if (!isPanelRootUser(ctx.config, ctx.message.author.id)) {
      await ctx.message.reply("Only root panel users can change the suggestion DM user.");
      return;
    }

    const raw = (ctx.args[0] || "").toLowerCase();
    if (!ctx.args[0]) {
      const userId = suggestionStaffUserId(ctx.config);
      await ctx.message.reply(userId ? `Suggestions are DM'd to <@${userId}>.` : "No suggestion DM user is configured.");
      return;
    }

    if (raw === "off" || raw === "none") {
      await ctx.store.updateGuild(ctx.message.guild.id, {
        publicSite: {
          suggestions: {
            ...ctx.config.publicSite?.suggestions,
            staffUserId: ""
          }
        }
      });
      await addAuditLog(ctx.store, ctx.message.guild.id, {
        type: "suggestions",
        label: "Suggestion DMs disabled",
        details: "Disabled staff suggestion DM forwarding from a command.",
        actor: ctx.message.author.tag
      }).catch(() => {});
      await ctx.message.reply("Suggestion DM forwarding is now disabled.");
      return;
    }

    const userId = String(ctx.args[0] || "").replace(/\D/g, "");
    if (!/^\d{16,22}$/.test(userId)) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }
    const user = await ctx.message.client.users.fetch(userId).catch(() => null);

    await ctx.store.updateGuild(ctx.message.guild.id, {
      publicSite: {
        suggestions: {
          ...ctx.config.publicSite?.suggestions,
          staffUserId: userId
        }
      }
    });
    await addAuditLog(ctx.store, ctx.message.guild.id, {
      type: "suggestions",
      label: "Suggestion DM user updated",
      details: `Set suggestion DMs to ${user?.tag || userId}.`,
      actor: ctx.message.author.tag
    }).catch(() => {});
    await ctx.message.reply(`Suggestions will now be DM'd to ${user ? user.tag : `<@${userId}>`}.`);
  }
});

define({
  name: "suggest",
  aliases: ["suggestion", "feedback"],
  category: "Community",
  description: "Send a suggestion to staff and the public suggestion queue.",
  usage: "suggest your idea",
  async run(ctx) {
    const body = cleanText(ctx.rest, 1000);
    if (body.length < 8) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }
    if (blockedSuggestionTerm(body, ctx.config)) {
      await ctx.message.reply("That suggestion contains blocked language.");
      return;
    }

    const suggestion = createSuggestionRecord({
      source: "discord",
      authorId: ctx.message.author.id,
      authorTag: ctx.message.author.tag,
      authorName: ctx.message.member?.displayName || ctx.message.author.username,
      body
    });
    const nextSuggestions = [suggestion, ...storedSuggestions(ctx.config)].slice(0, 250);

    await ctx.store.updateGuild(ctx.message.guild.id, {
      community: {
        ...ctx.config.community,
        suggestions: nextSuggestions
      }
    });
    await sendSuggestionStaffDm(ctx.message.client, ctx.config, suggestion);
    await addAuditLog(ctx.store, ctx.message.guild.id, {
      type: "suggestions",
      label: "Suggestion submitted",
      details: `${ctx.message.author.tag} submitted a suggestion.`,
      actor: ctx.message.author.tag
    }).catch(() => {});

    const extra = suggestionStaffUserId(ctx.config) ? "It was also DM'd to staff." : "No staff DM user is set yet, but it is saved in the panel.";
    await ctx.message.reply(`Suggestion submitted. ${extra}`);
  }
});

define({
  name: "beg",
  aliases: ["panhandle", "breadbeg"],
  category: "Gambling",
  description: "Beg the artifact for a little spare bread.",
  async run(ctx) {
    const output = await updateBreadEconomy(ctx, async (economy) => {
      const cooldown = persistentCooldownStatus(economy, "beg", ctx.message.author.id, 10 * 60_000);
      if (cooldown.limited) {
        return `The artifact already heard you. Try begging again in ${formatCooldown(cooldown.remainingMs)}.`;
      }
      setPersistentCooldown(economy, "beg", ctx.message.author.id);
      const amount = randomInt(25, 140);
      const nextBalance = breadBalance(economy, ctx.message.author.id) + amount;
      setBreadBalance(economy, ctx.message.author.id, nextBalance);
      return `A passing Chipkittle tosses you **${formatBread(amount)}**.\nBalance: **${formatBread(nextBalance)}**.`;
    });

    await ctx.message.reply(output);
  }
});

define({
  name: "work",
  aliases: ["breadwork", "shift"],
  category: "Gambling",
  description: "Work a suspiciously ceremonial shift for bread.",
  async run(ctx) {
    const jobs = [
      "polished the artifact display case",
      "stood guard at the Round Table",
      "swept ceremonial crumbs into the vault",
      "inspected the horns for structural excellence",
      "filed family records without asking questions"
    ];

    const output = await updateBreadEconomy(ctx, async (economy) => {
      const cooldown = persistentCooldownStatus(economy, "work", ctx.message.author.id, 30 * 60_000);
      if (cooldown.limited) {
        return `Your shift is still in progress. Try again in ${formatCooldown(cooldown.remainingMs)}.`;
      }
      setPersistentCooldown(economy, "work", ctx.message.author.id);
      const upgradeBonus = workBonusFor(economy, ctx.message.author.id);
      const amount = randomInt(90, 260) + upgradeBonus;
      const nextBalance = breadBalance(economy, ctx.message.author.id) + amount;
      setBreadBalance(economy, ctx.message.author.id, nextBalance);
      return `You ${jobs[randomInt(0, jobs.length - 1)]} and earned **${formatBread(amount)}**${upgradeBonus ? `, including **${formatBread(upgradeBonus)}** from work tools` : ""}.\nBalance: **${formatBread(nextBalance)}**.`;
    });

    await ctx.message.reply(output);
  }
});

define({
  name: "rob",
  aliases: ["breadrob", "stealbread", "mug"],
  category: "Gambling",
  description: "Attempt to steal bread from another member.",
  usage: "rob @user",
  async run(ctx) {
    const target = ctx.message.mentions.users.first?.();
    if (!target || target.bot || target.id === ctx.message.author.id) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }

    const output = await updateBreadEconomy(ctx, async (economy) => {
      const attackerId = ctx.message.author.id;
      const settings = economySettings(economy);
      const robberCooldown = persistentCooldownStatus(economy, "robbers", attackerId, settings.robCooldownMs);
      if (robberCooldown.limited) {
        return `Lay low for a bit. You can rob again in ${formatCooldown(robberCooldown.remainingMs)}.`;
      }
      const victimCooldown = persistentCooldownStatus(economy, "robVictims", target.id, settings.robCooldownMs);
      if (victimCooldown.limited) {
        return `**${target.username || target.tag}** was already mugged recently. They can be robbed again in ${formatCooldown(victimCooldown.remainingMs)}.`;
      }
      const victimBalance = breadBalance(economy, target.id);
      if (victimBalance < 50) {
        return `${target.username || target.tag} does not have enough bread worth stealing.`;
      }

      setPersistentCooldown(economy, "robbers", attackerId);
      setPersistentCooldown(economy, "robVictims", target.id);
      const success = Math.random() < 0.45;
      if (success) {
        const defense = robDefenseFor(economy, target.id);
        const maxSteal = Math.max(40, Math.floor(victimBalance * Math.max(0.08, 0.3 - defense)));
        const stolen = Math.min(randomInt(40, Math.max(60, maxSteal)), victimBalance, 1500);
        setBreadBalance(economy, target.id, victimBalance - stolen);
        setBreadBalance(economy, attackerId, breadBalance(economy, attackerId) + stolen);
        return `You slipped away with **${formatBread(stolen)}** from **${target.username || target.tag}**${defense ? ", but their bread shield softened the hit" : ""}.`;
      }

      const attackerBalance = breadBalance(economy, attackerId);
      const fine = Math.min(randomInt(20, 120), attackerBalance);
      setBreadBalance(economy, attackerId, attackerBalance - fine);
      setBreadBalance(economy, target.id, victimBalance + fine);
      return `The robbery failed. You had to pay **${formatBread(fine)}** back to **${target.username || target.tag}**.`;
    });

    await ctx.message.reply(output);
  }
});

define({
  name: "casinorob",
  aliases: ["casinoheist", "robcasino", "heistcasino", "breadheist"],
  category: "Gambling",
  description: "Attempt a high-risk robbery against the casino vault.",
  usage: "casinorob [stake]",
  async run(ctx) {
    const output = await updateBreadEconomy(ctx, async (economy) => {
      const userId = ctx.message.author.id;
      const settings = economySettings(economy);
      const cooldown = persistentCooldownStatus(economy, "casinoRobbery", userId, settings.casinoRobberyCooldownMs);
      if (cooldown.limited) {
        return `The casino security team still recognizes you. Try another heist in ${formatCooldown(cooldown.remainingMs)}.`;
      }

      const wallet = breadBalance(economy, userId);
      const bank = bankBalance(economy, userId);
      const netWorth = wallet + bank;
      if (netWorth < 500) {
        return "You need at least 500 total bread net worth before the casino takes your robbery seriously.";
      }

      const requestedStake = parseBreadAmount(ctx.args[0] || "500", wallet, Math.min(wallet, 25_000));
      const stake = Math.min(Math.max(requestedStake || 500, 250), wallet, 25_000);
      if (wallet < stake) {
        return `You need **${formatBread(stake)}** in your wallet for getaway money. Use \`${ctx.config.prefix}withdraw\` first if needed.`;
      }

      setPersistentCooldown(economy, "casinoRobbery", userId);
      const roll = randomInt(1, 100);
      let net = 0;
      let label = "";
      let detail = "";
      const disguiseLevel = casinoUpgradeLevel(economy, userId);
      const winMultiplier = 1 + disguiseLevel * 0.08;
      const lossMultiplier = Math.max(0.72, 1 - disguiseLevel * 0.06);

      if (roll >= 96) {
        net = Math.min(Math.floor(stake * randomInt(7, 10) * winMultiplier), 80_000);
        label = "Vault Jackpot";
        detail = "You cracked the ceremonial vault and escaped through the bread chute.";
      } else if (roll >= 76) {
        net = Math.min(Math.floor(stake * randomInt(3, 5) * winMultiplier), 35_000);
        label = "Clean Score";
        detail = "You slipped past the dealers and walked out with a suspiciously heavy coat.";
      } else if (roll >= 51) {
        net = Math.min(Math.floor(stake * 1.4 * winMultiplier), 12_000);
        label = "Messy Grab";
        detail = "You grabbed what you could before the pit boss noticed.";
      } else if (roll >= 21) {
        net = -Math.min(Math.floor(stake * 0.75 * lossMultiplier), wallet);
        label = "Security Chase";
        detail = "Security chased you into the parking lot and you dropped bread everywhere.";
      } else {
        net = -Math.min(Math.floor(stake * 1.6 * lossMultiplier), wallet);
        label = "Caught";
        detail = "The casino caught you, fined you, and made you apologize to the vault.";
      }

      setBreadBalance(economy, userId, wallet + net);
      recordEconomyTransaction(economy, {
        userId,
        type: "casino-robbery",
        stake,
        roll,
        net,
        balance: breadBalance(economy, userId),
        bank: bankBalance(economy, userId)
      });

      return [
        `**Casino Robbery: ${label}**`,
        detail,
        `Stake: **${formatBread(stake)}**`,
        ...(disguiseLevel ? [`Disguise bonus: **level ${disguiseLevel}**`] : []),
        `Result: **${formatNetBread(net)}**`,
        `Wallet: **${formatBread(breadBalance(economy, userId))}**`,
        `Cooldown: **${formatCooldown(settings.casinoRobberyCooldownMs)}**`
      ].join("\n");
    });

    await ctx.message.reply(output);
  }
});

define({
  name: "breadset",
  aliases: ["setbread", "balanceset"],
  category: "Gambling",
  description: "Staff-only bread balance setter.",
  usage: "breadset @user 5000",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const member = ctx.message.mentions.members.first();
    const amount = Math.max(Math.floor(Number(ctx.args.find((arg) => !arg.includes("<@")))), 0);
    if (!member || Number.isNaN(amount)) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }

    const output = await updateBreadEconomy(ctx, async (economy) => {
      setBreadBalance(economy, member.id, amount);
      recordEconomyTransaction(economy, {
        userId: member.id,
        type: "admin-set",
        amount,
        actorId: ctx.message.author.id,
        balance: breadBalance(economy, member.id),
        bank: bankBalance(economy, member.id)
      });
      return `${member} now has **${formatBread(amount)}**.`;
    });
    await ctx.message.reply(output);
  }
});

define({
  name: "breadadd",
  aliases: ["addbread", "breadgrant"],
  category: "Gambling",
  description: "Staff-only bread grant.",
  usage: "breadadd @user 500",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const member = ctx.message.mentions.members.first();
    const amount = Math.max(Math.floor(Number(ctx.args.find((arg) => !arg.includes("<@")))), 0);
    if (!member || !amount) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }

    const output = await updateBreadEconomy(ctx, async (economy) => {
      const nextBalance = breadBalance(economy, member.id) + amount;
      setBreadBalance(economy, member.id, nextBalance);
      recordEconomyTransaction(economy, {
        userId: member.id,
        type: "admin-add",
        amount,
        actorId: ctx.message.author.id,
        balance: nextBalance,
        bank: bankBalance(economy, member.id)
      });
      return `Added **${formatBread(amount)}** to ${member}.\nNew balance: **${formatBread(nextBalance)}**.`;
    });
    await ctx.message.reply(output);
  }
});

define({
  name: "breadtake",
  aliases: ["takebread", "breadremove"],
  category: "Gambling",
  description: "Staff-only bread removal.",
  usage: "breadtake @user 500",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const member = ctx.message.mentions.members.first();
    const amount = Math.max(Math.floor(Number(ctx.args.find((arg) => !arg.includes("<@")))), 0);
    if (!member || !amount) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }

    const output = await updateBreadEconomy(ctx, async (economy) => {
      const nextBalance = Math.max(breadBalance(economy, member.id) - amount, 0);
      setBreadBalance(economy, member.id, nextBalance);
      recordEconomyTransaction(economy, {
        userId: member.id,
        type: "admin-take",
        amount: -amount,
        actorId: ctx.message.author.id,
        balance: nextBalance,
        bank: bankBalance(economy, member.id)
      });
      return `Removed **${formatBread(amount)}** from ${member}.\nNew balance: **${formatBread(nextBalance)}**.`;
    });
    await ctx.message.reply(output);
  }
});

define({
  name: "giftitem",
  aliases: ["itemgift", "senditem"],
  category: "Gambling",
  description: "Give a shop item from your inventory to another member.",
  usage: "giftitem @user item-id",
  async run(ctx) {
    const member = ctx.message.mentions.members.first();
    const itemId = cleanText(ctx.args.slice(1).join(" "), 60).toLowerCase();
    if (!member || member.id === ctx.message.author.id || !itemId) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }

    const item = shopCatalog().find((entry) => entry.id === itemId);
    if (!item) {
      await ctx.message.reply(`No shop item matches **${itemId}**.`);
      return;
    }

    const senderProfile = profileFor(ctx.config, ctx.message.author.id, ctx.message.member.displayName);
    const senderOwned = Math.max(Number(senderProfile.inventory?.[item.id]) || 0, 0);
    if (senderOwned < 1) {
      await ctx.message.reply(`You do not own **${item.name}**.`);
      return;
    }

    await updateProfile(ctx.store, ctx.message.guild.id, ctx.message.author.id, (profile) => {
      const inventory = { ...(profile.inventory || {}) };
      inventory[item.id] = Math.max((inventory[item.id] || 0) - 1, 0);
      if (!inventory[item.id]) delete inventory[item.id];
      return {
        ...profile,
        displayName: ctx.message.member.displayName,
        inventory
      };
    }, ctx.message.member.displayName);

    await updateProfile(ctx.store, ctx.message.guild.id, member.id, (profile) => {
      const inventory = { ...(profile.inventory || {}) };
      inventory[item.id] = (inventory[item.id] || 0) + 1;
      const badges = [...(profile.badges || [])];
      if (item.type === "badge" && !badges.includes(item.name)) badges.push(item.name);
      return {
        ...profile,
        displayName: member.displayName,
        inventory,
        badges
      };
    }, member.displayName);

    await ctx.message.reply(`Gave **${item.name}** to ${member}.`);
  }
});

define({
  name: "inventorytop",
  aliases: ["itemleaderboard", "collectorboard"],
  category: "Chipkittle",
  description: "Show who has collected the most shop items.",
  async run(ctx) {
    const profiles = Object.entries(ctx.config.community?.profiles || {})
      .map(([userId, profile]) => ({
        userId,
        name: profile.displayName || `User ${userId}`,
        total: Object.values(profile.inventory || {}).reduce((sum, amount) => sum + Math.max(Number(amount) || 0, 0), 0)
      }))
      .filter((entry) => entry.total > 0)
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
      .slice(0, 10);

    if (!profiles.length) {
      await ctx.message.reply("Nobody has collected any items yet.");
      return;
    }

    await ctx.message.reply([
      `**Inventory Leaderboard**`,
      profiles.map((entry, index) => `${index + 1}. **${entry.name}** - ${entry.total} item${entry.total === 1 ? "" : "s"}`).join("\n")
    ].join("\n"));
  }
});

define({
  name: "badgeboard",
  aliases: ["badgeleaderboard", "badgetop"],
  category: "Chipkittle",
  description: "Show who has the most public badges.",
  async run(ctx) {
    const profiles = Object.values(ctx.config.community?.profiles || {})
      .map((profile) => ({
        name: profile.displayName || "Unknown Chipkittle",
        badges: Array.isArray(profile.badges) ? profile.badges.length : 0
      }))
      .filter((entry) => entry.badges > 0)
      .sort((a, b) => b.badges - a.badges || a.name.localeCompare(b.name))
      .slice(0, 10);

    if (!profiles.length) {
      await ctx.message.reply("No badges have been earned yet.");
      return;
    }

    await ctx.message.reply([
      `**Badge Leaderboard**`,
      profiles.map((entry, index) => `${index + 1}. **${entry.name}** - ${entry.badges} badge${entry.badges === 1 ? "" : "s"}`).join("\n")
    ].join("\n"));
  }
});

define({
  name: "auditlog",
  aliases: ["recentactions", "audit"],
  category: "Moderation",
  description: "Show recent panel and staff activity from the audit log.",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const events = (ctx.config.community?.auditLog || []).slice(0, 8);
    if (!events.length) {
      await ctx.message.reply("No audit events have been recorded yet.");
      return;
    }
    await ctx.message.reply([
      `**Recent Audit Log**`,
      events.map((entry) => `• **${entry.label || entry.type || "Event"}** - ${entry.details || "No details"}${entry.actor ? ` (${entry.actor})` : ""}`).join("\n")
    ].join("\n"));
  }
});

define({
  name: "modsummary",
  aliases: ["membermod", "punishmentsummary"],
  category: "Moderation",
  description: "Show warnings, punishment history, and staff notes for a member.",
  usage: "modsummary @user",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const member = ctx.message.mentions.members.first();
    if (!member) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }
    const warnings = ctx.config.moderation?.warnings?.[member.id] || [];
    const notes = ctx.config.community?.staffNotes?.[member.id] || [];
    const punishments = (ctx.config.community?.auditLog || [])
      .filter((entry) => String(entry.targetId || "") === member.id)
      .filter((entry) => String(entry.type || "") === "moderation" || ["warn", "timeout", "untimeout", "kick", "ban"].includes(String(entry.action || "")))
      .slice(0, 5);
    await ctx.message.reply([
      `**Moderation Summary: ${member.displayName}**`,
      `Warnings: **${warnings.length}**`,
      `Staff notes: **${notes.length}**`,
      `Punishments: **${punishments.length} shown**`,
      "",
      punishments.length ? punishments.map((entry) => `- ${entry.label || entry.action || "Moderation action"} - ${entry.details || "No details"}`).join("\n") : "No recent punishments."
    ].join("\n"));
  }
});

define({
  name: "applicationstatus",
  aliases: ["appstatus", "applystatus"],
  category: "Applications",
  description: "Check a member's application cooldown and open review thread.",
  usage: "applicationstatus [@user]",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild) && ctx.message.mentions.members.first()) {
      return;
    }
    const member = ctx.message.mentions.members.first() || ctx.message.member;
    const ticket = ctx.config.applications?.tickets?.[member.id] || null;
    const cooldown = applicationCooldownStatus(ctx.config, member.id);
    await ctx.message.reply([
      `**Application Status: ${member.displayName}**`,
      `Open review thread: ${ticket?.channelId ? `<#${ticket.channelId}>` : "None"}`,
      `DM question progress: ${ticket?.step ? `${ticket.step}/${applicationQuestions().length}` : "No active application"}`,
      `Cooldown: ${cooldown.limited ? formatCooldown(cooldown.remainingMs) : "No cooldown"}`
    ].join("\n"));
  }
});

define({
  name: "openapplications",
  aliases: ["appsopen", "applicationqueue"],
  category: "Applications",
  description: "List the currently open application review threads.",
  async run(ctx) {
    if (!isApplicationStaff(ctx) && !requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const entries = Object.entries(ctx.config.applications?.tickets || {}).slice(0, 10);
    if (!entries.length) {
      await ctx.message.reply("There are no open applications right now.");
      return;
    }
    await ctx.message.reply([
      `**Open Applications**`,
      entries.map(([userId, ticket]) => `• <@${userId}> - ${ticket.channelId ? `<#${ticket.channelId}>` : "missing thread"} - question ${ticket.step || 0}/${applicationQuestions().length}`).join("\n")
    ].join("\n"));
  }
});

define({
  name: "aistatus",
  aliases: ["chipstatusai", "aiinfo", "aichannels", "ailist", "aiconfigchannels"],
  category: "AI",
  description: "Show the current AI settings without editing them.",
  async run(ctx) {
    const budget = aiBudgetStatus(ctx.config);
    await ctx.message.reply([
      `**Chipkittle AI Status**`,
      `Enabled: **${ctx.config.ai.enabled ? "Yes" : "No"}**`,
      `Mode: **${ctx.config.ai.mode === "evil" ? "evil" : "normal"}**`,
      `Chaos: **${ctx.config.ai.chaosLevel || 3}/10**`,
      `Lore strictness: **${ctx.config.ai.loreStrictness || "balanced"}**`,
      `Response length: **${ctx.config.ai.responseLength || "normal"}**`,
      `Model: **${ctx.config.ai.model || ctx.defaultAiModel}**`,
      `Cooldown: **${ctx.config.ai.apiCooldownSeconds}s**`,
      `Usage: **${budget.usage.requests.toLocaleString()}** requests / **${budget.usage.estimatedTokens.toLocaleString()}** estimated tokens${budget.budget ? ` of **${budget.budget.toLocaleString()}**` : ""}`,
      `Allowed roles: ${(ctx.config.ai.allowedRoleIds || []).length ? ctx.config.ai.allowedRoleIds.map((roleId) => `<@&${roleId}>`).join(", ") : "everyone"}`,
      `Whitelisted channels: ${channelMentionList(ctx.config.ai.channelIds)}`,
      `Blacklisted channels: ${channelMentionList(ctx.config.ai.blacklistedChannelIds || [])}`
    ].join("\n"));
  }
});

define({
  name: "aipreview",
  aliases: ["promptpreview", "aiprompt"],
  category: "AI",
  description: "Preview the current extra AI personality guidance.",
  async run(ctx) {
    const personality = ctx.config.ai.personality?.trim();
    await ctx.message.reply([
      `**AI Personality Preview**`,
      `Mode: **${ctx.config.ai.mode === "evil" ? "evil" : "normal"}**`,
      personality ? personality.slice(0, 1200) : "No extra personality guidance set."
    ].join("\n"));
  }
});

define({
  name: "gameinfo",
  aliases: ["gameabout", "browsergame"],
  category: "Games",
  description: "Show details about one public Chipkittle browser game.",
  usage: "gameinfo [dash|runner|mines|catch]",
  async run(ctx) {
    const gameId = cleanPublicGameId(ctx.args[0] || "dash");
    const entries = publicGameEntries(readPublicLeaderboardEntries(), gameId, 1);
    const top = entries[0];
    const descriptions = {
      dash: "A fast score-chasing run where you claim bread after surviving the chaos.",
      runner: "A ritual obstacle run for pure score, timing, and dignity management.",
      mines: "A risky bread-picking game where one bad click ruins the ceremony.",
      catch: "A reflex game about catching bread and not fumbling the offering."
    };
    await ctx.message.reply([
      `**${publicGameLabel(gameId)}**`,
      descriptions[gameId],
      top ? `Current record: **${top.name}** with **${top.score.toLocaleString()}** points.` : "No public record yet.",
      `Use \`${ctx.config.prefix}leaderboard ${gameId}\` to see the top scores.`
    ].join("\n"));
  }
});

define({
  name: "gamerank",
  aliases: ["findrank", "leaderboardrank"],
  category: "Games",
  description: "Find a player's rank on a public game leaderboard by display name.",
  usage: "gamerank [dash|runner|mines|catch] player name",
  async run(ctx) {
    const gameId = cleanPublicGameId(ctx.args[0] || "dash");
    const query = ctx.args.slice(1).join(" ").trim().toLowerCase();
    if (!query) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }
    const entries = publicGameEntries(readPublicLeaderboardEntries(), gameId, 100);
    const index = entries.findIndex((entry) => entry.name.toLowerCase().includes(query));
    if (index === -1) {
      await ctx.message.reply(`Nobody named **${ctx.args.slice(1).join(" ").trim()}** is on the **${publicGameLabel(gameId)}** board right now.`);
      return;
    }
    const entry = entries[index];
    await ctx.message.reply(`**${entry.name}** is rank **#${index + 1}** on **${publicGameLabel(gameId)}** with **${entry.score.toLocaleString()}** points.`);
  }
});

define({
  name: "recordalerttest",
  aliases: ["testrecordalert", "gametestalert"],
  category: "Games",
  description: "Send a test message to the configured game record alert channel.",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const channelId = gameRecordChannelId(ctx.config);
    if (!channelId) {
      await ctx.message.reply("No record alert channel is configured.");
      return;
    }
    const channel =
      ctx.message.guild.channels.cache.get(channelId) ||
      (await ctx.message.guild.channels.fetch(channelId).catch(() => null));
    if (!channel?.isTextBased()) {
      await ctx.message.reply("The configured record alert channel is missing or unusable.");
      return;
    }
    await channel.send({
      embeds: [
        buildPrettyEmbed({
          title: "Game Record Alert Test",
          description: "This is a test ping from the Chipkittle panel/bot command flow.",
          color: 0x65d6ad,
          footer: `Requested by ${ctx.message.author.tag}`
        })
      ],
      allowedMentions: NO_MENTIONS
    }).catch(() => {});
    await ctx.message.reply(`Sent a test alert to <#${channelId}>.`);
  }
});

define({
  name: "shopsearch",
  aliases: ["finditem", "catalogsearch"],
  category: "Gambling",
  description: "Search the shop catalog by name or description.",
  usage: "shopsearch keyword",
  async run(ctx) {
    const query = ctx.rest.trim().toLowerCase();
    if (!query) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }
    const matches = shopCatalog()
      .filter((item) =>
        [item.id, item.name, item.description, item.type]
          .some((field) => String(field || "").toLowerCase().includes(query))
      )
      .slice(0, 8);
    if (!matches.length) {
      await ctx.message.reply(`No shop items matched **${ctx.rest.trim()}**.`);
      return;
    }
    await ctx.message.reply(matches.map((item) => `• **${item.name}** (\`${item.id}\`) - ${item.cost} bread\n  ${item.description}`).join("\n"));
  }
});

define({
  name: "itemowners",
  aliases: ["whohasitem", "ownersof"],
  category: "Chipkittle",
  description: "Show who owns a given shop item.",
  usage: "itemowners item-id",
  async run(ctx) {
    const itemId = cleanText(ctx.rest || ctx.args[0], 60).toLowerCase();
    if (!itemId) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }
    const item = shopCatalog().find((entry) => entry.id === itemId);
    if (!item) {
      await ctx.message.reply(`No shop item matches **${itemId}**.`);
      return;
    }
    const owners = Object.values(ctx.config.community?.profiles || {})
      .map((profile) => ({
        name: profile.displayName || "Unknown Chipkittle",
        amount: Math.max(Number(profile.inventory?.[item.id]) || 0, 0)
      }))
      .filter((entry) => entry.amount > 0)
      .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name))
      .slice(0, 10);
    await ctx.message.reply([
      `**Owners of ${item.name}**`,
      owners.length
        ? owners.map((entry, index) => `${index + 1}. **${entry.name}** - ${entry.amount}`).join("\n")
        : "Nobody owns that item yet."
    ].join("\n"));
  }
});

define({
  name: "vouchesfor",
  aliases: ["whoivouched", "myvouches"],
  category: "Chipkittle",
  description: "Show who a member has vouched for.",
  usage: "vouchesfor [@user]",
  async run(ctx) {
    const member = mentionTargetUser(ctx.message);
    const profiles = Object.values(ctx.config.community?.profiles || {});
    const targets = profiles
      .filter((profile) => (profile.vouches || []).some((entry) => entry.userId === member.id))
      .map((profile) => profile.displayName || "Unknown Chipkittle")
      .slice(0, 12);
    await ctx.message.reply([
      `**Vouches By ${member.displayName}**`,
      targets.length ? targets.map((name) => `• ${name}`).join("\n") : "No recorded vouches."
    ].join("\n"));
  }
});

define({
  name: "whovouched",
  aliases: ["vouchers", "vouchedby"],
  category: "Chipkittle",
  description: "Show who vouched for a member.",
  usage: "whovouched [@user]",
  async run(ctx) {
    const member = mentionTargetUser(ctx.message);
    const profile = profileFor(ctx.config, member.id, member.displayName);
    await ctx.message.reply([
      `**Vouched By: ${member.displayName}**`,
      profile.vouches.length
        ? profile.vouches.map((entry) => `• ${entry.name || "Unknown"}${entry.reason ? ` - ${entry.reason}` : ""}`).join("\n")
        : "No one has vouched for this member yet."
    ].join("\n"));
  }
});

define({
  name: "topvouched",
  aliases: ["vouchleaderboard", "vouchtop"],
  category: "Chipkittle",
  description: "Show the members with the most vouches.",
  async run(ctx) {
    const profiles = Object.values(ctx.config.community?.profiles || {})
      .map((profile) => ({
        name: profile.displayName || "Unknown Chipkittle",
        vouches: Array.isArray(profile.vouches) ? profile.vouches.length : 0
      }))
      .filter((entry) => entry.vouches > 0)
      .sort((a, b) => b.vouches - a.vouches || a.name.localeCompare(b.name))
      .slice(0, 10);
    await ctx.message.reply([
      `**Top Vouched Members**`,
      profiles.length
        ? profiles.map((entry, index) => `${index + 1}. **${entry.name}** - ${entry.vouches} vouch${entry.vouches === 1 ? "" : "es"}`).join("\n")
        : "No vouches have been recorded yet."
    ].join("\n"));
  }
});

define({
  name: "questfor",
  aliases: ["questuser", "memberquest"],
  category: "Chipkittle",
  description: "Show the daily and weekly quests for a member.",
  usage: "questfor [@user]",
  async run(ctx) {
    const member = mentionTargetUser(ctx.message);
    await ctx.message.reply([
      `**Quests For ${member.displayName}**`,
      `Daily: ${dailyQuestFor(member.id)}`,
      `Weekly: ${weeklyQuestFor(member.id)}`
    ].join("\n"));
  }
});

define({
  name: "gamelist",
  aliases: ["games", "browsergames"],
  category: "Games",
  description: "List the public Chipkittle browser games.",
  async run(ctx) {
    await ctx.message.reply([
      `**Chipkittle Browser Games**`,
      PUBLIC_GAME_IDS.map((gameId) => `• **${publicGameLabel(gameId)}** — use \`${ctx.config.prefix}gameinfo ${gameId}\``).join("\n")
    ].join("\n"));
  }
});

define({
  name: "modlogstatus",
  aliases: ["logstatus", "moderationlog"],
  category: "Moderation",
  description: "Show where moderation logs are being sent.",
  async run(ctx) {
    const channelId = ctx.config.moderation?.logChannelId;
    await ctx.message.reply(channelId ? `Moderation logs go to <#${channelId}>.` : "No moderation log channel is configured.");
  }
});

define({
  name: "applicationquestions",
  aliases: ["appquestions", "applyquestions"],
  category: "Applications",
  description: "Show the current application form questions.",
  async run(ctx) {
    await ctx.message.reply([
      `**Application Questions**`,
      applicationQuestions().map((question, index) => `${index + 1}. ${question}`).join("\n")
    ].join("\n"));
  }
});

define({
  name: "permissions",
  aliases: ["perms", "permissioncheck"],
  category: "Info",
  description: "Show a member's effective Discord permissions.",
  usage: "permissions [@user]",
  async run(ctx) {
    const member = mentionTargetUser(ctx.message);
    const permissions = member.permissions.toArray();
    await ctx.message.reply([
      `**Permissions: ${member.displayName}**`,
      permissions.length ? permissions.slice(0, 30).join(", ") : "No explicit permissions."
    ].join("\n"));
  }
});

define({
  name: "whohasrole",
  aliases: ["rolemembers", "memberswithrole"],
  category: "Info",
  description: "List members who have a given role.",
  usage: "whohasrole @role",
  async run(ctx) {
    const role = mentionRole(ctx.message);
    if (!role) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }
    const members = [...role.members.values()].slice(0, 20);
    await ctx.message.reply([
      `**Members With ${role.name}**`,
      members.length
        ? members.map((member) => `• ${member.displayName}`).join("\n")
        : "No members have that role.",
      role.members.size > members.length ? `\nShowing ${members.length} of ${role.members.size}.` : ""
    ].filter(Boolean).join("\n"));
  }
});

define({
  name: "nickname",
  aliases: ["nick", "setnick"],
  category: "Moderation",
  description: "Change a member's nickname.",
  usage: "nickname @user new nickname",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageNicknames)) return;
    const member = ctx.message.mentions.members.first();
    const nickname = cleanText(ctx.args.slice(1).join(" "), 32);
    if (!member || !nickname) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }
    if (!(await canModerateTarget(ctx, member, "change nickname for", "manageable", "Manage Nicknames"))) return;
    const completed = await runModerationAction(
      ctx,
      member,
      "change nickname for",
      () => member.setNickname(nickname, `Changed by ${ctx.message.author.tag}`),
      "Manage Nicknames"
    );
    if (!completed) return;
    const output = `Changed ${member.user.tag}'s nickname to **${nickname}**.`;
    await ctx.message.reply(output);
    await sendModerationLog(ctx, output);
  }
});

define({
  name: "blockedwords",
  aliases: ["wordlist", "automodwords"],
  category: "Config",
  description: "Show the current automod blocked words.",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const blockedWords = (ctx.config.automod?.blockedWords || []).map(normalizeBlockedWord).filter(Boolean);
    await ctx.message.reply([
      `**Blocked Words**`,
      blockedWords.length ? blockedWords.map((word) => `• \`${word}\``).join("\n") : "No blocked words configured."
    ].join("\n"));
  }
});

define({
  name: "appcooldowns",
  aliases: ["applicationcooldowns", "cooldownqueue"],
  category: "Applications",
  description: "Show members currently on application cooldown.",
  async run(ctx) {
    if (!isApplicationStaff(ctx) && !requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const entries = Object.entries(ctx.config.applications?.cooldowns || {})
      .map(([userId, info]) => {
        const status = applicationCooldownStatus(ctx.config, userId);
        return {
          userId,
          remainingMs: status.remainingMs,
          active: status.limited,
          lastAppliedAt: info?.lastAppliedAt || ""
        };
      })
      .filter((entry) => entry.active)
      .sort((a, b) => b.remainingMs - a.remainingMs)
      .slice(0, 10);
    await ctx.message.reply([
      `**Application Cooldowns**`,
      entries.length
        ? entries.map((entry) => `• <@${entry.userId}> - ${formatCooldown(entry.remainingMs)} remaining`).join("\n")
        : "Nobody is on cooldown right now."
    ].join("\n"));
  }
});

define({
  name: "reviewerroles",
  aliases: ["approverroles", "appreviewers"],
  category: "Applications",
  description: "Show the current application reviewer, approved, and blocked roles.",
  async run(ctx) {
    await ctx.message.reply([
      `**Application Role Routing**`,
      `Reviewer roles: ${ctx.config.applications?.reviewerRoleIds?.length ? ctx.config.applications.reviewerRoleIds.map((roleId) => `<@&${roleId}>`).join(", ") : "None"}`,
      `Approved role: ${ctx.config.applications?.approvedRoleId ? `<@&${ctx.config.applications.approvedRoleId}>` : "None"}`,
      `Blocked applicant roles: ${ctx.config.applications?.blockedRoleIds?.length ? ctx.config.applications.blockedRoleIds.map((roleId) => `<@&${roleId}>`).join(", ") : "None"}`
    ].join("\n"));
  }
});

define({
  name: "commandaccess",
  aliases: ["commandroles", "who-can-run"],
  category: "Config",
  description: "Show role override access for a command.",
  usage: "commandaccess command-name",
  async run(ctx) {
    const raw = (ctx.args[0] || "").toLowerCase();
    const command = raw ? ctx.commands.get(raw) : null;
    if (!command) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }
    const roleIds = ctx.config.commandRoles?.overrides?.[command.name] || [];
    const allowedChannelIds = commandAllowedChannelIds(ctx.config, command.name);
    await ctx.message.reply([
      `**Command Access: ${ctx.config.prefix}${command.name}**`,
      `Category: ${command.category || "Other"}`,
      `Category disabled: ${isCategoryDisabled(ctx.config, command.category || "Other") ? "Yes" : "No"}`,
      `Disabled: ${isCommandDisabled(ctx.config, command.name) ? "Yes" : "No"}`,
      `Allowed channels: ${allowedChannelIds.length ? allowedChannelIds.map((channelId) => `<#${channelId}>`).join(", ") : "Any channel"}`,
      `Role overrides: ${roleIds.length ? roleIds.map((roleId) => `<@&${roleId}>`).join(", ") : "None"}`
    ].join("\n"));
  }
});

define({
  name: "ranklist",
  aliases: ["chipranks", "listranks"],
  category: "Chipkittle",
  description: "List the ceremonial Chipkittle ranks.",
  async run(ctx) {
    await ctx.message.reply([
      `**Chipkittle Ranks**`,
      CHIPKITTLE_LORE.ranks.map((rank, index) => `${index + 1}. ${rank}`).join("\n")
    ].join("\n"));
  }
});

define({
  name: "randomrank",
  aliases: ["rankroll", "rolerank"],
  category: "Chipkittle",
  description: "Roll a random ceremonial rank for yourself or another member.",
  usage: "randomrank [@user]",
  async run(ctx) {
    const member = mentionTargetUser(ctx.message);
    const rank = CHIPKITTLE_LORE.ranks[randomInt(0, CHIPKITTLE_LORE.ranks.length - 1)];
    await ctx.message.reply(`${member} has been ceremonially assigned **${rank}**.`);
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

  async function runCommand(command, message, config, args, rest, invokedName = command.name) {
    const restrictionMessage = commandRestrictionMessage(command, message, config);
    if (restrictionMessage) {
      const payload = toEmbedPayload(
        restrictionMessage,
        commandEmbedMeta({ command, config, message })
      );
      const sent = await message.reply(payload).then(() => true).catch(() => false);
      if (!sent && message.channel?.send) {
        await message.channel.send(payload).catch(() => {});
      }
      return true;
    }

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
        invokedName,
        command,
        commands: aliases,
        commandList: commandDefinitions
      });
      if (message.guild?.id) {
        await recordCommandUsage(options.store, message.guild.id, command.name, command.category).catch(() => {});
      }
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

    return runCommand(command, message, config, args, rest, commandName);
  }

  async function handleDmCommand(message, config) {
    if (!message.content.startsWith(config.prefix)) return false;

    const { commandName, args, rest } = splitArgs(message.content, config.prefix);
    const command = aliases.get(commandName);
    if (command?.name !== "chipify") return false;

    return runCommand(command, message, config, args, rest, commandName);
  }

  async function handleCommandByName(commandName, message, config, input = "") {
    const command = aliases.get(commandName);
    if (!command) return false;

    const parts = input ? input.split(/\s+/) : [];
    return runCommand(command, message, config, parts, input, commandName);
  }

  return {
    handleCommand,
    handleCommandByName,
    handleDmCommand,
    commandList: commandDefinitions
  };
}

