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

  async reply(message, config, promptText) {
    if (!this.client) {
      return "AI is not configured yet. Add `OPENAI_API_KEY` to `.env`, then restart the bot.";
    }

    const model = config.ai.model || this.defaultModel;
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
      instructions: chipkittlePrompt(config.ai.personality),
      input,
      max_output_tokens: 450
    });

    const output = neutralizeMentions(trimDiscordMessage(response.output_text));
    this.remember(message, "user", promptText);
    this.remember(message, "assistant", output);
    return output;
  }

  async chipkittleName(message, config, inspiration = "") {
    if (!this.client) {
      return "AI is not configured yet. Add `OPENAI_API_KEY` to `.env`, then restart the bot.";
    }

    const model = config.ai.model || this.defaultModel;
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
      instructions: chipkittlePrompt(config.ai.personality),
      input: [{ role: "user", content: prompt }],
      max_output_tokens: 80
    });

    const name = neutralizeMentions(trimDiscordMessage(response.output_text, 120))
      .split("\n")[0]
      .replace(/^[\s"'`]+|[\s"'`]+$/g, "");
    return name || "Mucklehorn Crumbwrit";
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
}
