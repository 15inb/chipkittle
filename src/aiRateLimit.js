const aiCooldowns = new Map();

export function checkAiRateLimit({ guildId, userId, cooldownSeconds }) {
  const seconds = Math.max(Number(cooldownSeconds) || 0, 0);
  if (seconds === 0) {
    return { limited: false, retryAfterSeconds: 0 };
  }

  const key = `${guildId}:${userId}`;
  const now = Date.now();
  const expiresAt = aiCooldowns.get(key) || 0;

  if (expiresAt > now) {
    return {
      limited: true,
      retryAfterSeconds: Math.ceil((expiresAt - now) / 1000)
    };
  }

  aiCooldowns.set(key, now + seconds * 1000);
  return { limited: false, retryAfterSeconds: 0 };
}
