import { EmbedBuilder } from "discord.js";
import { NO_MENTIONS } from "./discordSafety.js";

const DEFAULT_COLOR = 0x65d6ad;
const CATEGORY_COLORS = {
  General: 0x65d6ad,
  Info: 0x60a5fa,
  Fun: 0xfacc15,
  Dating: 0xec4899,
  Gambling: 0xf59e0b,
  Utility: 0xa78bfa,
  Games: 0x14b8a6,
  Chipkittle: 0x22c55e,
  Moderation: 0xef4444,
  Trials: 0xf59e0b,
  Config: 0x38bdf8,
  AI: 0x10b981,
  Applications: 0xf97316
};

function clampText(value, maxLength, fallback = "Done.") {
  const text = String(value || "").trim();
  return (text || fallback).slice(0, maxLength);
}

export function buildPrettyEmbed({ title, description, color = DEFAULT_COLOR, footer = "", timestamp = true }) {
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(clampText(title, 256, "Chipkittle"));

  if (description) {
    embed.setDescription(clampText(description, 4096));
  }

  if (footer) {
    embed.setFooter({ text: clampText(footer, 2048) });
  }

  if (timestamp) {
    embed.setTimestamp();
  }

  return embed;
}

export function commandEmbedMeta({ command, config, message }) {
  const prefix = message.commandPrefix || config.prefix;
  return {
    title: `${prefix}${command.name}`,
    color: CATEGORY_COLORS[command.category] || DEFAULT_COLOR,
    footer: `Requested by ${message.author.tag}`
  };
}

function hasRichPayload(options) {
  return Boolean(
    options?.embeds?.length ||
      options?.files?.length ||
      options?.components?.length ||
      options?.stickers?.length ||
      options?.poll
  );
}

function mentionContentFor(payload) {
  const content = String(payload.content || "");
  const users = (payload.allowedMentions?.users || [])
    .map((userId) => `<@${userId}>`)
    .filter((mention) => content.includes(mention));
  const roles = (payload.allowedMentions?.roles || [])
    .map((roleId) => `<@&${roleId}>`)
    .filter((mention) => content.includes(mention));

  return [...users, ...roles].join(" ") || undefined;
}

export function toEmbedPayload(payload, meta) {
  if (typeof payload === "string") {
    return {
      embeds: [
        buildPrettyEmbed({
          ...meta,
          description: payload
        })
      ],
      allowedMentions: NO_MENTIONS
    };
  }

  if (!payload || typeof payload !== "object" || hasRichPayload(payload)) {
    return payload;
  }

  if (typeof payload.content !== "string") {
    return payload;
  }

  const mentionContent = mentionContentFor(payload);

  return {
    ...payload,
    content: mentionContent,
    embeds: [
      buildPrettyEmbed({
        ...meta,
        description: payload.content
      })
    ],
    allowedMentions: payload.allowedMentions || NO_MENTIONS
  };
}

export function sendEmbedPayload(target, payload, meta) {
  return target.send(toEmbedPayload(payload, meta));
}

function bindOrReturn(target, property) {
  const value = target[property];
  return typeof value === "function" ? value.bind(target) : value;
}

function createSendProxy(target, meta) {
  return new Proxy(target, {
    get(sendTarget, property) {
      if (property === "send") {
        return (payload) => sendTarget.send(toEmbedPayload(payload, meta));
      }

      return bindOrReturn(sendTarget, property);
    }
  });
}

export function createEmbedMessageProxy(message, meta) {
  const channelProxy = createSendProxy(message.channel, meta);
  const authorProxy = createSendProxy(message.author, meta);

  return new Proxy(message, {
    get(target, property) {
      if (property === "reply") {
        return (payload) => target.reply(toEmbedPayload(payload, meta));
      }

      if (property === "channel") {
        return channelProxy;
      }

      if (property === "author") {
        return authorProxy;
      }

      return bindOrReturn(target, property);
    }
  });
}
