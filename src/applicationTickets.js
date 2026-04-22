import { ChannelType, PermissionsBitField } from "discord.js";

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
  const userId = topic.match(/application:(\d+)/)?.[1] || "";
  const questionIndex = Number(topic.match(/question:(\d+)/)?.[1] || 0);
  const completed = topic.includes("complete:1");

  return { userId, questionIndex, completed };
}

export function applicantIdFromChannel(channel) {
  return parseTicketTopic(channel.topic).userId;
}

export function findOpenApplicationChannel(guild, userId) {
  return guild.channels.cache.find((channel) => {
    const ticket = parseTicketTopic(channel.topic);
    return channel.type === ChannelType.GuildText && ticket.userId === userId;
  });
}

export function findApplicationTicketForUser(client, userId) {
  for (const guild of client.guilds.cache.values()) {
    const channel = findOpenApplicationChannel(guild, userId);
    if (channel) return { guild, channel, ticket: parseTicketTopic(channel.topic) };
  }

  return null;
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

export async function handleApplicationDm({ client, store, message }) {
  if (message.guild || message.author.bot) return false;

  const found = findApplicationTicketForUser(client, message.author.id);
  if (!found) return false;

  const config = store.getGuild(found.guild.id);
  const questions = applicationQuestions(config);
  const currentIndex = Math.min(found.ticket.questionIndex, Math.max(questions.length - 1, 0));

  if (!questions.length || found.ticket.completed) {
    await message.reply("Your application has already been submitted. Staff will contact you if they need anything else.").catch(() => {});
    return true;
  }

  const question = questions[currentIndex];
  await found.channel.send(
    [
      `**Question ${currentIndex + 1}:** ${question}`,
      `**${message.author.tag}:** ${safeDmContent(message.content)}${attachmentLines(message)}`
    ].join("\n")
  ).catch(() => {});

  const nextIndex = currentIndex + 1;
  const completed = nextIndex >= questions.length;
  await found.channel.setTopic(ticketTopic(message.author.id, nextIndex, completed)).catch(() => {});

  if (completed) {
    await message.reply("Your application has been submitted. Staff will review it soon.").catch(() => {});
    await found.channel.send(`Application submitted by <@${message.author.id}>. Staff can use \`${config.prefix}reply message\`, \`${config.prefix}approve\`, or \`${config.prefix}closeapplication\`.`).catch(() => {});
    return true;
  }

  await message.reply(`Question ${nextIndex + 1}/${questions.length}: ${questions[nextIndex]}`).catch(() => {});
  return true;
}
