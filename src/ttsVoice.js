import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AudioPlayerStatus,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel
} from "@discordjs/voice";
import { ChannelType, PermissionsBitField } from "discord.js";

const TTS_TEXT_CHANNEL_NAME = "ttsbot";
const MAX_TTS_QUEUE = 10;
const TTS_TMP_DIR = path.join(tmpdir(), "chipkittle-tts");
const TTS_PROVIDER = (process.env.TTS_PROVIDER || "piper").toLowerCase();
const PIPER_COMMAND = process.env.TTS_PIPER_COMMAND || "piper";
const PIPER_MODEL = process.env.TTS_PIPER_MODEL || "";
const PIPER_CONFIG = process.env.TTS_PIPER_CONFIG || "";
const PIPER_SPEAKER = process.env.TTS_PIPER_SPEAKER || "";
const PIPER_LENGTH_SCALE = process.env.TTS_PIPER_LENGTH_SCALE || "";
const PIPER_NOISE_SCALE = process.env.TTS_PIPER_NOISE_SCALE || "";
const PIPER_NOISE_WIDTH = process.env.TTS_PIPER_NOISE_WIDTH || "";
const ESPEAK_COMMAND = process.env.TTS_ESPEAK_COMMAND || "espeak-ng";
const ESPEAK_VOICE = process.env.TTS_ESPEAK_VOICE || "en-us";
const ESPEAK_SPEED = process.env.TTS_ESPEAK_SPEED || "175";
const KOKORO_COMMAND = process.env.TTS_KOKORO_COMMAND || "python3";
const KOKORO_SCRIPT = process.env.TTS_KOKORO_SCRIPT || path.join(process.cwd(), "scripts", "kokoro_tts.py");
const KOKORO_MODEL = process.env.TTS_KOKORO_MODEL || "";
const KOKORO_VOICES = process.env.TTS_KOKORO_VOICES || "";
const KOKORO_VOICE = process.env.TTS_KOKORO_VOICE || "af_sarah";
const KOKORO_SPEED = process.env.TTS_KOKORO_SPEED || "1.0";
const KOKORO_LANG = process.env.TTS_KOKORO_LANG || "en-us";

function cleanSpeechText(message) {
  return String(message.cleanContent || message.content || "")
    .replace(/https?:\/\/\S+/gi, "link")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 900);
}

function findTtsTextChannel(guild) {
  return guild.channels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildText &&
      channel.name.toLowerCase() === TTS_TEXT_CHANNEL_NAME
  );
}

async function createLocalSpeechFile(text) {
  if (TTS_PROVIDER === "kokoro") return createKokoroSpeechFile(text);
  if (TTS_PROVIDER === "espeak") return createEspeakSpeechFile(text);
  return createPiperSpeechFile(text);
}

async function createKokoroSpeechFile(text) {
  await mkdir(TTS_TMP_DIR, { recursive: true });
  const filePath = path.join(TTS_TMP_DIR, `${randomUUID()}.wav`);

  await new Promise((resolve, reject) => {
    const child = spawn(KOKORO_COMMAND, [
      KOKORO_SCRIPT,
      "--model",
      KOKORO_MODEL,
      "--voices",
      KOKORO_VOICES,
      "--output",
      filePath,
      "--voice",
      KOKORO_VOICE,
      "--speed",
      KOKORO_SPEED,
      "--lang",
      KOKORO_LANG
    ], {
      windowsHide: true
    });

    let errorOutput = "";
    child.stderr.on("data", (chunk) => {
      errorOutput += chunk.toString();
    });
    child.on("error", (error) => {
      reject(new Error(`Could not start ${KOKORO_COMMAND}: ${error.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${KOKORO_COMMAND} exited with code ${code}: ${errorOutput.trim()}`));
    });
    child.stdin.end(text);
  });

  return filePath;
}

