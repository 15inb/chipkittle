import { ChannelType, EmbedBuilder, PermissionsBitField } from "discord.js";
import { checkAiRateLimit } from "./aiRateLimit.js";
import {
  applicantIdFromChannel,
  applicationQuestions,
  clearApplicationTicket,
  findOpenApplicationChannel,
  isApplicationStaff as canUseApplicationCommand,
  saveApplicationTicket,
  ticketNameFor,
  ticketTopic
} from "./applicationTickets.js";
import {
  CHIPKITTLE_LORE,
  randomChipkittleName,
  randomChipkittleQuote
} from "./chipkittleLore.js";
import { NO_MENTIONS } from "./discordSafety.js";

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
  const approvedRoleId = config.applications.approvedRoleId;
  return hasAnyRole(member, [...blockedRoleIds, approvedRoleId].filter(Boolean));
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

function targetTextChannel(message) {
  return message.mentions.channels.first() || message.channel;
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
    await sent.edit(`Pong. Discord latency: ${sent.createdTimestamp - ctx.message.createdTimestamp}ms.`);
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
      `Invite link: https://discord.com/oauth2/authorize?client_id=${ctx.clientId}&permissions=268438608&scope=bot%20applications.commands`
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
  name: "purge",
  aliases: ["clear"],
  category: "Moderation",
  description: "Bulk delete recent messages.",
  usage: "purge 10",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageMessages)) return;
    const count = Math.min(Math.max(Number(ctx.args[0]) || 0, 1), 100);
    const deleted = await ctx.message.channel.bulkDelete(count, true).catch(() => null);
    await ctx.message.channel.send(`Deleted ${deleted?.size || 0} message(s).`).then((msg) => setTimeout(() => msg.delete().catch(() => {}), 4000));
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
    await ctx.message.reply(`${member} was warned: ${reason}`);
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
      await ctx.message.reply(`${member} has no warnings.`);
      return;
    }

    await ctx.message.reply(
      warnings
        .map((warning, index) => `${index + 1}. ${warning.reason} by <@${warning.moderatorId}>`)
        .join("\n")
        .slice(0, 1800)
    );
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
    await ctx.message.reply(`Cleared warnings for ${member}.`);
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
    await ctx.message.reply(`${member} timed out for ${formatDuration(duration)}.`);
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
    await ctx.message.reply(`${member} is no longer timed out.`);
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
    await ctx.message.reply(`${member.user.tag} was kicked.`);
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
    await ctx.message.reply(`${member.user.tag} was banned.`);
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
    await ctx.message.reply(`Slowmode set to ${seconds}s.`);
  }
});

define({
  name: "lock",
  category: "Moderation",
  description: "Lock the current channel for @everyone.",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageChannels)) return;
    await ctx.message.channel.permissionOverwrites.edit(ctx.message.guild.roles.everyone, { SendMessages: false });
    await ctx.message.reply("Channel locked.");
  }
});

define({
  name: "unlock",
  category: "Moderation",
  description: "Unlock the current channel for @everyone.",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageChannels)) return;
    await ctx.message.channel.permissionOverwrites.edit(ctx.message.guild.roles.everyone, { SendMessages: null });
    await ctx.message.reply("Channel unlocked.");
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
    const word = ctx.rest.trim().slice(0, 80);
    if (!word) {
      await ctx.message.reply(`Usage: \`${usage(ctx.config, this)}\``);
      return;
    }

    const blockedWords = [...new Set([...ctx.config.automod.blockedWords, word])];
    await ctx.store.updateGuild(ctx.message.guild.id, {
      automod: { ...ctx.config.automod, blockedWords }
    });
    await ctx.message.reply(`Added blocked word: \`${word}\`.`);
  }
});

