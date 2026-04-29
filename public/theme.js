(function () {
  const storageKey = "chipkittle-theme";
  const root = document.documentElement;
  function safeStorageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function safeStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {}
  }

  function readCachedJson(key, ttlMs) {
    const rawValue = safeStorageGet(key);
    if (!rawValue) return null;
    try {
      const parsed = JSON.parse(rawValue);
      if (!parsed || typeof parsed !== "object") return null;
      if (typeof parsed.savedAt !== "number" || !("data" in parsed)) return null;
      if (Date.now() - parsed.savedAt > ttlMs) return null;
      return parsed.data;
    } catch {
      return null;
    }
  }

  async function fetchCachedJson(url, { key, ttlMs = 300000, fetchOptions } = {}) {
    const cached = key ? readCachedJson(key, ttlMs) : null;
    if (cached) return cached;

    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }
    const payload = await response.json();
    if (key) {
      safeStorageSet(key, JSON.stringify({
        savedAt: Date.now(),
        data: payload
      }));
    }
    return payload;
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, (match) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[match]));
  }

  function debounce(fn, wait = 120) {
    let timeoutId = 0;
    return (...args) => {
      clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => {
        fn(...args);
      }, wait);
    };
  }

  const savedTheme = safeStorageGet(storageKey);
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  const initialTheme = savedTheme || (prefersDark ? "dark" : "light");

  function applyTheme(theme) {
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
      button.setAttribute("aria-pressed", String(theme === "dark"));
      button.setAttribute("aria-label", theme === "dark" ? "Use light mode" : "Use dark mode");
      button.textContent = theme === "dark" ? "Light" : "Dark";
    });
  }

  applyTheme(initialTheme);

  window.addEventListener("DOMContentLoaded", () => {
    applyTheme(root.dataset.theme || initialTheme);

    document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
      button.addEventListener("click", () => {
        const nextTheme = root.dataset.theme === "dark" ? "light" : "dark";
        safeStorageSet(storageKey, nextTheme);
        applyTheme(nextTheme);
      });
    });

    const actions = document.querySelector(".nav-actions");
    if (actions && !actions.querySelector("[data-public-account]")) {
      const account = document.createElement("span");
      account.className = "public-account";
      account.dataset.publicAccount = "loading";
      const next = encodeURIComponent(`${window.location.pathname}${window.location.search}`);
      account.innerHTML = `<a class="nav-button account-login" href="/profile/login?next=${next}">Log in</a>`;
      actions.prepend(account);

      fetch("/api/public/me", { cache: "no-store", credentials: "same-origin" })
        .then((response) => response.ok ? response.json() : { authenticated: false })
        .then((payload) => {
          if (!payload?.authenticated || !payload.user) return;
          account.dataset.publicAccount = "ready";
          account.innerHTML = `
            <a class="account-chip" href="/profile/edit" title="Edit your Chipkittle profile">
              ${payload.user.avatarUrl ? `<img src="${escapeHtml(payload.user.avatarUrl)}" alt="">` : ""}
              <span>${escapeHtml(payload.user.displayName || payload.user.username || "Member")}</span>
              <small>${Number(payload.user.walletBread || 0).toLocaleString()} bread</small>
            </a>
          `;
          window.ChipkittleSite = Object.assign(window.ChipkittleSite || {}, {
            currentUser: payload.user
          });
          window.dispatchEvent(new CustomEvent("chipkittle:account", { detail: payload.user }));
        })
        .catch(() => {});
    }
  });

  window.ChipkittleSite = Object.assign(window.ChipkittleSite || {}, {
    debounce,
    escapeHtml,
    readCachedJson,
    fetchCachedJson
  });
})();
