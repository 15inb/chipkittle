# Deployment Guide

This project has two parts:

1. The Discord bot process, which must stay online with a persistent Discord websocket connection.
2. The web config panel, which is currently served by that same Node process.

Vercel is excellent for websites and serverless APIs, but it is not a good place to run the Discord bot itself because Vercel functions are short-lived and cannot keep the bot gateway connection open. The recommended setup is:

- Host the Discord bot and config panel together on a long-running Node host such as Railway, Render, Fly.io, a VPS, or your own machine.
- Use Vercel for your public website, landing page, or a page that links to the hosted config panel.

## Option A: Recommended Deployment

Use this if you want the bot and web panel to work reliably.

### 1. Push the Project to GitHub

Create a GitHub repository, then run these commands from this folder:

```powershell
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git add .
git commit -m "build discord bot with web panel"
git branch -M main
git push -u origin main
```

### 2. Deploy the Bot to a Long-Running Host

Use a service that supports persistent Node.js processes.

Recommended settings:

- Build command: `npm install`
- Start command: `npm start`
- Node version: `22`

Add these environment variables in the host dashboard:

```env
DISCORD_TOKEN=your_discord_bot_token
CLIENT_ID=your_discord_application_id
PORT=3000
PUBLIC_URL=https://your-bot-panel-host.example.com
PANEL_PASSWORD=your_admin_panel_password
SESSION_SECRET=long_random_secret
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-5.2
```

After deploy, open the host URL and log in with `PANEL_PASSWORD`.

### 3. Deploy Your Website to Vercel

If your website is a separate project, deploy that project to Vercel and add a button/link to your config panel URL.

If you want to deploy this repo as a simple Vercel website later, create a separate frontend folder for the public site so it does not try to run the Discord bot on Vercel.

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

Deploy production when ready:

```powershell
vercel deploy --prod
```

## Option B: Deploy This Repo Directly to Vercel

This is not recommended for the live bot.

What will happen:

- The Express panel may not behave like a normal always-on server.
- The Discord bot will not stay connected reliably.
- Local JSON storage in `data/config.json` will not persist correctly across serverless deployments.

Only use this if you refactor the project so Vercel hosts a frontend-only panel and the bot runs elsewhere.

## Vercel Environment Variables

For a Vercel-hosted website, you usually only need public website variables, such as:

```env
NEXT_PUBLIC_PANEL_URL=https://your-bot-panel-host.example.com
```

Do not expose these in frontend code:

```env
DISCORD_TOKEN
OPENAI_API_KEY
SESSION_SECRET
PANEL_PASSWORD
```

Those must stay server-side on the bot host.

## Custom Domain on Vercel

1. Open the project in the Vercel dashboard.
2. Go to Settings -> Domains.
3. Add your domain, such as `example.com` or `bot.example.com`.
4. Follow Vercel's DNS instructions.
5. If using a subdomain for the bot panel, point that subdomain to the long-running bot host instead of Vercel.

Suggested layout:

- `www.yourdomain.com` -> Vercel website
- `panel.yourdomain.com` -> long-running bot/panel host

## Pre-Deploy Checklist

- `.env` is not committed.
- Discord Developer Portal has these intents enabled:
  - Server Members Intent
  - Message Content Intent
- Bot invite uses the application `CLIENT_ID`, not your personal Discord ID.
- Bot role has the needed permissions:
  - Send Messages
  - Manage Messages
  - Manage Roles
  - Moderate Members
  - Manage Channels, if using lock/slowmode
- `PUBLIC_URL` matches the deployed panel URL.
- `OPENAI_API_KEY` is set only on the server that runs the bot.