define({
  name: "unblockword",
  category: "Config",
  description: "Remove an automod blocked word.",
  usage: "unblockword word",
  async run(ctx) {
    if (!requirePermission(ctx, PermissionsBitField.Flags.ManageGuild)) return;
    const word = ctx.rest.trim().toLowerCase();
    const blockedWords = ctx.config.automod.blockedWords.filter((item) => item.toLowerCase() !== word);
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
      cooldownSeconds: ctx.config.ai.apiCooldownSeconds
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
  description: "Open a private Chipkittle membership application ticket.",
  async run(ctx) {
    await deleteCommandMessage(ctx.message);

    const settings = ctx.config.applications;
    if (isBlockedFromApplying(ctx.message.member, ctx.config)) {
      return;
    }

    if (!settings.enabled) {
      await ctx.message.author.send("Applications are not enabled right now.").catch(() => {});
      return;
    }

    if (settings.channelId && ctx.message.channel.id !== settings.channelId) {
      await ctx.message.author.send(`Please start applications in #${ctx.message.guild.channels.cache.get(settings.channelId)?.name || "the application channel"}.`).catch(() => {});
      return;
    }

    const cooldown = applicationCooldownStatus(ctx.config, ctx.message.author.id);
    if (cooldown.limited) {
      await ctx.message.author.send(`You can open another application in ${formatCooldown(cooldown.remainingMs)}.`).catch(() => {});
      return;
    }

    const existing = findOpenApplicationChannel(ctx.message.guild, ctx.message.author.id, ctx.config);
    if (existing) {
      await ctx.message.author.send(`You already have an open application. Staff will review it in the ticket channel.`).catch(() => {});
      return;
    }

    const botMember = ctx.message.guild.members.me;
    if (!botMember?.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
      await ctx.message.reply("I need the Manage Channels permission to create application tickets.");
      return;
    }

    const questions = applicationQuestions(ctx.config);
    if (!questions.length) {
      await ctx.message.reply("No application questions are configured yet.");
      return;
    }

    const dmChannel = await ctx.message.author.createDM().catch(() => null);
    if (!dmChannel) {
      await ctx.message.reply("I could not open a DM with you. Please enable DMs from this server and try again.");
      return;
    }

    const reviewerRoleIds = settings.reviewerRoleIds || [];
    const permissionOverwrites = [
      {
        id: ctx.message.guild.roles.everyone.id,
        deny: [PermissionsBitField.Flags.ViewChannel]
      },
      {
        id: botMember.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
          PermissionsBitField.Flags.ManageChannels
        ]
      },
      ...reviewerRoleIds.map((roleId) => ({
        id: roleId,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory
        ]
      }))
    ];

    const channel = await ctx.message.guild.channels.create({
      name: ticketNameFor(ctx.message.member),
      type: ChannelType.GuildText,
      parent: settings.categoryId || undefined,
      topic: ticketTopic(ctx.message.author.id),
      permissionOverwrites
    });

    await saveApplicationTicket(ctx.store, ctx.message.guild.id, ctx.message.author.id, {
      channelId: channel.id,
      questionIndex: 0,
      completed: false
    });

    const questionList = questions.map((question, index) => `${index + 1}. ${question}`).join("\n");
    const reviewerMentions = reviewerRoleIds.map((roleId) => `<@&${roleId}>`).join(" ");

    await channel.send({
      content: [
        `Application ticket opened for ${ctx.message.author} (${ctx.message.author.tag}).`,
        reviewerMentions ? `Review team: ${reviewerMentions}` : "",
        "",
        "Applicant answers will appear here as they reply to the bot in DMs.",
        "Staff messages in this channel stay private unless sent with the reply command.",
        "",
        "Questions:",
        questionList,
        "",
        `Use \`${ctx.config.prefix}reply message\` to DM the applicant, \`${ctx.config.prefix}approve\` to approve, or \`${ctx.config.prefix}closeapplication\` to close.`
      ].filter(Boolean).join("\n"),
      allowedMentions: { users: [], roles: reviewerRoleIds }
    });

    const dmStarted = await dmChannel.send([
      `Your Chipkittle application has started for **${ctx.message.guild.name}**.`,
      "Answer each question here in DMs. Staff can read your answers in the private ticket channel.",
      "",
      `Question 1/${questions.length}: ${questions[0]}`
    ].join("\n")).then(() => true).catch(() => false);

    if (!dmStarted) {
      await clearApplicationTicket(ctx.store, ctx.message.guild.id, ctx.message.author.id);
      await channel.delete("Applicant DMs were closed").catch(() => {});
      await ctx.message.channel.send(`${ctx.message.author}, I could not DM you. Please enable DMs from this server and try again.`).catch(() => {});
      return;
    }

    await saveApplicationCooldown(ctx.store, ctx.message.guild.id, ctx.message.author.id);
  }
});

