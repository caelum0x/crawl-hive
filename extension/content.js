// Плашка CrawlHive на странице токена. По умолчанию компактная: кольцо с баллом, вердикт, сеть, три худших флага,
// строка Larpcheck и «Open full scan». Остальное (что изменилось с прошлого скана, мини-бабл-карта, кошельки из памяти,
// снайперы, LP, дев) — под «More». Живёт в Shadow DOM, чтобы стили терминала её не ломали и она не ломала терминал.
// Терминалы — одностраничные приложения, поэтому адрес страницы отслеживаем сами и обновляем плашку при переходе.
(() => {
  const ADDR = /0x[a-fA-F0-9]{40}|[0-9A-Za-z]{32,44}/; // DexScreener пишет адрес пары маленькими буквами
  const COLOR = { CLEAN: "#a3e635", OK: "#5eead4", RISKY: "#ffb020", DANGER: "#f87171", TOO_EARLY: "#8a9099" };
  const CHAIN = { solana: "Solana", bsc: "BNB", base: "Base", robinhood: "Robinhood", ethereum: "Ethereum" };
  const NEON = ["#ff9f1c", "#ff4fa3", "#a3e635", "#38bdf8", "#a78bfa", "#2dd4bf"];
  const SOLO = ["#f97316", "#e879f9", "#facc15", "#4ade80", "#22d3ee", "#818cf8", "#fb7185", "#34d399", "#60a5fa"];
  // На обозревателях адрес в ссылке часто кошелёк, а не токен: там ошибку не показываем, просто прячем плашку.
  const EXPLORER = /(^|\.)(solscan\.io|bscscan\.com|basescan\.org)$/;
  // У FOMO токен только на /tokens/<сеть>/<адрес>; на профилях и остальных страницах плашка не нужна.
  const PAGE = { "fomo.family": /^\/tokens\// };
  let lastUrl = "";
  let host, root, hiddenFor = "";

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const pct = (n) => `${Math.round((n ?? 0) * 10) / 10}%`;

  function ensure() {
    if (host?.isConnected) return;
    host = document.createElement("div");
    host.id = "crawlhive-ext";
    host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;";
    root = host.attachShadow({ mode: "closed" });
    document.documentElement.appendChild(host);
  }

  const CSS = `
    .p{width:300px;font:13px/1.35 -apple-system,"SF Pro Text",Inter,system-ui,sans-serif;color:#e8eaed;background:#0d0e12;border:1px solid #2a2c34;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.55);overflow:hidden}
    .h{display:flex;align-items:center;gap:7px;padding:8px 10px 8px 12px;border-bottom:1px solid #1d2026}
    .h b{font-weight:800}.sym{color:#8a9099;font-weight:600;max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ch{margin-left:auto;padding:1px 7px;border-radius:999px;border:1px solid #3b3550;color:#c4b5fd;font-size:11px;font-weight:700}
    .x{cursor:pointer;color:#8a9099;border:0;background:none;font-size:16px;line-height:1;padding:0 2px}.x:hover{color:#fff}
    .h .x:first-of-type{margin-left:auto}.h .ch + .x{margin-left:0}
    .b{padding:12px}
    .v{display:flex;align-items:center;gap:12px}
    .ring{position:relative;width:58px;height:58px;flex:0 0 58px}.ring svg{position:absolute;inset:0}
    .ring span{position:absolute;inset:0;display:grid;place-items:center;font-weight:900;font-size:19px}
    .vt{font-weight:900;font-size:17px;letter-spacing:.2px}
    .rs{color:#b9bcc3;font-size:12px;margin-top:2px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    ul{margin:10px 0 0;padding:0;list-style:none}
    li{display:flex;gap:6px;padding:5px 0;border-top:1px solid #1a1d23;font-size:12px;white-space:nowrap;overflow:hidden}
    li i{font-style:normal;color:#8a9099;overflow:hidden;text-overflow:ellipsis}
    li em{font-style:normal;flex:0 0 auto}
    .bad{color:#fca5a5}.ok{color:#bef264}.warn{color:#ffd27a}.info{color:#cbd5e1}
    .lc{display:flex;align-items:center;gap:7px;margin-top:9px;padding:6px 9px;border-radius:9px;text-decoration:none;color:#e8eaed;font-size:12px}
    .lc small{color:#8a9099;font-size:10px;letter-spacing:.08em}.lc span{margin-left:auto;color:#8a9099}
    .act{display:flex;gap:7px;margin-top:10px}
    a.f{flex:1;text-align:center;padding:8px;border-radius:10px;background:linear-gradient(90deg,#ffb020,#ff6a3d,#f472b6);color:#0b0c0f;font-weight:800;text-decoration:none}
    .more{cursor:pointer;padding:8px 11px;border-radius:10px;border:1px solid #2a2c34;background:#14161b;color:#e8eaed;font:700 12px -apple-system,system-ui,sans-serif}
    .more:hover{background:#1b1e25}
    .sec{margin-top:11px}.st{color:#8a9099;font-size:10px;font-weight:700;letter-spacing:.09em;margin-bottom:4px}
    .map{display:block;margin:2px auto 0;border-radius:12px;background:#08090c;border:1px solid #1d2026}
    .m{padding:10px 12px;color:#b9bcc3}
    .min{cursor:pointer;display:flex;align-items:center;gap:7px;padding:7px 11px;border-radius:999px;background:#0d0e12;border:1px solid #2a2c34;color:#e8eaed;font:700 12px -apple-system,system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.5)}
    .dot{width:9px;height:9px;border-radius:50%}`;

  const logo = `<svg width="18" height="18" viewBox="0 0 64 64"><ellipse cx="32" cy="24" rx="12" ry="14" fill="#ffb020"/><g stroke="#f39614" stroke-width="3" fill="none" stroke-linecap="round"><path d="M22 30 L10 22"/><path d="M22 34 L9 36"/><path d="M26 37 L17 48"/><path d="M42 30 L54 22"/><path d="M42 34 L55 36"/><path d="M38 37 L47 48"/></g><circle cx="27.5" cy="23" r="3" fill="#07080a"/><circle cx="36.5" cy="23" r="3" fill="#07080a"/></svg>`;

  function render(html) {
    ensure();
    root.innerHTML = `<style>${CSS}</style>${html}`;
    root.querySelectorAll("[data-x]").forEach((el) => el.addEventListener("click", () => {
      hiddenFor = lastUrl;
      chrome.storage.local.set({ collapsed: true });
      show(lastData);
    }));
    root.querySelectorAll("[data-open]").forEach((el) => el.addEventListener("click", () => {
      chrome.storage.local.set({ collapsed: false });
      hiddenFor = "";
      show(lastData);
    }));
    root.querySelectorAll("[data-more]").forEach((el) => el.addEventListener("click", async () => {
      const { expanded } = await chrome.storage.local.get("expanded");
      await chrome.storage.local.set({ expanded: !expanded });
      show(lastData);
    }));
  }

  const ring = (score, c) => {
    const r = 25, len = 2 * Math.PI * r, v = Math.max(0, Math.min(100, Number(score) || 0));
    return `<div class="ring"><svg width="58" height="58" viewBox="0 0 58 58"><circle cx="29" cy="29" r="${r}" fill="none" stroke="#1d2026" stroke-width="6"/><circle cx="29" cy="29" r="${r}" fill="none" stroke="${c}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${(len * v) / 100} ${len}" transform="rotate(-90 29 29)"/></svg><span style="color:${c}">${esc(score ?? "-")}</span></div>`;
  };

  // Мини-бабл-карта: крупнейший кошелёк в центре, остальные вокруг; цвет группы-оператора, ↺N — уже встречался.
  const SPOTS = [[138, 62], [84, 40], [192, 38], [78, 92], [198, 90], [138, 18], [138, 106], [36, 62], [240, 64], [30, 22], [246, 108], [32, 104]];
  function bubbleMap(nodes) {
    const max = Math.max(...nodes.map((n) => n.pct), 0.01);
    const dots = nodes.slice(0, SPOTS.length).map((n, i) => {
      const r = 6 + 14 * Math.sqrt(n.pct / max);
      const c = n.g >= 0 ? NEON[n.g % NEON.length] : SOLO[i % SOLO.length];
      const [x, y] = SPOTS[i];
      const seen = n.seen ? `<text x="${x}" y="${y + 3.5}" text-anchor="middle" font-size="9" font-weight="800" fill="#fff">↺${n.seen}</text>` : "";
      return `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}" fill-opacity=".3" stroke="${c}" stroke-width="${n.g >= 0 ? 2.5 : 1.5}"/>${seen}`;
    });
    return `<svg class="map" width="276" height="124" viewBox="0 0 276 124">${dots.join("")}</svg>`;
  }

  let lastData = null;
  async function show(d) {
    lastData = d;
    const { collapsed, expanded } = await chrome.storage.local.get(["collapsed", "expanded"]);
    const head = (extra = "") => `<div class="h">${logo}<b>CrawlHive</b>${extra}<button class="x" data-x title="Minimize">−</button></div>`;
    if (!d) return render(`<div class="p">${head()}<div class="m">Scanning this token…</div></div>`);
    if (d.error) {
      if (EXPLORER.test(location.hostname)) return host?.remove();
      return render(`<div class="p">${head()}<div class="m">${esc(d.error)}</div></div>`);
    }
    const c = COLOR[d.verdict] || "#8a9099";
    const verdict = esc(String(d.verdict).replace("_", " "));
    if (collapsed || hiddenFor === lastUrl)
      return render(`<div class="min" data-open><span class="dot" style="background:${c}"></span>${logo}${esc(d.score ?? "")} ${verdict} · $${esc(d.symbol)}</div>`);

    const flags = d.flags || [];
    const flagRow = (f) => `<li class="bad"><em>✕</em>${esc(f.label)} <i>· ${esc(f.note)}</i></li>`;
    const chip = `<span class="sym">$${esc(d.symbol)}</span><span class="ch">${esc(CHAIN[d.chain] || d.chain)}</span>`;
    let more = "";
    if (expanded) {
      const parts = [];
      if (d.since?.changes?.length)
        parts.push(`<div class="sec"><div class="st">SINCE LAST SCAN</div><ul style="margin:0">${d.since.changes.map((s) => `<li class="${s.tone === "bad" ? "bad" : s.tone === "good" ? "ok" : "info"}"><em>${s.tone === "bad" ? "▼" : s.tone === "good" ? "▲" : "•"}</em>${esc(s.label)} <i>· ${esc(s.from)} → ${esc(s.to)}</i></li>`).join("")}</ul></div>`);
      if (d.map) {
        const h = d.history;
        const seen = h?.wallets ? `<div class="warn" style="font-size:12px;margin-top:5px">↺ ${h.wallets} wallet${h.wallets > 1 ? "s" : ""} seen on ${h.tokens} other token${h.tokens > 1 ? "s" : ""}${h.dumped ? `, ${h.dumped} dumped` : ""}</div>` : "";
        parts.push(`<div class="sec"><div class="st">WHO HOLDS IT${d.operators ? ` · ${d.operators} LINKED OPERATOR${d.operators > 1 ? "S" : ""}` : ""}</div>${bubbleMap(d.map)}${seen}</div>`);
      }
      const rows = flags.slice(3).map(flagRow);
      if (d.lp && d.lp.status !== "curve") {
        const soon = d.lp.unlockAt && d.lp.unlockAt - Date.now() < 30 * 864e5;
        rows.push(d.lp.status === "burned" ? `<li class="ok"><em>✓</em>LP burned</li>` : d.lp.status === "unlocked" ? `<li class="bad"><em>✕</em>LP not locked (${pct(d.lp.lockedPct)})</li>` : `<li class="${soon ? "warn" : "ok"}"><em>${soon ? "⚠" : "✓"}</em>LP ${pct(d.lp.lockedPct)} locked${d.lp.unlockAt ? ` <i>· unlocks ${new Date(d.lp.unlockAt).toISOString().slice(0, 10)}</i>` : ""}</li>`);
      }
      if (d.snipers) rows.push(`<li class="${d.snipers.holdPct >= 5 ? "warn" : "ok"}"><em>🎯</em>${d.snipers.wallets} snipers hold ${pct(d.snipers.holdPct)}${d.snipers.sold ? ` <i>· ${d.snipers.sold} sold</i>` : ""}</li>`);
      if (d.operator) rows.push(`<li class="${d.operator.pct >= 15 ? "bad" : "warn"}"><em>👥</em>operator: ${d.operator.wallets} wallets hold ${pct(d.operator.pct)} <i>· ${esc(d.operator.roles.join(" + "))}</i></li>`);
      if (d.devSnipers) rows.push(`<li class="bad"><em>✕</em>${d.devSnipers} snipers funded by the dev</li>`);
      if (d.dev) rows.push(`<li class="info"><em>🧾</em>dev: ${d.dev.launched > 1 ? `${d.dev.launched - 1} earlier launches, ${d.dev.graduated} graduated` : "first launch"} <i>· <a href="https://crawlhive.xyz/dev/${esc(d.dev.creator)}" target="_blank" style="color:#7cc4ff">history</a></i></li>`);
      if (rows.length) parts.push(`<div class="sec"><div class="st">DETAILS</div><ul style="margin:0">${rows.join("")}</ul></div>`);
      more = parts.join("");
    }
    render(`<div class="p">${head(chip)}<div class="b">
      <div class="v">${ring(d.score, c)}<div style="min-width:0"><div class="vt" style="color:${c}">${verdict}</div><div class="rs">${esc(d.reason)}</div></div></div>
      ${flags.length ? `<ul>${flags.slice(0, 3).map(flagRow).join("")}</ul>` : ""}${larpLine(d.larp)}${more}
      <div class="act"><a class="f" href="${esc(d.url)}" target="_blank">Open full scan</a><button class="more" data-more>${expanded ? "Less ▴" : "More ▾"}</button></div></div></div>`);
  }

  // Второе мнение Larpcheck о проекте за токеном одной строкой; ссылка на их проверку обязательна.
  function larpLine(l) {
    if (!l || !l.verdict || !l.url) return "";
    const lc = /SCAM|LARP/.test(l.verdict) ? "#f87171" : /REAL/.test(l.verdict) && !/PARTLY/.test(l.verdict) ? "#a3e635" : "#ffb020";
    return `<a class="lc" href="${esc(l.url)}" target="_blank" style="border:1px solid ${lc}55;background:${lc}12"><small>LARPCHECK</small><b style="color:${lc}">${esc(l.verdict)}${l.score != null ? " " + esc(l.score) : ""}</b><span>↗</span></a>`;
  }

  function tick() {
    const url = location.href;
    if (url === lastUrl) return;
    lastUrl = url;
    const only = PAGE[location.hostname];
    if (!ADDR.test(location.pathname + location.search) || (only && !only.test(location.pathname))) {
      if (host) host.remove();
      return;
    }
    show(null);
    chrome.runtime.sendMessage({ type: "verdict", url }, (d) => {
      if (url !== lastUrl) return; // пока ждали, пользователь ушёл на другой токен
      show(d || { error: "No answer from CrawlHive" });
    });
  }

  tick();
  setInterval(tick, 1000);
})();
