import OpenAI from "openai";
import { chipkittlePrompt } from "./chipkittleLore.js";
import { neutralizeMentions } from "./discordSafety.js";

const MAX_CONTEXT_MESSAGES = 8;

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
}