define({
  name: "reply",
  aliases: ["ticketreply"],
  category: "Applications",
  description: "Send a staff reply from an application ticket to the applicant's DMs.",
  usage: "reply message",
  async run(ctx) {
    await deleteCommandMessage(ctx.message);

    if (!isApplicationStaff(ctx)) {
      return;
    }

    const applicantId = applicantIdFromChannel(ctx.message.channel, ctx.config);
    if (!applicantId) {
      await ctx.message.channel.send("This does not look like an application ticket channel.").catch(() => {});
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

    const sent = await user.send(`**${ctx.message.guild.name} staff:** ${text}`).then(() => true).catch(() => false);
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
      await ctx.message.channel.send(`Usage: \`${usage(ctx.config, this)}\` inside an application ticket, or mention a user.`).catch(() => {});
      return;
    }

    const member = await ctx.message.guild.members.fetch(applicantId).catch(() => null);
    if (!member) {
      await ctx.message.channel.send("I could not find that applicant in this server.").catch(() => {});
      return;
    }

    const dmSent = await member.send(`Your application to **${ctx.message.guild.name}** was accepted.`).then(() => true).catch(() => false);

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
    setTimeout(() => {
      ctx.message.channel.delete("Application accepted").catch(() => {});
    }, 10_000);
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
      await ctx.message.channel.send(`Usage: \`${usage(ctx.config, this)}\` inside an application ticket, or mention a user.`).catch(() => {});
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
    const dmSent = await user.send(dmText).then(() => true).catch(() => false);

    await ctx.message.channel.send({
      content: `Application denied for <@${applicantId}>${reason ? `: ${reason}` : "."}${dmSent ? "" : " I could not DM them."}`,
      allowedMentions: NO_MENTIONS
    });
    await clearApplicationTicket(ctx.store, ctx.message.guild.id, applicantId);
    setTimeout(() => {
      ctx.message.channel.delete("Application denied").catch(() => {});
    }, 10_000);
  }
});

define({
  name: "closeapplication",
  aliases: ["closeticket", "close"],
  category: "Applications",
  description: "Close the current application ticket.",
  async run(ctx) {
    await deleteCommandMessage(ctx.message);

    if (!isApplicationStaff(ctx)) {
      return;
    }

    const applicantId = applicantIdFromChannel(ctx.message.channel, ctx.config);
    if (!applicantId) {
      await ctx.message.channel.send("This does not look like an application ticket channel.").catch(() => {});
      return;
    }

    await ctx.message.channel.send("Closing this application ticket in 5 seconds.").catch(() => {});
    setTimeout(() => {
      ctx.message.channel.delete("Application ticket closed").catch(() => {});
    }, 5000);
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

  async function handleCommand(message, config) {
    if (!message.content.startsWith(config.prefix)) return false;

    const { commandName, args, rest } = splitArgs(message.content, config.prefix);
    const command = aliases.get(commandName);
    if (!command) return false;

    try {
      await command.run({
        ...options,
        message,
        config,
        args,
        rest,
        command,
        commands: aliases,
        commandList: commandDefinitions
      });
    } catch (error) {
      console.error(`Command ${command.name} failed:`, error);
      await message.reply("That command failed. Check my permissions and try again.").catch(() => {});
    }

    return true;
  }

  return {
    handleCommand,
    commandList: commandDefinitions
  };
}

