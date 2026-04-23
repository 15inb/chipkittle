import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionsBitField
} from "discord.js";
import { checkAiRateLimit } from "./aiRateLimit.js";
import { handleApplicationDm } from "./applicationTickets.js";
import { commandList, createCommandHandler } from "./commands.js";
import { NO_MENTIONS } from "./discordSafety.js";
import { buildPrettyEmbed } from "./embedOutput.js";
import { handleSlashCommand, registerSlashCommands } from "./slashCommands.js";
import { TtsVoiceService } from "./ttsVoice.js";

const invitePattern = /(discord\.gg|discord(?:app)?\.com\/invite)\/[a-z0-9-]+/i;
const linkPattern = /https?:\/\/\S+/i;

function formatWelcomeMessage(template, member) {
  return template
    .replaceAll("{user}", `<@${member.id}>`)
    .replaceAll("{username}", member.displayName)
    .replaceAll("{server}", member.guild.name);
}

async function sendModerationLog(guild, store, content) {
  const config = store.getGuild(guild.id);
  const channelId = config.moderation.logChannelId;

  if (!channelId) return;

  const channel = guild.channels.cache.get(channelId);
  if (!channel?.isTextBased()) return;

  await channel
    .send({
      embeds: [
        buildPrettyEmbed({
          title: "Automod Log",
          description: content,
          color: 0xef4444,
          footer: guild.name
        })
      ],
      allowedMentions: NO_MENTIONS
    })
    .catch(() => {});
}

function shouldModerate(content, automod) {
  if (!automod.enabled) return null;

  const lowerContent = content.toLowerCase();
  const blockedWord = automod.blockedWords.find((word) => {
    const normalized = word.trim().toLowerCase();
    return normalized && lowerContent.includes(normalized);
  });

  if (blockedWord) return `blocked word: ${blockedWord}`;
  if (automod.deleteInvites && invitePattern.test(content)) return "invite link";
  if (automod.deleteLinks && linkPattern.test(content)) return "web link";

  return null;
}

function shouldAiReply(message, config, clientUserId) {
  if (!config.ai.enabled) return false;
  if (message.content.startsWith(config.prefix)) return false;
  if ((config.ai.blacklistedChannelIds || []).includes(message.channel.id)) return false;
  if (config.ai.channelIds.includes(message.channel.id)) return true;
  return config.ai.replyToMentions && message.mentions.users.has(clientUserId);
}

function cleanAiPrompt(message, clientUserId) {
  return message.content.replaceAll(`<@${clientUserId}>`, "").replaceAll(`<@!${clientUserId}>`, "").trim();
}