async function createPiperSpeechFile(text) {
  await mkdir(TTS_TMP_DIR, { recursive: true });
  const filePath = path.join(TTS_TMP_DIR, `${randomUUID()}.wav`);

  await new Promise((resolve, reject) => {
    const args = [
      "--model",
      PIPER_MODEL,
      "--output_file",
      filePath
    ];

    if (PIPER_CONFIG) args.push("--config", PIPER_CONFIG);
    if (PIPER_SPEAKER) args.push("--speaker", PIPER_SPEAKER);
    if (PIPER_LENGTH_SCALE) args.push("--length_scale", PIPER_LENGTH_SCALE);
    if (PIPER_NOISE_SCALE) args.push("--noise_scale", PIPER_NOISE_SCALE);
    if (PIPER_NOISE_WIDTH) args.push("--noise_w", PIPER_NOISE_WIDTH);

    const child = spawn(PIPER_COMMAND, args, {
      windowsHide: true
    });

    let errorOutput = "";
    child.stderr.on("data", (chunk) => {
      errorOutput += chunk.toString();
    });
    child.on("error", (error) => {
      reject(new Error(`Could not start ${PIPER_COMMAND}: ${error.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${PIPER_COMMAND} exited with code ${code}: ${errorOutput.trim()}`));
    });
    child.stdin.end(text);
  });

  return filePath;
}

