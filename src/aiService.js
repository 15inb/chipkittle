import OpenAI, { toFile } from "openai";
import { chipkittlePrompt } from "./chipkittleLore.js";
import { neutralizeMentions } from "./discordSafety.js";

const MAX_CONTEXT_MESSAGES = 8;
const CHIPIFY_PROMPT = [
  "Edit the provided image into a Chipkittle costume version of the subject.",
  "Preserve the subject's real face, facial expression, skin tone, age, identity, body shape, body size, pose, camera angle, and composition as closely as possible.",
  "Do not make the subject heavier, wider, rounder, older, younger, or more muscular. Do not replace, reshape, or stylize the face beyond fitting it inside the costume hood.",
  "Only change the outfit/body covering: dress the subject in a white shaggy furry full-body Chipkittle suit that follows their original proportions.",
  "Add a white furry beast hood around the existing face, two large dark curved ram-like horns, small glowing pale eye spots above the face opening, grey clawed hands/feet, and a soft white fur texture.",
  "The result should look like the same person wearing a funny ceremonial horned Chipkittle suit, not a different creature or different person. Keep it non-graphic and safe."
].join(" ");

function trimDiscordMessage(text, maxLength = 1800) {
  if (!text) return "The artifact is quiet right now.";
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function aiMaxTokens(config = {}) {
  const length = String(config.ai?.responseLength || "normal").toLowerCase();
  if (length === "short") return 180;
  if (length === "long") return 750;
  return 450;
}

function channelPersonality(config = {}, channelId = "") {
  return String(config.ai?.channelPersonalities?.[channelId] || "").trim();
}

function aiPromptOptions(config = {}, channelId = "") {
  const extra = [
    config.ai?.personality,
    channelPersonality(config, channelId) ? `Channel-specific behavior: ${channelPersonality(config, channelId)}` : ""
  ].filter(Boolean).join("\n");
  return {
    personality: extra,
    mode: config.ai?.mode,
    chaosLevel: config.ai?.chaosLevel,
    loreStrictness: config.ai?.loreStrictness,
    responseLength: config.ai?.responseLength
  };
}

function estimateUsage(response, text = "") {
  const usage = response?.usage || {};
  const inputTokens = Math.max(Math.floor(Number(usage.input_tokens || usage.inputTokens) || 0), 0);
  const outputTokens = Math.max(Math.floor(Number(usage.output_tokens || usage.outputTokens) || 0), 0);
  const totalTokens = Math.max(Math.floor(Number(usage.total_tokens || usage.totalTokens) || 0), 0);
  const fallback = Math.max(Math.ceil(String(text || "").length / 4), 1);
  return {
    inputTokens,
    outputTokens,
    totalTokens: totalTokens || inputTokens + outputTokens || fallback
  };
}

export class AiService {
  constructor({ apiKey, defaultModel }) {
    this.defaultModel = defaultModel || "gpt-5.2";
    this.client = apiKey ? new OpenAI({ apiKey }) : null;
    this.history = new Map();
  }

  get enabled() {
    return Boolean(this.client);
  }

  keyFor(message) {
    return `${message.guild.id}:${message.channel.id}`;
  }

  remember(message, role, content) {
    const key = this.keyFor(message);
    const existing = this.history.get(key) || [];
    existing.push({
      role,
      content: trimDiscordMessage(content, 700)
    });
    this.history.set(key, existing.slice(-MAX_CONTEXT_MESSAGES));
  }

  clearHistory(message) {
    this.history.delete(this.keyFor(message));
  }

  async reply(message, config, promptText) {
    if (!this.client) {
      return "AI is not configured yet. Add `OPENAI_API_KEY` to `.env`, then restart the bot.";
    }

    const model = config.ai.model || this.defaultModel;
    const promptOptions = aiPromptOptions(config, message.channel.id);
    const input = [
      ...(this.history.get(this.keyFor(message)) || []).map((item) => ({
        role: item.role,
        content: item.content
      })),
      {
        role: "user",
        content: `${message.member?.displayName || message.author.username}: ${promptText}`
      }
    ];

    const response = await this.client.responses.create({
      model,
      instructions: chipkittlePrompt(promptOptions.personality, promptOptions.mode, promptOptions),
      input,
      max_output_tokens: aiMaxTokens(config)
    });

    const output = neutralizeMentions(trimDiscordMessage(response.output_text));
    this.remember(message, "user", promptText);
    this.remember(message, "assistant", output);
    return { text: output, usage: estimateUsage(response, output) };
  }

  async chipkittleName(message, config, inspiration = "") {
    if (!this.client) {
      return "AI is not configured yet. Add `OPENAI_API_KEY` to `.env`, then restart the bot.";
    }

    const model = config.ai.model || this.defaultModel;
    const promptOptions = aiPromptOptions(config, message.channel.id);
    const seed = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const prompt = [
      "Generate one brand-new ceremonial Chipkittle name.",
      "The name should feel strange, funny, ancient, and family-lore flavored.",
      "Return only the name, no explanation, no quotes, no markdown.",
      "Keep it safe for Discord and under 60 characters.",
      inspiration ? `Optional inspiration: ${inspiration}` : "",
      `Random seed: ${seed}`
    ].filter(Boolean).join("\n");

    const response = await this.client.responses.create({
      model,
      instructions: chipkittlePrompt(promptOptions.personality, promptOptions.mode, promptOptions),
      input: [{ role: "user", content: prompt }],
      max_output_tokens: 80
    });

    const name = neutralizeMentions(trimDiscordMessage(response.output_text, 120))
      .split("\n")[0]
      .replace(/^[\s"'`]+|[\s"'`]+$/g, "");
    return name || "Mucklehorn Crumbwrit";
  }

  async loreAnswer(message, config, question = "") {
    if (!this.client) {
      return { text: "AI is not configured yet. Add `OPENAI_API_KEY` to `.env`, then restart the bot.", usage: { totalTokens: 0 } };
    }
    const model = config.ai.model || this.defaultModel;
    const promptOptions = {
      ...aiPromptOptions(config, message.channel.id),
      loreStrictness: "strict",
      responseLength: config.ai.responseLength || "normal"
    };
    const response = await this.client.responses.create({
      model,
      instructions: chipkittlePrompt(promptOptions.personality, promptOptions.mode, promptOptions),
      input: [{
        role: "user",
        content: [
          "Answer this as a strict Chipkittle lore archivist.",
          "Use only provided canon. If canon does not answer, say the artifact record is unclear.",
          `Question: ${question}`
        ].join("\n")
      }],
      max_output_tokens: aiMaxTokens(config)
    });
    const output = neutralizeMentions(trimDiscordMessage(response.output_text));
    return { text: output, usage: estimateUsage(response, output) };
  }

  async chipifyImage({ imageBuffer, mimeType, filename, userId }) {
    if (!this.client) {
      throw new Error("AI is not configured yet. Add `OPENAI_API_KEY` to `.env`, then restart the bot.");
    }

    const image = await toFile(imageBuffer, filename || "chipify.png", {
      type: mimeType || "image/png"
    });

    const response = await this.client.images.edit({
      model: "gpt-image-1",
      image,
      prompt: CHIPIFY_PROMPT,
      n: 1,
      size: "1024x1024",
      quality: "medium",
      output_format: "png",
      user: userId
    });

    const b64 = response.data?.[0]?.b64_json;
    if (!b64) {
      throw new Error("The image model did not return an image.");
    }

    return Buffer.from(b64, "base64");
  }

  async speech({ text, voice = "coral" }) {
    if (!this.client) {
      throw new Error("AI is not configured yet. Add `OPENAI_API_KEY` to `.env`, then restart the bot.");
    }

    const response = await this.client.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice,
      input: trimDiscordMessage(text, 900),
      response_format: "opus",
      instructions: "Speak clearly and naturally for a Discord voice channel."
    });

    return Buffer.from(await response.arrayBuffer());
  }
}
