import { EmbedBuilder, PermissionsBitField } from "discord.js";
import { checkAiRateLimit } from "./aiRateLimit.js";
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

function requirePermission(message, permission) {
  if (hasPermission(message.member, permission)) return true;
  message.reply("You do not have permission to use that command.");
  return false;
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
    if (!requirePermission(ctx.message, PermissionsBitField.Flags.ManageMessages)) return;
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
    if (!requirePermission(ctx.message, PermissionsBitField.Flags.ModerateMembers)) return;
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
    if (!requirePermission(ctx.message, PermissionsBitField.Flags.ModerateMembers)) return;
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
    if (!requirePermission(ctx.message, PermissionsBitField.Flags.ModerateMembers)) return;
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
    if (!requirePermission(ctx.message, PermissionsBitField.Flags.ModerateMembers)) return;
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
    if (!requirePermission(ctx.message, PermissionsBitField.Flags.ModerateMembers)) return;
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
    if (!requirePermission(ctx.message, PermissionsBitField.Flags.KickMembers)) return;
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
    if (!requirePermission(ctx.message, PermissionsBitField.Flags.BanMembers)) return;
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
    if (!requirePermission(ctx.message, PermissionsBitField.Flags.ManageChannels)) return;
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
    if (!requirePermission(ctx.message, PermissionsBitField.Flags.ManageChannels)) return;
    await ctx.message.channel.permissionOverwrites.edit(ctx.message.guild.roles.everyone, { SendMessages: false });
    await ctx.message.reply("Channel locked.");
  }
});

define({
  name: "unlock",
  category: "Moderation",
  description: "Unlock the current channel for @everyone.",
  async run(ctx) {
    if (!requirePermission(ctx.message, PermissionsBitField.Flags.ManageChannels)) return;
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
    if (!requirePermission(ctx.message, PermissionsBitField.Flags.ManageGuild)) return;
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
    if (!requirePermission(ctx.message, PermissionsBitField.Flags.ManageGuild)) return;
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
    if (!requirePermission(ctx.message, PermissionsBitField.Flags.ManageGuild)) return;
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
    if (!requirePermission(ctx.message, PermissionsBitField.Flags.ManageGuild)) return;
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
    if (!requirePermission(ctx.message, PermissionsBitField.Flags.ManageGuild)) return;
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
    if (!requirePermission(ctx.message, PermissionsBitField.Flags.ManageGuild)) return;
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
    if (!requirePermission(ctx.message, PermissionsBitField.Flags.ManageGuild)) return;
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
    if (!requirePermission(ctx.message, PermissionsBitField.Flags.ManageGuild)) return;
    const action = ctx.args[0]?.toLowerCase() || "status";
    if (action === "status") {
      await ctx.message.reply(
        `AI config: ${ctx.config.ai.enabled ? "on" : "off"} | channels: ${channelMentionList(ctx.config.ai.channelIds)} | model: ${ctx.config.ai.model || ctx.defaultAiModel} | cooldown: ${ctx.config.ai.apiCooldownSeconds}s | API key: ${ctx.ai.enabled ? "present" : "missing"}`
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
    if (!requirePermission(ctx.message, PermissionsBitField.Flags.ManageGuild)) return;
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
  name: "aimodel",
  category: "AI",
  description: "Set the AI model name.",
  usage: "aimodel gpt-5.2",
  async run(ctx) {
    if (!requirePermission(ctx.message, PermissionsBitField.Flags.ManageGuild)) return;
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
    if (!requirePermission(ctx.message, PermissionsBitField.Flags.ManageGuild)) return;
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
    if (!requirePermission(ctx.message, PermissionsBitField.Flags.ManageGuild)) return;
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