async function createEspeakSpeechFile(text) {
  await mkdir(TTS_TMP_DIR, { recursive: true });
  const filePath = path.join(TTS_TMP_DIR, `${randomUUID()}.wav`);

  return new Promise((resolve, reject) => {
    const child = spawn(ESPEAK_COMMAND, [
      "-v",
      ESPEAK_VOICE,
      "-s",
      ESPEAK_SPEED,
      "-w",
      filePath,
      text
    ], {
      windowsHide: true
    });

    let errorOutput = "";
    child.stderr.on("data", (chunk) => {
      errorOutput += chunk.toString();
    });
    child.on("error", (error) => {
      reject(new Error(`Could not start ${ESPEAK_COMMAND}: ${error.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(filePath);
        return;
      }
      reject(new Error(`${ESPEAK_COMMAND} exited with code ${code}: ${errorOutput.trim()}`));
    });
  });
}

async function commandAvailable(command) {
  return new Promise((resolve) => {
    const child = spawn(command, ["--help"], { windowsHide: true });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function localTtsStatus() {
  if (TTS_PROVIDER === "kokoro") {
    if (!KOKORO_MODEL || !KOKORO_VOICES) {
      return "Kokoro TTS needs model files. Set `TTS_KOKORO_MODEL=/path/to/kokoro-v1.0.onnx` and `TTS_KOKORO_VOICES=/path/to/voices-v1.0.bin` in `.env`, then restart the bot.";
    }

    if (!(await commandAvailable(KOKORO_COMMAND))) {
      return `Kokoro TTS command was not found. Set TTS_KOKORO_COMMAND to your Python executable, usually \`/home/ubuntu/kokoro-tts/venv/bin/python\`.`;
    }

    try {
      await access(KOKORO_SCRIPT);
      await access(KOKORO_MODEL);
      await access(KOKORO_VOICES);
    } catch {
      return "Kokoro TTS files were not found. Check `TTS_KOKORO_SCRIPT`, `TTS_KOKORO_MODEL`, and `TTS_KOKORO_VOICES` in `.env`.";
    }

    return null;
  }

  if (TTS_PROVIDER === "espeak") {
    if (await commandAvailable(ESPEAK_COMMAND)) return null;
    return `Local TTS is not installed. Install eSpeak NG on the VPS with \`sudo apt install -y espeak-ng\`, or set TTS_ESPEAK_COMMAND to the right binary.`;
  }

  if (TTS_PROVIDER !== "piper") {
    return `Unknown TTS_PROVIDER \`${TTS_PROVIDER}\`. Use \`kokoro\`, \`piper\`, or \`espeak\`.`;
  }

  if (!PIPER_MODEL) {
    return "Piper TTS needs a voice model. Set `TTS_PIPER_MODEL=/path/to/voice.onnx` in `.env`, then restart the bot.";
  }

  if (!(await commandAvailable(PIPER_COMMAND))) {
    return `Piper TTS is not installed or not on PATH. Install Piper, or set TTS_PIPER_COMMAND to the piper binary.`;
  }

  try {
    await access(PIPER_MODEL);
  } catch {
    return `Piper voice model was not found at \`${PIPER_MODEL}\`. Check TTS_PIPER_MODEL in \`.env\`.`;
  }

  return null;
}

export class TtsVoiceService {
  constructor({ ai }) {
    this.ai = ai;
    this.sessions = new Map();
  }

  sessionFor(guildId) {
    return this.sessions.get(guildId);
  }

  async join({ member, channel }) {
    const guildMember = member?.voice
      ? member
      : await member?.guild?.members.fetch(member.id).catch(() => null);
    const voiceChannel = guildMember?.voice?.channel;
    if (!voiceChannel) {
      return "Join a voice channel first, then run `/tts join`.";
    }

    const ttsError = await localTtsStatus();
    if (ttsError) return ttsError;

    const botMember = guildMember.guild.members.me;
    const voicePermissions = botMember?.permissionsIn(voiceChannel);
    if (
      !voicePermissions?.has(PermissionsBitField.Flags.Connect) ||
      !voicePermissions?.has(PermissionsBitField.Flags.Speak)
    ) {
      return "I need Connect and Speak permissions in your voice channel.";
    }

    const textChannel = findTtsTextChannel(guildMember.guild);
    if (!textChannel) {
      return "Create a text channel named `#ttsbot` first.";
    }

    const textPermissions = botMember?.permissionsIn(textChannel);
    if (
      !textPermissions?.has(PermissionsBitField.Flags.ViewChannel) ||
      !textPermissions?.has(PermissionsBitField.Flags.SendMessages)
    ) {
      return "I need View Channel and Send Messages permissions in `#ttsbot`.";
    }

    const existing = this.sessionFor(guildMember.guild.id);
    if (existing) {
      existing.connection.destroy();
      this.sessions.delete(guildMember.guild.id);
    }

    const player = createAudioPlayer();
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guildMember.guild.id,
      adapterCreator: guildMember.guild.voiceAdapterCreator,
      selfDeaf: false
    });

    connection.subscribe(player);
    const session = {
      connection,
      player,
      queue: [],
      playing: false,
      textChannelId: textChannel.id,
      voiceChannelId: voiceChannel.id
    };
    this.sessions.set(guildMember.guild.id, session);

    connection.on("error", (error) => {
      console.error("TTS voice connection failed:", error);
      channel.send("TTS voice connection failed. Check my voice channel permissions.").catch(() => {});
      this.leave(guildMember.guild.id);
    });

    connection.on(VoiceConnectionStatus.Disconnected, () => {
      this.leave(guildMember.guild.id);
    });

    player.on("error", (error) => {
      console.error("TTS audio player failed:", error);
      session.playing = false;
      if (error.resource?.metadata?.filePath) {
        rm(error.resource.metadata.filePath, { force: true }).catch(() => {});
      }
      channel.send("TTS audio playback failed.").catch(() => {});
      this.playNext(guildMember.guild.id).catch((nextError) => {
        console.error("TTS playback failed:", nextError);
      });
    });

    player.on(AudioPlayerStatus.Idle, () => {
      session.playing = false;
      this.playNext(guildMember.guild.id).catch((error) => {
        console.error("TTS playback failed:", error);
      });
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    } catch {
      this.leave(guildMember.guild.id);
      return "I could not join that voice channel. Check my Connect and Speak permissions.";
    }

    await channel.send(`TTS joined **${voiceChannel.name}**. Messages in ${textChannel} will be read aloud.`);
    return null;
  }

  leave(guildId) {
    const session = this.sessionFor(guildId);
    if (!session) return false;

    this.sessions.delete(guildId);
    session.queue.length = 0;
    session.player.stop(true);
    session.connection.destroy();
    return true;
  }

  async handleMessage(message) {
    const session = this.sessionFor(message.guild?.id);
    if (!session || message.channel.id !== session.textChannelId) return false;

    const text = cleanSpeechText(message);
    if (!text) return false;

    if (session.queue.length >= MAX_TTS_QUEUE) {
      await message.reply("TTS queue is full. Try again in a moment.").catch(() => {});
      return true;
    }

    session.queue.push({
      text,
      userId: message.author.id
    });
    await this.playNext(message.guild.id).catch((error) => {
      console.error("TTS generation failed:", error);
      message.reply("TTS could not read that message.").catch(() => {});
    });
    return true;
  }

  async playNext(guildId) {
    const session = this.sessionFor(guildId);
    if (!session || session.playing || !session.queue.length) return;

    const next = session.queue.shift();
    session.playing = true;
    const filePath = await createLocalSpeechFile(next.text);
    const resource = createAudioResource(filePath, {
      metadata: { filePath }
    });
    session.player.play(resource);

    session.player.once(AudioPlayerStatus.Idle, () => {
      rm(filePath, { force: true }).catch(() => {});
    });
  }
}
