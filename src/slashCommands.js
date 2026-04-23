import { Collection, REST, Routes, SlashCommandBuilder } from "discord.js";

const SLOW_COMMANDS = new Set(["ask", "chipify"]);

function slashDescription(command) {
  return String(command.description || "Run a Chipkittle command.").slice(0, 100);
}

function inputDescription(command) {
  const usage = String(command.usage || "").trim();
  if (!usage) return "Optional command input.";

  const input = usage.replace(command.name, "").trim();
  return `Arguments, like: ${input || usage}`.slice(0, 100);
}

function commandAcceptsInput(command) {
  return Boolean(command.usage);
}

function addReminderAmountOption(builder, name) {
  return builder.addIntegerOption((option) =>
    option
      .setName(name)
      .setDescription(`Number of ${name}.`)
      .setMinValue(0)
      .setRequired(false)
  );
}

function addReminderOptions(builder) {
  builder
    .addStringOption((option) =>
      option
        .setName("message")
        .setDescription("What I should remind you about.")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("specific-date")
        .setDescription("Optional date/time, like 2026-05-01 14:30.")
        .setRequired(false)
    );

  addReminderAmountOption(builder, "years");
  addReminderAmountOption(builder, "months");
  addReminderAmountOption(builder, "weeks");
  addReminderAmountOption(builder, "days");
  addReminderAmountOption(builder, "hours");
  addReminderAmountOption(builder, "minutes");

  return builder;
}

function addTtsSubcommands(builder) {
  return builder
    .addSubcommand((subcommand) =>
      subcommand
        .setName("join")
        .setDescription("Join your voice channel and read messages from #ttsbot.")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("leave")
        .setDescription("Leave voice chat and stop reading #ttsbot.")
    );
}

export function buildSlashCommands(commandList) {
  return commandList.map((command) => {
    const builder = new SlashCommandBuilder()
      .setName(command.name)
      .setDescription(slashDescription(command));

    if (command.name === "remind") {
      return addReminderOptions(builder).toJSON();
    }

    if (command.name === "tts") {
      return addTtsSubcommands(builder).toJSON();
    }

    if (commandAcceptsInput(command)) {
      builder.addStringOption((option) =>
        option
          .setName("input")
          .setDescription(inputDescription(command))
          .setRequired(false)
      );
    }

    if (command.name === "chipify") {
      builder.addAttachmentOption((option) =>
        option
          .setName("image")
          .setDescription("Image to turn into a Chipkittle.")
          .setRequired(false)
      );
    }

    return builder.toJSON();
  });
}

async function registerGuildSlashCommands(rest, clientId, guildId, body) {
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
  console.log(`Registered ${body.length} slash command(s) for guild ${guildId}.`);
}

export async function registerSlashCommands({ token, clientId, guildId, guilds, commandList }) {
  if (!token || !clientId) {
    console.warn("Slash commands were not registered because DISCORD_TOKEN or CLIENT_ID is missing.");
    return;
  }

  const rest = new REST({ version: "10" }).setToken(token);
  const body = buildSlashCommands(commandList);

  if (guildId) {
    await registerGuildSlashCommands(rest, clientId, guildId, body);
    return;
  }

  const guildIds = [...(guilds?.keys?.() || [])];
  if (guildIds.length) {
    await Promise.all(guildIds.map((id) => registerGuildSlashCommands(rest, clientId, id, body)));
    return;
  }

  await rest.put(Routes.applicationCommands(clientId), { body });
  console.log(`Registered ${body.length} slash command(s) globally.`);
}

