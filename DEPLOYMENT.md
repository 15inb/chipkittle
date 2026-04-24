# Easy Deployment Guide

This bot has two pieces:

- **Discord bot + config panel:** must run all the time.
- **Your website:** can run on Vercel.

The easiest setup is:

- Put the **bot and config panel** on Railway, Render, Fly.io, a VPS, or another always-on Node.js host.
- Put your **public website** on Vercel.
- Link from the Vercel website to the bot panel.

Example:

- `www.yourdomain.com` -> Vercel website
- `panel.yourdomain.com` -> bot config panel

## Step 1: Push the Code to GitHub

You already pushed this project to:

```text
https://github.com/15inb/chipkittle
```

If you make more changes later, push them with:

```powershell
git add .
git commit -m "update bot"
git push
```

## Step 2: Host the Bot Somewhere Always-On

Use Railway, Render, Fly.io, or a VPS. Vercel is not the best place for the bot because Discord bots need to stay connected 24/7.

On the hosting site, create a new Node.js project from your GitHub repo:

```text
15inb/chipkittle
```

Use these settings:

```text
Build command: npm install
Start command: npm start
Node version: 22
```

## Step 3: Add Environment Variables

In the host dashboard, add these variables:

```env
DISCORD_TOKEN=your_discord_bot_token
CLIENT_ID=your_discord_application_id
PORT=3000
PUBLIC_URL=https://panel.yourdomain.com
PANEL_PASSWORD=your_panel_password
ALLOW_LEGACY_PANEL_PASSWORD_LOGIN=false
SESSION_SECRET=make_this_long_and_random
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-5.2
```

Notes:

- `CLIENT_ID` is your Discord Application ID, not your personal Discord user ID.
- `OPENAI_API_KEY` can be left blank if you do not want AI yet.
- `PUBLIC_URL` should be the final web address of the bot panel.

## Step 4: Turn on Discord Bot Intents

Go to the Discord Developer Portal:

```text
https://discord.com/developers/applications
```

Open your bot application, then go to **Bot**.

Turn on:

- Server Members Intent
- Message Content Intent

Save changes.

## Step 5: Invite the Bot

After the bot is deployed, open the web panel.

The dashboard should have an **Invite bot** button if `CLIENT_ID` is set.

The bot needs these permissions:

- Send Messages
- Manage Messages
- Manage Roles
- Moderate Members
- Manage Channels, if you want lock/slowmode commands
- View Channels
- Connect and Speak, if you want voice-channel TTS

## Step 6: Deploy Your Website on Vercel

Use Vercel for the public website, not the always-on Discord bot.

This repo includes a simple Vercel landing page at `public/index.html`, so Vercel has something to show at `/`.

When importing the GitHub repo in Vercel, use these settings:

```text
Repository: 15inb/chipkittle
Root Directory: ./
Framework Preset: Other
Build Command: leave empty
Output Directory: public
Install Command: npm install
```

Do not put `15inb/chipkittle` in **Root Directory**. That field is only for a folder inside the repo, such as `apps/web`. This project lives at the repo root, so the Root Directory should be blank or `./`.

Install the Vercel CLI:

```powershell
npm.cmd install -g vercel
```

Log in:

```powershell
vercel login
```

Deploy a preview:

```powershell
vercel deploy
```

Deploy production:

```powershell
vercel deploy --prod
```

On your website, add a link to:

```text
https://panel.yourdomain.com
```

If Vercel still shows `404: NOT_FOUND`, make sure your latest code is pushed to GitHub and redeploy the project.

## Step 7: Add a Custom Domain

For your Vercel website:

1. Open your project in Vercel.
2. Go to **Settings**.
3. Go to **Domains**.
4. Add `www.yourdomain.com`.
5. Follow Vercel's DNS instructions.

For the bot panel:

1. Open your bot host, such as Railway or Render.
2. Add `panel.yourdomain.com` as a custom domain.
3. Follow that host's DNS instructions.
4. Set `PUBLIC_URL=https://panel.yourdomain.com`.
5. Redeploy or restart the bot.

## Why Not Run the Bot on Vercel?

Vercel is serverless. It starts and stops functions when requests come in.

Discord bots need a constant live connection to Discord. If the process stops, the bot goes offline.

That is why the bot should run on an always-on host, while your website can still run on Vercel.

## Final Checklist

- GitHub repo is pushed.
- Bot host has all environment variables.
- Discord intents are enabled.
- Bot is invited to your server.
- Web panel opens in the browser.
- Vercel website links to the web panel.
- `.env` is not committed to GitHub.
