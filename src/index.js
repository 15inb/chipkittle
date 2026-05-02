import "dotenv/config";
import crypto from "node:crypto";
import { createServer } from "node:http";
import { commandList, createBot } from "./bot.js";
import { AiService } from "./aiService.js";
import { ConfigStore } from "./configStore.js";
import { createPanel } from "./panel.js";

const port = Number(process.env.PORT || 3000);
const publicUrl = process.env.PUBLIC_URL || `http://localhost:${port}`;
const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const discordClientSecret = process.env.DISCORD_CLIENT_SECRET || "";
const guildId = process.env.GUILD_ID;
const slashCommandScope = String(process.env.SLASH_COMMAND_SCOPE || "global").toLowerCase();
const defaultAiModel = process.env.OPENAI_MODEL || "gpt-5.2";
const panelPassword = process.env.PANEL_PASSWORD || "";
const allowLegacyPanelPasswordLogin = String(process.env.ALLOW_LEGACY_PANEL_PASSWORD_LOGIN || "").toLowerCase() === "true";
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

if (allowLegacyPanelPasswordLogin && !panelPassword) {
  console.warn("Legacy panel password login is enabled, but PANEL_PASSWORD is not set.");
}

if (allowLegacyPanelPasswordLogin && panelPassword === "changeme") {
  console.warn("PANEL_PASSWORD is using the default value. Change it before exposing this panel.");
}

if (!process.env.SESSION_SECRET) {
  console.warn("SESSION_SECRET is not set. Sessions will reset whenever the app restarts.");
}

const store = new ConfigStore();
await store.ready;

const ai = new AiService({
  apiKey: process.env.OPENAI_API_KEY,
  defaultModel: defaultAiModel
});
const client = createBot({ store, publicUrl, clientId, guildId, token, ai, defaultAiModel, slashCommandScope });
const app = createPanel({
  client,
  store,
  panelPassword,
  allowLegacyPanelPasswordLogin,
  sessionSecret,
  clientId,
  discordClientSecret,
  guildId,
  ai,
  publicUrl,
  defaultAiModel,
  commandList
});

const server = createServer(app);

server.listen(port, () => {
  console.log(`Config panel listening at ${publicUrl}`);
});

if (token) {
  await client.login(token).catch((error) => {
    console.error(`Discord login failed: ${error.message}`);
    console.error("The web panel is still running, but the bot is offline.");
  });
} else {
  console.warn("DISCORD_TOKEN is not set. The web panel is running, but the bot is offline.");
}