function parseMentions(input, guild) {
  const users = new Collection();
  const members = new Collection();
  const roles = new Collection();
  const channels = new Collection();

  for (const match of input.matchAll(/<@!?(\d+)>/g)) {
    const userId = match[1];
    const member = guild.members.cache.get(userId);
    const user = member?.user || guild.client.users.cache.get(userId);
    if (user) users.set(user.id, user);
    if (member) members.set(member.id, member);
  }

  for (const match of input.matchAll(/<@&(\d+)>/g)) {
    const role = guild.roles.cache.get(match[1]);
    if (role) roles.set(role.id, role);
  }

  for (const match of input.matchAll(/<#(\d+)>/g)) {
    const channel = guild.channels.cache.get(match[1]);
    if (channel) channels.set(channel.id, channel);
  }

  return { users, members, roles, channels };
}

function normalizeReplyPayload(payload) {
  return typeof payload === "string" ? { content: payload } : payload;
}

function parseReminderDate(input) {
  const value = String(input || "").trim();
  if (!value) return null;

  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return null;

  const delayMs = date.getTime() - Date.now();
  return delayMs > 0 ? delayMs : null;
}

function reminderInput(interaction) {
  const message = interaction.options.getString("message", true).trim();
  if (!message) return "";

  const specificDate = interaction.options.getString("specific-date");
  if (specificDate) {
    const delayMs = parseReminderDate(specificDate);
    return delayMs ? `ms:${delayMs} ${message}` : "";
  }

  const unitMilliseconds = {
    years: 365 * 86_400_000,
    months: 30 * 86_400_000,
    weeks: 7 * 86_400_000,
    days: 86_400_000,
    hours: 3_600_000,
    minutes: 60_000
  };
  const duration = Object.entries(unitMilliseconds).reduce((total, [name, milliseconds]) => {
    const amount = interaction.options.getInteger(name) || 0;
    return total + amount * milliseconds;
  }, 0);

  return duration > 0 ? `ms:${duration} ${message}` : "";
}

function inputForInteraction(interaction) {
  if (interaction.commandName === "remind") return reminderInput(interaction);
  if (interaction.commandName === "tts") return interaction.options.getSubcommand();
  return interaction.options.getString("input") || "";
}

function createInteractionMessage(interaction, input) {
  const content = `/${interaction.commandName}${input ? ` ${input}` : ""}`;
  const mentions = parseMentions(input, interaction.guild);
  const attachments = new Collection();
  const image = interaction.options.getAttachment("image");
  if (image) attachments.set(image.id, image);
  let firstReplySent = false;

  async function reply(payload) {
    const options = normalizeReplyPayload(payload);
    if (interaction.deferred && !firstReplySent) {
      firstReplySent = true;
      return interaction.editReply(options);
    }

    if (!interaction.replied && !interaction.deferred) {
      firstReplySent = true;
      await interaction.reply(options);
      return interaction.fetchReply();
    }
    firstReplySent = true;
    return interaction.followUp(options);
  }

  return {
    id: interaction.id,
    content,
    commandPrefix: "/",
    createdTimestamp: interaction.createdTimestamp,
    author: interaction.user,
    member: interaction.member,
    guild: interaction.guild,
    channel: interaction.channel,
    channelId: interaction.channelId,
    attachments,
    mentions,
    reference: null,
    reply,
    hasSlashReply: () => firstReplySent,
    delete: async () => {},
    url: `https://discord.com/channels/${interaction.guildId}/${interaction.channelId}`
  };
}

export async function handleSlashCommand(interaction, { handleCommandByName, store }) {
  if (!interaction.isChatInputCommand() || !interaction.guild) return false;

  const config = store.getGuild(interaction.guild.id);
  const input = inputForInteraction(interaction);
  const message = createInteractionMessage(interaction, input.trim());

  if (SLOW_COMMANDS.has(interaction.commandName)) {
    await interaction.deferReply();
  }

  const handled = await handleCommandByName(interaction.commandName, message, config, input.trim());
  if (handled && !message.hasSlashReply() && !interaction.replied) {
    if (interaction.deferred) {
      await interaction.editReply("Done.");
    } else {
      await interaction.reply({ content: "Done.", ephemeral: true });
    }
  }

  return handled;
}