export function createBot({ store, publicUrl, clientId, guildId, token, ai, defaultAiModel }) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
  });
  const tts = new TtsVoiceService({ ai });
  const { handleCommand, handleCommandByName, handleDmCommand, commandList } = createCommandHandler({
    client,
    store,
    publicUrl,
    clientId,
    ai,
    tts,
    defaultAiModel
  });

  function configForDirectMessage() {
    const guild = guildId
      ? client.guilds.cache.get(guildId)
      : client.guilds.cache.first();
    return guild ? store.getGuild(guild.id) : null;
  }

  client.once(Events.ClientReady, async (readyClient) => {
    await Promise.all(
      readyClient.guilds.cache.map((guild) => store.ensureGuild(guild.id))
    );
    await registerSlashCommands({
      token,
      clientId,
      guildId,
      guilds: readyClient.guilds.cache,
      commandList
    }).catch((error) => {
      console.error("Slash command registration failed:", error);
    });
    console.log(`Discord bot online as ${readyClient.user.tag}`);
  });

  client.on(Events.GuildCreate, async (guild) => {
    await store.ensureGuild(guild.id);
    if (!guildId || guildId === guild.id) {
      await registerSlashCommands({
        token,
        clientId,
        guildId: guild.id,
        commandList
      }).catch((error) => {
        console.error(`Slash command registration failed for guild ${guild.id}:`, error);
      });
    }
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    const config = store.getGuild(member.guild.id);

    if (config.autoRoleId) {
      await member.roles.add(config.autoRoleId).catch(() => {});
    }

    if (!config.welcome.enabled || !config.welcome.channelId) return;

    const channel = member.guild.channels.cache.get(config.welcome.channelId);
    if (!channel?.isTextBased()) return;

    await channel
      .send({ content: formatWelcomeMessage(config.welcome.message, member) })
      .catch(() => {});
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    await handleSlashCommand(interaction, { handleCommandByName, store }).catch((error) => {
      console.error("Slash command handling failed:", error);
      if (interaction.isRepliable()) {
        const payload = {
          content: "That slash command failed. Check my permissions and try again.",
          allowedMentions: NO_MENTIONS
        };
        if (interaction.replied || interaction.deferred) {
          interaction.followUp(payload).catch(() => {});
        } else {
          interaction.reply({ ...payload, ephemeral: true }).catch(() => {});
        }
      }
    });
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;

    if (!message.guild) {
      const dmConfig = configForDirectMessage();
      if (dmConfig && await handleDmCommand(message, dmConfig)) return;

      await handleApplicationDm({ client, store, message }).catch((error) => {
        console.error("Application DM handling failed:", error);
      });
      return;
    }

    const config = store.getGuild(message.guild.id);
    const handled = await handleCommand(message, config);
    if (handled) return;

    const ttsHandled = await tts.handleMessage(message);
    if (ttsHandled) return;

    if (shouldAiReply(message, config, client.user.id)) {
      const prompt = cleanAiPrompt(message, client.user.id);
      if (prompt) {
        const rateLimit = checkAiRateLimit({
          guildId: message.guild.id,
          userId: message.author.id,
          cooldownSeconds: config.ai.apiCooldownSeconds,
          bucket: "chat"
        });

        if (rateLimit.limited) {
          await message.reply({
            content: `The artifact is cooling down. Try again in ${rateLimit.retryAfterSeconds}s.`,
            allowedMentions: NO_MENTIONS
          }).catch(() => {});
          return;
        }

        await message.channel.sendTyping().catch(() => {});
        const reply = await ai.reply(message, config, prompt).catch((error) => {
          console.error("AI reply failed:", error);
          return "The artifact fizzled. Check the AI key/model settings and try again.";
        });
        await message.reply({ content: reply, allowedMentions: NO_MENTIONS }).catch(() => {});
        return;
      }
    }

    const reason = shouldModerate(message.content, config.automod);
    if (!reason) return;

    const canDelete = message.guild.members.me?.permissionsIn(message.channel).has(
      PermissionsBitField.Flags.ManageMessages
    );

    if (canDelete) {
      await message.delete().catch(() => {});
      await message.channel
        .send({ content: `${message.author}, your message was removed by automod.` })
        .then((notice) => setTimeout(() => notice.delete().catch(() => {}), 5000))
        .catch(() => {});
    }

    await sendModerationLog(
      message.guild,
      store,
      `Automod ${canDelete ? "removed" : "flagged"} a message from ${message.author.tag} in #${message.channel.name}: ${reason}`
    );
  });

  return client;
}

export { commandList };

export function serializeGuild(guild) {
  const channels = guild.channels.cache
    .filter((channel) => channel.type === ChannelType.GuildText)
    .map((channel) => ({
      id: channel.id,
      name: channel.name
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const categories = guild.channels.cache
    .filter((channel) => channel.type === ChannelType.GuildCategory)
    .map((channel) => ({
      id: channel.id,
      name: channel.name
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const roles = guild.roles.cache
    .filter((role) => !role.managed && role.name !== "@everyone")
    .map((role) => ({
      id: role.id,
      name: role.name,
      position: role.position
    }))
    .sort((a, b) => b.position - a.position);

  return {
    id: guild.id,
    name: guild.name,
    iconUrl: guild.iconURL({ size: 128 }),
    memberCount: guild.memberCount,
    channels,
    categories,
    roles
  };
}
