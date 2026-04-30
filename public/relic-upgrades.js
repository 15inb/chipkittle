const META_KEY = "chipkittle-relic-meta";

const catalog = [
  { id: "vitality", name: "Fur Density", description: "+18 max health per level.", max: 8, baseCost: 20, step: 14 },
  { id: "damage", name: "Horn Voltage", description: "+3 shot damage per level.", max: 10, baseCost: 24, step: 16 },
  { id: "speed", name: "Panic Footwork", description: "+14 movement speed per level.", max: 8, baseCost: 18, step: 13 },
  { id: "magnet", name: "Bread Gravity", description: "+22 pickup range per level.", max: 8, baseCost: 18, step: 12 },
  { id: "relic", name: "Relic Familiarity", description: "Relic burst charges sooner.", max: 7, baseCost: 28, step: 18 },
  { id: "crit", name: "Unwise Confidence", description: "+2% critical chance per level.", max: 6, baseCost: 30, step: 20 }
];

const essence = document.getElementById("relicUpgradeEssence");
const shop = document.getElementById("relicUpgradeShop");
const status = document.getElementById("relicUpgradeStatus");
const resetButton = document.getElementById("relicResetMeta");
const codex = document.getElementById("relicBuildCodex");

const buildCodex = [
  { name: "Thorn SMG", type: "Weapon", rarity: "common", detail: "Fast pressure. Low damage, high tempo, strong with crits and chain effects." },
  { name: "Rail Horn", type: "Weapon", rarity: "rare", detail: "Slow precision shots that pierce lines. High-skill aim build." },
  { name: "Crumb Shotgun", type: "Weapon", rarity: "rare", detail: "Close-range cone damage with knockback. Strong if you kite tightly." },
  { name: "Loaf Launcher", type: "Weapon", rarity: "epic", detail: "Explosive area control with burn. Best for packs and boss adds." },
  { name: "Spore Sprayer", type: "Weapon", rarity: "epic", detail: "Poison and slow control. Wins by turning fast enemies into paperwork." },
  { name: "Storm Relic", type: "Weapon", rarity: "legendary", detail: "Chain lightning weapon. Scales hard with shock, status, and crit synergies." },
  { name: "Stone Yak Plate", type: "Armor", rarity: "rare", detail: "Tank armor. High HP and armor, slower movement and weaker escapes." },
  { name: "Glassrunner Pelt", type: "Armor", rarity: "rare", detail: "Mobility armor. Fast and dash-heavy, but fragile." },
  { name: "Keeper Reactor", type: "Armor", rarity: "epic", detail: "Reactive shield armor. Shield breaks retaliate with shockwaves." },
  { name: "Ember Molt", type: "Armor", rarity: "epic", detail: "Regeneration armor that strengthens burn-oriented survival." },
  { name: "Void Husk", type: "Armor", rarity: "legendary", detail: "Risk shield armor. Huge shield and speed, low health buffer." }
];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function loadMeta() {
  try {
    const parsed = JSON.parse(localStorage.getItem(META_KEY) || "{}");
    return {
      essence: Math.max(0, Math.floor(Number(parsed.essence) || 0)),
      upgrades: Object.fromEntries(catalog.map((item) => [
        item.id,
        clamp(Math.floor(Number(parsed.upgrades?.[item.id]) || 0), 0, item.max)
      ]))
    };
  } catch {
    return {
      essence: 0,
      upgrades: Object.fromEntries(catalog.map((item) => [item.id, 0]))
    };
  }
}

let meta = loadMeta();

function saveMeta() {
  localStorage.setItem(META_KEY, JSON.stringify(meta));
}

function cost(item) {
  const level = meta.upgrades[item.id] || 0;
  return item.baseCost + item.step * level + Math.floor(level ** 1.6 * 8);
}

function render() {
  essence.textContent = meta.essence.toLocaleString();
  shop.innerHTML = catalog.map((item) => {
    const level = meta.upgrades[item.id] || 0;
    const maxed = level >= item.max;
    const nextCost = cost(item);
    const progress = Math.round((level / item.max) * 100);
    return `
      <article class="relic-upgrade-shop-card">
        <div>
          <strong>${item.name}</strong>
          <small>${item.description}</small>
        </div>
        <div class="relic-upgrade-meter"><span style="width:${progress}%"></span></div>
        <footer>
          <span>Level ${level}/${item.max}</span>
          <button type="button" data-upgrade="${item.id}" ${maxed || meta.essence < nextCost ? "disabled" : ""}>${maxed ? "Maxed" : `${nextCost} essence`}</button>
        </footer>
      </article>
    `;
  }).join("");
  if (codex) {
    codex.innerHTML = buildCodex.map((item) => `
      <article class="relic-upgrade-shop-card rarity-${item.rarity}">
        <div>
          <strong>${item.name}</strong>
          <small>${item.type} · ${item.detail}</small>
        </div>
      </article>
    `).join("");
  }
}

shop.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-upgrade]");
  if (!button) return;
  const item = catalog.find((entry) => entry.id === button.dataset.upgrade);
  if (!item) return;
  const level = meta.upgrades[item.id] || 0;
  const nextCost = cost(item);
  if (level >= item.max || meta.essence < nextCost) return;
  meta.essence -= nextCost;
  meta.upgrades[item.id] = level + 1;
  saveMeta();
  status.textContent = `${item.name} upgraded`;
  render();
});

resetButton.addEventListener("click", () => {
  if (!confirm("Reset Relic Siege upgrades and essence on this browser?")) return;
  meta = {
    essence: 0,
    upgrades: Object.fromEntries(catalog.map((item) => [item.id, 0]))
  };
  saveMeta();
  status.textContent = "Progress reset";
  render();
});

render();
