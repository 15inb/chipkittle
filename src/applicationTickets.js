import { ChannelType, PermissionsBitField } from "discord.js";
import { buildPrettyEmbed } from "./embedOutput.js";

const TOPIC_PREFIX = "Chipkittle application";
const APPLICATION_THREAD_TYPES = new Set([
  ChannelType.PrivateThread,
  ChannelType.PublicThread,
  ChannelType.AnnouncementThread
]);

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

function isApplicationThread(channel) {
  return Boolean(channel?.isThread?.() || APPLICATION_THREAD_TYPES.has(channel?.type));
}

function isApplicationChannel(channel) {
  return Boolean(
    channel?.isTextBased?.() &&
    (channel.type === ChannelType.GuildText || isApplicationThread(channel))
  );
}

function normalizeTicketRecord(ticket = {}, guildId = "") {
  return {
    channelId: String(ticket.channelId || ""),
    parentChannelId: String(ticket.parentChannelId || ticket.parentId || ""),
    guildId: String(ticket.guildId || guildId || ""),
    questionIndex: Math.max(Number(ticket.questionIndex) || 0, 0),
    completed: Boolean(ticket.completed),
    updatedAt: String(ticket.updatedAt || "")
  };
}

function storedTicket(config, userId) {
  const ticket = normalizeTicketRecord(config.applications?.tickets?.[userId]);
  return ticket.channelId ? ticket : null;
}

function ticketEntries(config = {}) {
  return Object.entries(config.applications?.tickets || {});
}

function fallbackParentChannelIds(config = {}, ticket = null) {
  return [...new Set([
    ticket?.parentChannelId,
    config.applications?.threadChannelId,
    config.applications?.channelId
  ].filter(Boolean))];
}

async function fetchParentChannel(client, guild, parentChannelId) {
  if (!parentChannelId) return null;

  const cached = guild.channels.cache.get(parentChannelId);
  if (cached) return cached;

  return client.channels.fetch(parentChannelId).catch(() => null);
}

async function fetchThreadFromParent(parentChannel, channelId) {
  if (!parentChannel?.threads?.fetchActive || !channelId) return null;

  const active = await parentChannel.threads.fetchActive().catch(() => null);
  const activeThread = active?.threads?.get(channelId);
  if (activeThread) return activeThread;

  const archivedPrivate = await parentChannel.threads
    .fetchArchived({ type: "private", fetchAll: true })
    .catch(() => null);
  const privateThread = archivedPrivate?.threads?.get(channelId);
  if (privateThread) return privateThread;

  const archivedPublic = await parentChannel.threads
    .fetchArchived({ type: "public", limit: 100 })
    .catch(() => null);
  return archivedPublic?.threads?.get(channelId) || null;
}

async function fetchStoredChannel(client, guild, config, userId) {
  const stored = storedTicket(config, userId);
  if (!stored?.channelId) return null;

  const direct = await client.channels.fetch(stored.channelId).catch(() => null);
  if (isApplicationChannel(direct)) return direct;

  const cached = guild.channels.cache.get(stored.channelId);
  if (isApplicationChannel(cached)) return cached;

  const activeThreads = await guild.channels.fetchActiveThreads().catch(() => null);
  const activeThread = activeThreads?.threads?.get(stored.channelId);
  if (isApplicationChannel(activeThread)) return activeThread;

  for (const parentChannelId of fallbackParentChannelIds(config, stored)) {
    const parentChannel = await fetchParentChannel(client, guild, parentChannelId);
    const thread = await fetchThreadFromParent(parentChannel, stored.channelId);
    if (isApplicationChannel(thread)) return thread;
  }

  return null;
}

async function ensureApplicationChannelReady(channel, ticket) {
  if (!isApplicationThread(channel) || ticket?.completed) return channel;

  if (channel.locked) {
    await channel.setLocked(false, "Reopening active application thread").catch(() => {});
  }
  if (channel.archived) {
    await channel.setArchived(false, "Reopening active application thread").catch(() => {});
  }
  if (channel.joinable && !channel.joined) {
    await channel.join().catch(() => {});
  }

  return channel;
}

export function applicantIdFromChannel(channel, config = {}) {
  if (!channel) return "";

  const ticketEntry = ticketEntries(config).find(
    ([, ticket]) => ticket.channelId === channel.id
  );
  if (ticketEntry?.[0]) return ticketEntry[0];

  if (!isApplicationThread(channel)) {
    const topicApplicantId = parseTicketTopic(channel.topic).userId;
    if (topicApplicantId) return topicApplicantId;
  }

  return "";
}

export async function findOpenApplicationChannel(guild, userId, config = {}, client = null) {
  const storedChannel = client
    ? await fetchStoredChannel(client, guild, config, userId)
    : guild.channels.cache.get(storedTicket(config, userId)?.channelId);

  if (isApplicationChannel(storedChannel)) return storedChannel;

  const activeThreads = await guild.channels.fetchActiveThreads().catch(() => null);
  const activeThread = activeThreads?.threads?.find((thread) => applicantIdFromChannel(thread, config) === userId);
  if (isApplicationChannel(activeThread)) return activeThread;

  return guild.channels.cache.find((channel) => {
    if (!isApplicationChannel(channel)) return false;
    return applicantIdFromChannel(channel, config) === userId;
  }) || null;
}

export function findApplicationTicketForUser(client, store, userId) {
  return Promise.all(
    client.guilds.cache.map(async (guild) => {
      const config = store.getGuild(guild.id);
      const channel = await findOpenApplicationChannel(guild, userId, config, client);
      const stored = storedTicket(config, userId);
      return channel
        ? {
            guild,
            channel,
            ticket: stored || parseTicketTopic(channel.topic)
          }
        : null;
    })
  ).then((matches) => matches.find(Boolean) || null);
}

export async function saveApplicationTicket(store, guildId, userId, ticket) {
  const config = store.getGuild(guildId);
  const nextTicket = normalizeTicketRecord(ticket, guildId);
  return store.updateGuild(guildId, {
    applications: {
      ...config.applications,
      tickets: {
        ...(config.applications.tickets || {}),
        [userId]: {
          channelId: nextTicket.channelId,
          parentChannelId: nextTicket.parentChannelId,
          guildId: nextTicket.guildId,
          questionIndex: nextTicket.questionIndex,
          completed: nextTicket.completed,
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
  const channel = await ensureApplicationChannelReady(found.channel, found.ticket);

  if (!questions.length || found.ticket.completed) {
    await channel.send({
      embeds: [
        applicationEmbed(
          "Applicant Follow-Up",
          `**${message.author.tag}:** ${safeDmContent(message.content)}${attachmentLines(message)}`,
          found.guild.name
        )
      ]
    }).catch(() => {});
    await message.reply({
      embeds: [
        applicationEmbed(
          "Follow-Up Sent",
          "Your message was added to your application thread for staff to review.",
          found.guild.name
        )
      ]
    }).catch(() => {});
    return true;
  }

  const question = questions[currentIndex];
  await channel.send({
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
    channelId: channel.id,
    parentChannelId: channel.parentId,
    guildId: found.guild.id,
    questionIndex: nextIndex,
    completed
  });
  if (!isApplicationThread(channel) && typeof channel.setTopic === "function") {
    channel.setTopic(ticketTopic(message.author.id, nextIndex, completed)).catch(() => {});
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
    await channel.send({
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
