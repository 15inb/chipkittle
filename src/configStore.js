import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_CONFIG = {
  prefix: "!",
  welcome: {
    enabled: false,
    channelId: "",
    message: "Welcome {user} to {server}!"
  },
  autoRoleId: "",
  automod: {
    enabled: false,
    blockedWords: [],
    deleteInvites: true,
    deleteLinks: false
  },
  moderation: {
    logChannelId: "",
    warnings: {}
  },
  ai: {
    enabled: false,
    channelIds: [],
    model: "",
    apiCooldownSeconds: 30,
    replyToMentions: true,
    personality: "You are the Chipkittle family archivist: strange, ceremonial, funny, loyal to the artifact, and always dressed in the same white furry horned Chipkittle suit. Keep replies playful and PG-13. Do not use slurs, sexual violence, or hateful language from old records."
  }
};

function clone(value) {
  return structuredClone(value);
}

function mergeConfig(config = {}) {
  return {
    ...clone(DEFAULT_CONFIG),
    ...config,
    welcome: {
      ...clone(DEFAULT_CONFIG.welcome),
      ...(config.welcome || {})
    },
    automod: {
      ...clone(DEFAULT_CONFIG.automod),
      ...(config.automod || {})
    },
    moderation: {
      ...clone(DEFAULT_CONFIG.moderation),
      ...(config.moderation || {})
    },
    ai: {
      ...clone(DEFAULT_CONFIG.ai),
      ...(config.ai || {})
    }
  };
}

export class ConfigStore {
  constructor(filePath = path.join(process.cwd(), "data", "config.json")) {
    this.filePath = filePath;
    this.data = { guilds: {} };
    this.ready = this.load();
  }

  async load() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.data = {
        guilds: Object.fromEntries(
          Object.entries(parsed.guilds || {}).map(([guildId, config]) => [
            guildId,
            mergeConfig(config)
          ])
        )
      };
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn(`Could not read config file, starting fresh: ${error.message}`);
      }

      await this.save();
    }
  }

  async save() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const payload = `${JSON.stringify(this.data, null, 2)}\n`;
    await fs.writeFile(this.filePath, payload, "utf8");
  }

  getGuild(guildId) {
    if (!this.data.guilds[guildId]) {
      this.data.guilds[guildId] = clone(DEFAULT_CONFIG);
    }

    return mergeConfig(this.data.guilds[guildId]);
  }

  async updateGuild(guildId, partialConfig) {
    const nextConfig = mergeConfig({
      ...this.getGuild(guildId),
      ...partialConfig,
      welcome: {
        ...this.getGuild(guildId).welcome,
        ...(partialConfig.welcome || {})
      },
      automod: {
        ...this.getGuild(guildId).automod,
        ...(partialConfig.automod || {})
      },
      moderation: {
        ...this.getGuild(guildId).moderation,
        ...(partialConfig.moderation || {})
      },
      ai: {
        ...this.getGuild(guildId).ai,
        ...(partialConfig.ai || {})
      }
    });

    this.data.guilds[guildId] = nextConfig;
    await this.save();
    return nextConfig;
  }

  async addWarning(guildId, userId, warning) {
    const config = this.getGuild(guildId);
    const warnings = {
      ...(config.moderation.warnings || {}),
      [userId]: [...(config.moderation.warnings?.[userId] || []), warning]
    };

    return this.updateGuild(guildId, {
      moderation: {
        ...config.moderation,
        warnings
      }
    });
  }

  async clearWarnings(guildId, userId) {
    const config = this.getGuild(guildId);
    const warnings = { ...(config.moderation.warnings || {}) };
    delete warnings[userId];

    return this.updateGuild(guildId, {
      moderation: {
        ...config.moderation,
        warnings
      }
    });
  }

  async ensureGuild(guildId) {
    if (!this.data.guilds[guildId]) {
      this.data.guilds[guildId] = clone(DEFAULT_CONFIG);
      await this.save();
    }

    return this.getGuild(guildId);
  }
}
