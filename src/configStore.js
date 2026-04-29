import fs from "node:fs/promises";
import path from "node:path";

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

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
    overrides: {},
    disabled: {},
    channelAllowlist: {},
    disabledCategories: {},
    channelCommandAllowlist: {},
    channelCategoryAllowlist: {}
  },
  panelAccess: {
    users: {},
    grantAccessLevels: ["root"],
    emergencyLockout: false,
    roleTemplates: {},
    recoveryCodes: [],
    sessionsRevokedBefore: ""
  },
  economy: {
    balances: {},
    bankBalances: {},
    upgrades: {},
    loans: {},
    dailyClaims: {},
    settings: {
      dailyBread: 300,
      maxBreadBet: 10000,
      gamblingCooldownSeconds: 5,
      robCooldownMinutes: 180,
      casinoRobberyCooldownMinutes: 480,
      bankInterestCooldownHours: 20,
      bankInterestRatePercent: 1.5,
      maxBankInterest: 1000,
      upgradeCosts: {}
    }
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
    },
    suggestions: {
      channelId: "",
      staffUserId: "203025242753335296"
    },
    profileEditor: {
      enabled: true,
      allowedRoleIds: []
    }
  },
  ai: {
    enabled: false,
    channelIds: [],
    blacklistedChannelIds: [],
    allowedRoleIds: [],
    channelPersonalities: {},
    mode: "normal",
    chaosLevel: 3,
    loreStrictness: "balanced",
    responseLength: "normal",
    model: "",
    apiCooldownSeconds: 30,
    imageCooldownSeconds: 120,
    replyToMentions: true,
    monthlyBudget: 0,
    usage: {
      month: "",
      requests: 0,
      estimatedTokens: 0
    },
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
    profileEdits: {},
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
    suggestions: [],
    questClaims: {},
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
      ...(config.commandRoles || {}),
      overrides: {
        ...clone(DEFAULT_CONFIG.commandRoles.overrides),
        ...(config.commandRoles?.overrides || {})
      },
      disabled: {
        ...clone(DEFAULT_CONFIG.commandRoles.disabled),
        ...(config.commandRoles?.disabled || {})
      },
      channelAllowlist: {
        ...clone(DEFAULT_CONFIG.commandRoles.channelAllowlist),
        ...(config.commandRoles?.channelAllowlist || {})
      },
      disabledCategories: {
        ...clone(DEFAULT_CONFIG.commandRoles.disabledCategories),
        ...(config.commandRoles?.disabledCategories || {})
      },
      channelCommandAllowlist: {
        ...clone(DEFAULT_CONFIG.commandRoles.channelCommandAllowlist),
        ...(config.commandRoles?.channelCommandAllowlist || {})
      },
      channelCategoryAllowlist: {
        ...clone(DEFAULT_CONFIG.commandRoles.channelCategoryAllowlist),
        ...(config.commandRoles?.channelCategoryAllowlist || {})
      }
    },
    panelAccess: {
      ...clone(DEFAULT_CONFIG.panelAccess),
      ...(config.panelAccess || {}),
      users: {
        ...(config.panelAccess?.users || {})
      },
      grantAccessLevels: Array.isArray(config.panelAccess?.grantAccessLevels)
        ? config.panelAccess.grantAccessLevels
        : clone(DEFAULT_CONFIG.panelAccess.grantAccessLevels),
      roleTemplates: {
        ...(config.panelAccess?.roleTemplates || {})
      },
      recoveryCodes: Array.isArray(config.panelAccess?.recoveryCodes)
        ? config.panelAccess.recoveryCodes
        : [],
      emergencyLockout: Boolean(config.panelAccess?.emergencyLockout),
      sessionsRevokedBefore: String(config.panelAccess?.sessionsRevokedBefore || "")
    },
    economy: {
      ...clone(DEFAULT_CONFIG.economy),
      ...(config.economy || {}),
      settings: {
        ...clone(DEFAULT_CONFIG.economy.settings),
        ...(config.economy?.settings || {}),
        upgradeCosts: {
          ...(config.economy?.settings?.upgradeCosts || {}),
          ...(config.economy?.upgradeCosts || {})
        }
      }
    },
    cooldowns: {
      ...clone(DEFAULT_CONFIG.cooldowns),
      ...(config.cooldowns || {})
    },
    publicSite: {
      ...clone(DEFAULT_CONFIG.publicSite),
      ...(config.publicSite || {}),
      games: {
        ...clone(DEFAULT_CONFIG.publicSite.games),
        ...(config.publicSite?.games || {})
      },
      suggestions: {
        ...clone(DEFAULT_CONFIG.publicSite.suggestions),
        ...(config.publicSite?.suggestions || {})
      },
      profileEditor: {
        ...clone(DEFAULT_CONFIG.publicSite.profileEditor),
        ...(config.publicSite?.profileEditor || {}),
        allowedRoleIds: Array.isArray(config.publicSite?.profileEditor?.allowedRoleIds)
          ? config.publicSite.profileEditor.allowedRoleIds
          : []
      }
    },
    ai: {
      ...clone(DEFAULT_CONFIG.ai),
      ...(config.ai || {}),
      channelIds: Array.isArray(config.ai?.channelIds) ? config.ai.channelIds : [],
      blacklistedChannelIds: Array.isArray(config.ai?.blacklistedChannelIds) ? config.ai.blacklistedChannelIds : [],
      allowedRoleIds: Array.isArray(config.ai?.allowedRoleIds) ? config.ai.allowedRoleIds : [],
      channelPersonalities: {
        ...(config.ai?.channelPersonalities || {})
      },
      usage: {
        ...clone(DEFAULT_CONFIG.ai.usage),
        ...(config.ai?.usage || {})
      }
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
        ...(partialConfig.commandRoles || {}),
        overrides: hasOwn(partialConfig.commandRoles || {}, "overrides")
          ? { ...(partialConfig.commandRoles?.overrides || {}) }
          : { ...(this.getGuild(guildId).commandRoles.overrides || {}) },
        disabled: hasOwn(partialConfig.commandRoles || {}, "disabled")
          ? { ...(partialConfig.commandRoles?.disabled || {}) }
          : { ...(this.getGuild(guildId).commandRoles.disabled || {}) },
        channelAllowlist: hasOwn(partialConfig.commandRoles || {}, "channelAllowlist")
          ? { ...(partialConfig.commandRoles?.channelAllowlist || {}) }
          : { ...(this.getGuild(guildId).commandRoles.channelAllowlist || {}) },
        disabledCategories: hasOwn(partialConfig.commandRoles || {}, "disabledCategories")
          ? { ...(partialConfig.commandRoles?.disabledCategories || {}) }
          : { ...(this.getGuild(guildId).commandRoles.disabledCategories || {}) },
        channelCommandAllowlist: hasOwn(partialConfig.commandRoles || {}, "channelCommandAllowlist")
          ? { ...(partialConfig.commandRoles?.channelCommandAllowlist || {}) }
          : { ...(this.getGuild(guildId).commandRoles.channelCommandAllowlist || {}) },
        channelCategoryAllowlist: hasOwn(partialConfig.commandRoles || {}, "channelCategoryAllowlist")
          ? { ...(partialConfig.commandRoles?.channelCategoryAllowlist || {}) }
          : { ...(this.getGuild(guildId).commandRoles.channelCategoryAllowlist || {}) }
      },
      panelAccess: {
        ...this.getGuild(guildId).panelAccess,
        ...(partialConfig.panelAccess || {}),
        users: {
          ...this.getGuild(guildId).panelAccess.users,
          ...(partialConfig.panelAccess?.users || {})
        },
        grantAccessLevels: Array.isArray(partialConfig.panelAccess?.grantAccessLevels)
          ? partialConfig.panelAccess.grantAccessLevels
          : this.getGuild(guildId).panelAccess.grantAccessLevels,
        roleTemplates: {
          ...this.getGuild(guildId).panelAccess.roleTemplates,
          ...(partialConfig.panelAccess?.roleTemplates || {})
        },
        recoveryCodes: Array.isArray(partialConfig.panelAccess?.recoveryCodes)
          ? partialConfig.panelAccess.recoveryCodes
          : this.getGuild(guildId).panelAccess.recoveryCodes,
        emergencyLockout: hasOwn(partialConfig.panelAccess || {}, "emergencyLockout")
          ? Boolean(partialConfig.panelAccess?.emergencyLockout)
          : Boolean(this.getGuild(guildId).panelAccess.emergencyLockout),
        sessionsRevokedBefore: hasOwn(partialConfig.panelAccess || {}, "sessionsRevokedBefore")
          ? String(partialConfig.panelAccess?.sessionsRevokedBefore || "")
          : String(this.getGuild(guildId).panelAccess.sessionsRevokedBefore || "")
      },
      economy: {
        ...this.getGuild(guildId).economy,
        ...(partialConfig.economy || {}),
        settings: {
          ...this.getGuild(guildId).economy.settings,
          ...(partialConfig.economy?.settings || {}),
          upgradeCosts: {
            ...(this.getGuild(guildId).economy.settings?.upgradeCosts || {}),
            ...(partialConfig.economy?.settings?.upgradeCosts || {})
          }
        }
      },
      publicSite: {
        ...this.getGuild(guildId).publicSite,
        ...(partialConfig.publicSite || {}),
        games: {
          ...this.getGuild(guildId).publicSite.games,
          ...(partialConfig.publicSite?.games || {})
        },
        suggestions: {
          ...this.getGuild(guildId).publicSite.suggestions,
          ...(partialConfig.publicSite?.suggestions || {})
        },
        profileEditor: {
          ...this.getGuild(guildId).publicSite.profileEditor,
          ...(partialConfig.publicSite?.profileEditor || {}),
          allowedRoleIds: Array.isArray(partialConfig.publicSite?.profileEditor?.allowedRoleIds)
            ? partialConfig.publicSite.profileEditor.allowedRoleIds
            : this.getGuild(guildId).publicSite.profileEditor.allowedRoleIds
        }
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
