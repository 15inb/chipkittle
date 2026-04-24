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
  commandRoles: {
    overrides: {}
  },
  economy: {
    balances: {},
    dailyClaims: {}
  },
  cooldowns: {},
  publicSite: {
    members: [
      {
        name: "Chipkittle",
        role: "Artifact Keeper",
        bio: "Guardian of the suit, the glow, and the strange little rituals."
      },
      {
        name: "#CK Members",
        role: "Round Table",
        bio: "The people who keep the Discord moving and the bread economy unstable."
      }
    ],
    games: {
      blockedLeaderboardWords: [],
      maxLeaderboardEntriesPerGame: 10,
      maxLeaderboardScore: 100000,
      maxLeaderboardBread: 100000,
      maxClaimBreadPerRun: 100000,
      recordAlertChannelId: ""
    }
  },
  ai: {
    enabled: false,
    channelIds: [],
    blacklistedChannelIds: [],
    mode: "normal",
    model: "",
    apiCooldownSeconds: 30,
    imageCooldownSeconds: 120,
    replyToMentions: true,
    personality: "You are the Chipkittle family archivist: strange, ceremonial, funny, loyal to the artifact, and always dressed in the same white furry horned Chipkittle suit. Keep replies playful and PG-13. Do not use slurs, sexual violence, or hateful language from old records."
  },
  applications: {
    enabled: false,
    channelId: "",
    threadChannelId: "",
    categoryId: "",
    reviewerRoleIds: [],
    approvedRoleId: "",
    blockedRoleIds: [],
    cooldownMinutes: 60,
    cooldowns: {},
    tickets: {},
    questions: [
      "What name would we know you as?",
      "What is the most important ancient Chipkittle artifact?",
      "Why should you be allowed membership?",
      "What #CK members do you know?",
      "Are you willing to adopt the #CK Discord tag and put \"Chipkittle\", \"#CK\", or \"ck.\" in your TS name?"
    ]
  },
  community: {
    profiles: {},
    artifacts: [],
    auditLog: [],
    analytics: {
      commands: {},
      totals: {}
    },
    rituals: {
      currentEvent: "The artifact is humming softly and judging the bread economy.",
      seasonalMessage: "Current season: ceremonial optimism.",
      nextTrial: ""
    },
    staffNotes: {}
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
    commandRoles: {
      ...clone(DEFAULT_CONFIG.commandRoles),
      ...(config.commandRoles || {})
    },
    economy: {
      ...clone(DEFAULT_CONFIG.economy),
      ...(config.economy || {})
    },
    cooldowns: {
      ...clone(DEFAULT_CONFIG.cooldowns),
      ...(config.cooldowns || {})
    },
    publicSite: {
      ...clone(DEFAULT_CONFIG.publicSite),
      ...(config.publicSite || {})
    },
    ai: {
      ...clone(DEFAULT_CONFIG.ai),
      ...(config.ai || {})
    },
    applications: {
      ...clone(DEFAULT_CONFIG.applications),
      ...(config.applications || {})
    },
    community: {
      ...clone(DEFAULT_CONFIG.community),
      ...(config.community || {}),
      analytics: {
        ...clone(DEFAULT_CONFIG.community.analytics),
        ...(config.community?.analytics || {}),
        totals: {
          ...clone(DEFAULT_CONFIG.community.analytics.totals),
          ...(config.community?.analytics?.totals || {})
        }
      },
      rituals: {
        ...clone(DEFAULT_CONFIG.community.rituals),
        ...(config.community?.rituals || {})
      }
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
      commandRoles: {
        ...this.getGuild(guildId).commandRoles,
        ...(partialConfig.commandRoles || {})
      },
      economy: {
        ...this.getGuild(guildId).economy,
        ...(partialConfig.economy || {})
      },
      publicSite: {
        ...this.getGuild(guildId).publicSite,
        ...(partialConfig.publicSite || {})
      },
      ai: {
        ...this.getGuild(guildId).ai,
        ...(partialConfig.ai || {})
      },
      applications: {
        ...this.getGuild(guildId).applications,
        ...(partialConfig.applications || {})
      },
      community: {
        ...this.getGuild(guildId).community,
        ...(partialConfig.community || {}),
        analytics: {
          ...this.getGuild(guildId).community.analytics,
          ...(partialConfig.community?.analytics || {}),
          totals: {
            ...this.getGuild(guildId).community.analytics.totals,
            ...(partialConfig.community?.analytics?.totals || {})
          }
        },
        rituals: {
          ...this.getGuild(guildId).community.rituals,
          ...(partialConfig.community?.rituals || {})
        }
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
