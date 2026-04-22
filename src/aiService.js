import OpenAI, { toFile } from "openai";
import { chipkittlePrompt } from "./chipkittleLore.js";
import { neutralizeMentions } from "./discordSafety.js";

const MAX_CONTEXT_MESSAGES = 8;
const CHIPIFY_PROMPT = [
  "Edit the provided image into a Chipkittle version of the subject.",
  "A Chipkittle wears a full-body white furry creature suit with a bulky rounded torso, shaggy white fur, grey clawed feet and hands, and a hood shaped like a horned beast head.",
  "The hood has two large dark curved ram-like horns, small glowing pale eye spots above the face opening, and a furry mane framing the face.",
  "Preserve the main subject's pose, identity, face placement, and general composition, but transform clothing/body styling into the same white furry horned Chipkittle suit.",
  "Make it funny, ceremonial, and slightly uncanny, like a game screenshot creature costume. Keep it non-graphic and safe."
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
