import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
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
import { ChannelType } from "discord.js";
import { once } from "node:events";

const TTS_TEXT_CHANNEL_NAME = "ttsbot";
const MAX_TTS_QUEUE = 10;
const TTS_TMP_DIR = path.join(tmpdir(), "chipkittle-tts");

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

async function writeSpeechFile(buffer) {
  await mkdir(TTS_TMP_DIR, { recursive: true });
  const filePath = path.join(TTS_TMP_DIR, `${randomUUID()}.opus`);
  const stream = createWriteStream(filePath);
  stream.end(buffer);
  await once(stream, "finish");
  return filePath;
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
    if (!this.ai.enabled) {
      return "TTS is not configured yet. Add `OPENAI_API_KEY` to `.env`, then restart the bot.";
    }

    const guildMember = member?.voice
      ? member
      : await member?.guild?.members.fetch(member.id).catch(() => null);
    const voiceChannel = guildMember?.voice?.channel;
    if (!voiceChannel) {
      return "Join a voice channel first, then run `/tts join`.";
    }

    const textChannel = findTtsTextChannel(guildMember.guild);
    if (!textChannel) {
      return "Create a text channel named `#ttsbot` first.";
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

    connection.on(VoiceConnectionStatus.Disconnected, () => {
      this.leave(guildMember.guild.id);
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
    const audio = await this.ai.speech({ text: next.text });
    const filePath = await writeSpeechFile(audio);
    const resource = createAudioResource(filePath);
    session.player.play(resource);

    session.player.once(AudioPlayerStatus.Idle, () => {
      rm(filePath, { force: true }).catch(() => {});
    });
  }
}
