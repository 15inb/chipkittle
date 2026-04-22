import { ChannelType, PermissionsBitField } from "discord.js";
import { buildPrettyEmbed } from "./embedOutput.js";

const TOPIC_PREFIX = "Chipkittle application";

export function applicationQuestions(config) {
  return (config.applications?.questions || []).filter(Boolean);
}

export function ticketNameFor(member) {
  const base = member.user.username
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `application-${base || member.id}`.slice(0, 90);
}

export function ticketTopic(userId, questionIndex = 0, completed = false) {
  return `${TOPIC_PREFIX}:${userId} question:${questionIndex} complete:${completed ? 1 : 0}`;
}

export function parseTicketTopic(topic = "") {
  const value = String(topic || "");
  const userId = value.match(/application:(\d+)/)?.[1] || "";
  const questionIndex = Number(value.match(/question:(\d+)/)?.[1] || 0);
  const completed = value.includes("complete:1");

  return { userId, questionIndex, completed };
}

function storedTicket(config, userId) {
  const ticket = config.applications?.tickets?.[userId];
  if (!ticket?.channelId) return null;

  return {
    channelId: ticket.channelId,
    questionIndex: Number(ticket.questionIndex) || 0,
    completed: Boolean(ticket.completed)
  };
}

export function applicantIdFromChannel(channel, config = {}) {
  const topicApplicantId = parseTicketTopic(channel.topic).userId;
  if (topicApplicantId) return topicApplicantId;

  const ticketEntry = Object.entries(config.applications?.tickets || {}).find(
    ([, ticket]) => ticket.channelId === channel.id
  );
  return ticketEntry?.[0] || "";
}

async function fetchStoredChannel(client, config, userId) {
  const stored = storedTicket(config, userId);
  if (!stored?.channelId) return null;

  return client.channels.fetch(stored.channelId).catch(() => null);
}

export async function findOpenApplicationChannel(guild, userId, config = {}, client = null) {
  const storedChannel = client
    ? await fetchStoredChannel(client, config, userId)
    : guild.channels.cache.get(storedTicket(config, userId)?.channelId);

  if (storedChannel?.isTextBased()) return storedChannel;

  return guild.channels.cache.find((channel) => {
    const ticket = parseTicketTopic(channel.topic);
    return (
      [ChannelType.GuildText, ChannelType.PrivateThread, ChannelType.PublicThread].includes(channel.type) &&
      ticket.userId === userId
    );
  });
}

export function findApplicationTicketForUser(client, store, userId) {
  return Promise.all(
    client.guilds.cache.map(async (guild) => {
      const config = store.getGuild(guild.id);
      const channel = await findOpenApplicationChannel(guild, userId, config, client);
      return channel
        ? {
            guild,
            channel,
            ticket: storedTicket(config, userId) || parseTicketTopic(channel.topic)
          }
        : null;
    })
  ).then((matches) => matches.find(Boolean) || null);
}

export async function saveApplicationTicket(store, guildId, userId, ticket) {
  const config = store.getGuild(guildId);
  return store.updateGuild(guildId, {
    applications: {
      ...config.applications,
      tickets: {
        ...(config.applications.tickets || {}),
        [userId]: {
          channelId: ticket.channelId,
          questionIndex: Number(ticket.questionIndex) || 0,
          completed: Boolean(ticket.completed),
          updatedAt: new Date().toISOString()
        }
      }
    }
  });
}

export async function clearApplicationTicket(store, guildId, userId) {
  const config = store.getGuild(guildId);
  const tickets = { ...(config.applications.tickets || {}) };
  delete tickets[userId];

  return store.updateGuild(guildId, {
    applications: {
      ...config.applications,
      tickets
    }
  });
}

export function isApplicationStaff(member, config, commandName, hasCommandRoleOverride) {
  return (
    member?.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
    member?.roles.cache.some((role) => (config.applications?.reviewerRoleIds || []).includes(role.id)) ||
    hasCommandRoleOverride(member, config, commandName)
  );
}

function safeDmContent(text) {
  const cleaned = String(text || "").trim();
  return cleaned ? cleaned.slice(0, 1800) : "(empty answer)";
}

function attachmentLines(message) {
  return message.attachments.size
    ? `\nAttachments:\n${message.attachments.map((attachment) => attachment.url).join("\n")}`
    : "";
}

function applicationEmbed(title, description, guildName = "Chipkittle Applications") {
  return buildPrettyEmbed({
    title,
    description,
    color: 0xf97316,
    footer: guildName
  });
}

export async function handleApplicationDm({ client, store, message }) {
  if (message.guild || message.author.bot) return false;

  const found = await findApplicationTicketForUser(client, store, message.author.id);
  if (!found) return false;

  const config = store.getGuild(found.guild.id);
  const questions = applicationQuestions(config);
  const currentIndex = Math.min(found.ticket.questionIndex, Math.max(questions.length - 1, 0));

  if (!questions.length || found.ticket.completed) {
    await message.reply({
      embeds: [
        applicationEmbed(
          "Application Submitted",
          "Your application has already been submitted. Staff will contact you if they need anything else.",
          found.guild.name
        )
      ]
    }).catch(() => {});
    return true;
  }

  const question = questions[currentIndex];
  await found.channel.send({
    embeds: [
      applicationEmbed(
        `Question ${currentIndex + 1}`,
        `**Question:** ${question}\n**${message.author.tag}:** ${safeDmContent(message.content)}${attachmentLines(message)}`,
        found.guild.name
      )
    ]
  }).catch(() => {});

  const nextIndex = currentIndex + 1;
  const completed = nextIndex >= questions.length;
  await saveApplicationTicket(store, found.guild.id, message.author.id, {
    channelId: found.channel.id,
    questionIndex: nextIndex,
    completed
  });
  if (typeof found.channel.setTopic === "function") {
    found.channel.setTopic(ticketTopic(message.author.id, nextIndex, completed)).catch(() => {});
  }

  if (completed) {
    await message.reply({
      embeds: [
        applicationEmbed(
          "Application Submitted",
          "Your application has been submitted. Staff will review it soon.",
          found.guild.name
        )
      ]
    }).catch(() => {});
    await found.channel.send({
      embeds: [
        applicationEmbed(
          "Application Ready For Review",
          `Application submitted by <@${message.author.id}>. Staff can use \`${config.prefix}reply message\`, \`${config.prefix}approve\`, \`${config.prefix}deny reason\`, or \`${config.prefix}closeapplication\`.`,
          found.guild.name
        )
      ]
    }).catch(() => {});
    return true;
  }

  await message.reply({
    embeds: [
      applicationEmbed(
        `Question ${nextIndex + 1}/${questions.length}`,
        questions[nextIndex],
        found.guild.name
      )
    ]
  }).catch(() => {});
  return true;
}
