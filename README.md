# Chipkittle Bot

This project runs a Discord bot and a password-protected web panel in one Node.js process. The panel lets you configure each server the bot is in without editing code.

## Features

- Web panel login with `PANEL_PASSWORD`
- Per-server config stored in `data/config.json`
- Slash commands: `/help`, `/ping`, `/config`
- Legacy prefix commands: `help`, `ping`, `config`
- Expanded command catalog for info, fun, moderation, configuration, and Chipkittle lore
- Chipkittle AI chat mode powered by OpenAI once you add an API key
- Welcome messages with placeholders
- Optional auto role on member join
- Basic automod for blocked words, invite links, and web links
- Optional moderation log channel
- Guild selector and live bot status in the panel

## Setup

1. Install dependencies:

   ```powershell
   npm.cmd install
   ```

2. Copy `.env.example` to `.env` and fill in your values:

   ```powershell
   Copy-Item .env.example .env
   ```

   To enable AI replies, set:

   ```env
   OPENAI_API_KEY=your_openai_api_key
   OPENAI_MODEL=gpt-5.2
   ```

3. In the Discord Developer Portal, enable these bot intents:

   - Server Members Intent
   - Message Content Intent

4. Invite the bot with permissions it needs for your features:

   - Send Messages
   - Manage Messages, for automod deletes
   - Manage Roles, for auto role
   - View Channels
   - Connect and Speak, for voice-channel TTS

5. Start the bot and panel:

   ```powershell
   npm.cmd start
   ```

6. Open `http://localhost:3000` and log in with `PANEL_PASSWORD`.

## Commands

Use `/help` in Discord to see the full command catalog. The bot still accepts the configured legacy text prefix, but slash commands are the recommended way to use it because Discord shows command suggestions and input prompts.

Slash commands are registered automatically when the bot starts. If `GUILD_ID` is set, commands are registered only for that server. If `GUILD_ID` is empty, the bot registers commands directly in every server it has joined so updates appear quickly after restart.

Highlights:

- General: `help`, `ping`, `config`, `invite`, `uptime`, `botinfo`
- Info: `server`, `user`, `avatar`, `roles`, `channels`
- Fun: `coinflip`, `roll`, `choose`, `8ball`, `rate`, `ship`, `poll`, `remind`, `timestamp`, `echo`, `embed`
- Chipkittle: `chipkittle`, `artifact`, `oath`, `chipname`, `rank`, `suit`, `donation`, `lore`
- Moderation: `purge`, `warn`, `warnings`, `clearwarnings`, `timeout`, `untimeout`, `kick`, `ban`, `slowmode`, `lock`, `unlock`
- Config: `setprefix`, `setwelcome`, `testwelcome`, `autorole`, `logchannel`, `automod`, `blockword`, `unblockword`
- AI: `ai`, `aichannel`, `aimodel`, `aipersonality`, `ask`
- Voice: `tts join`, `tts leave`

## Voice TTS

Create a text channel named `#ttsbot`, join a voice channel, then run `/tts join`. After that, normal messages posted in `#ttsbot` are read aloud in the joined voice channel until `/tts leave` is run. TTS uses local Piper on the server, so it does not use OpenAI API usage.

On Ubuntu/VPS hosting, install Piper and a voice model before starting the bot. This example uses the `en_US-lessac-medium` voice:

```bash
mkdir -p ~/piper/voices
cd ~/piper

wget -O piper.tar.gz https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz
tar -xzf piper.tar.gz

cd ~/piper/voices
wget https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx
wget https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json
```

Add these to `.env`:

```env
TTS_PROVIDER=piper
TTS_PIPER_COMMAND=/home/ubuntu/piper/piper/piper
TTS_PIPER_MODEL=/home/ubuntu/piper/voices/en_US-lessac-medium.onnx
```

Optional tuning:

```env
TTS_PIPER_LENGTH_SCALE=1.0
TTS_PIPER_NOISE_SCALE=0.667
TTS_PIPER_NOISE_WIDTH=0.8
```

You can still force the old eSpeak backend if you need a no-model fallback:

```env
TTS_PROVIDER=espeak
TTS_ESPEAK_COMMAND=espeak-ng
TTS_ESPEAK_VOICE=en-us
TTS_ESPEAK_SPEED=175
```

## Chipkittle AI 

The AI personality is built from the provided Chipkittle lore and the shared visual canon: white furry suit, dark horns, glowing mask-like eyes, and artifact-keeper energy. Some source names contained hateful or explicit language, so the bot uses sanitized lore and is instructed not to repeat slurs, explicit sexual content, sexual violence, or self-harm encouragement.

Enable it from the web panel or with commands:

```text
!ai on
!aichannel add #general
!ask what is the artifact's mood today?
```

## Welcome Message Placeholders

You can use these in the panel:

- `{user}` mentions the joining member
- `{username}` uses their display name
- `{server}` uses the server name

## Notes

- Keep `.env` private. It contains your Discord token and admin password.
- If you deploy this publicly, put it behind HTTPS and use a strong `SESSION_SECRET`.
- See [DEPLOYMENT.md](DEPLOYMENT.md) for Vercel and production hosting steps.
