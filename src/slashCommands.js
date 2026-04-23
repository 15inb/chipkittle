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

export function buildSlashCommands(commandList) {
  return commandList.map((command) => {
    const builder = new SlashCommandBuilder()
      .setName(command.name)
      .setDescription(slashDescription(command));

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
      return interaction.reply({ ...options, fetchReply: true });
    }
    firstReplySent = true;
    return interaction.followUp({ ...options, fetchReply: true });
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
  const input = interaction.options.getString("input") || "";
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
