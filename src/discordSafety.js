export const NO_MENTIONS = {
  parse: [],
  users: [],
  roles: [],
  repliedUser: false
};

export function neutralizeMentions(text = "") {
  return String(text)
    .replaceAll("@everyone", "@\u200beveryone")
    .replaceAll("@here", "@\u200bhere")
    .replace(/<@&(\d+)>/g, "<@\u200b&$1>")
    .replace(/<@!?(\d+)>/g, "<@\u200b$1>");
}
