// ─── MemeScreener 4.0 — Dashboard ───────────────────────────────────────────
const WS_URL  = `ws://${location.host}/ws`;
const API_URL = `${location.origin}/api`;

let ws, wsTimer;
let allTokens      = [];
let openPositions  = [];
let closedPositions= [];
let pnlStats        = { totalPnlSol: 0, winRate: 0, totalTrades: 0 };
let selectedAddr    = null;
let currentTab      = "alert";
let currentSort     = "finalScore";
let sortAsc         = false;
let nextScanSecs    = 0;
let countdownTimer;

const TIER_ICON = { S: "S", A: "A", B: "B", C: "C", REJECT: "✗" };

// ─── Source badge helpers (4.0) ───────────────────────────────────────────────
const SOURCE_ICON = { dexscreener: "📈", birdeye: "🦅", pumpfun: "🎰" };

function renderSourceBadges(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return "";
  const badges = sources.map(s => {
    const icon = SOURCE_ICON[s] || "🔗";
    return `<span class="source-badge" title="${s}">${icon}</span>`;
  }).join("");
  const star = sources.length >= 2 ? `<span class="multi-source-star" title="Multi-source confirmed">⭐</span>` : "";
  return `<span class="source-badges">${star}${badges}</span>`;
}

// ─── WebSocket ───────────────────────────────────────────────────────────────
function connectWS() {
  if (ws && ws.readyState < 2) return;
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    setStatus("idle", "Connected");
    clearTimeout(wsTimer);
    loadPositions(); // initial pull, since WS INITIAL_STATE doesn't carry full position rows
  };
  ws.onmessage = e => {
    try { handleMsg(JSON.parse(e.data)); } catch {}
  };
  ws.onclose = () => {
    setStatus("error", "Reconnecting...");
    wsTimer = setTimeout(connectWS, 3000);
  };
}

function handleMsg({ type, data }) {
  switch (type) {
    case "INITIAL_STATE":
      allTokens = normalizeList([...(data.tokens || []), ...(data.watchTokens || [])]);
      renderTable();
      updateStats(data.lastScan);
      loadAlerts(data.alerts || []);
      refreshTgStatus(data.alertsLastHour);
      startCountdown();
      break;

    case "SCAN_START":
      setStatus("active", "Scanning...");
      prog(2, "Initializing...");
      break;

    case "SCAN_FETCHED":
      prog(10, `Fetched ${data.count} tokens`);
      break;

    case "SCAN_PROGRESS": {
      const pct = Math.round((data.current / data.total) * 85) + 10;
      prog(pct, `${data.current}/${data.total} — $${data.symbol}`);
      break;
    }

    case "TOKEN_UPDATE":
      upsertToken(data);
      renderTable();
      if (selectedAddr === data.address) renderDetail(data);
      break;

    case "SCAN_COMPLETE":
      setStatus("idle", `Done — ${data.summary.totalCandidates} scanned`);
      prog(100, "");
      setTimeout(() => prog(0, ""), 2000);
      updateStats(data.summary);
      startCountdown();
      break;

    case "ALERT":
      addFeedItem(data);
      break;

    case "POSITION_OPENED":
      toast(`✅ Opened $${data.symbol} — ${data.amount_sol} SOL`);
      loadPositions();
      break;

    case "POSITION_CLOSED": {
      const pnlEmoji = (data.pnl_pct ?? 0) >= 0 ? "🟢" : "🔴";
      toast(`${pnlEmoji} $${data.symbol} closed (${data.reason}): ${data.pnl_pct?.toFixed(1) ?? "—"}%`);
      loadPositions();
      break;
    }

    case "SCAN_ERROR":
      setStatus("error", `Error: ${data.error || "unknown"}`);
      break;
  }
}

// ─── Token table ─────────────────────────────────────────────────────────────
function normalizeList(list) {
  const seen = new Map();
  for (const t of list) {
    const addr = t.address || t.token_address;
    if (addr) seen.set(addr, t);
  }
  return Array.from(seen.values());
}

function upsertToken(t) {
  const i = allTokens.findIndex(x => x.address === t.address);
  if (i >= 0) allTokens[i] = { ...allTokens[i], ...t };
  else allTokens.unshift(t);
}

function getFiltered() {
  let list = allTokens.filter(t => {
    if (currentTab === "alert") return t.decision === "alert";
    if (currentTab === "watch") return t.decision === "watch";
    if (currentTab === "positions") return false; // positions render separately
    return t.decision !== "avoid";
  });

  list.sort((a, b) => {
    const va = a[currentSort] ?? 0;
    const vb = b[currentSort] ?? 0;
    return sortAsc ? va - vb : vb - va;
  });

  return list;
}

function renderTable() {
  if (currentTab === "positions") return; // handled by renderPositions()

  const list = getFiltered();
  const tbody = document.getElementById("tbody");

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10"><div class="empty"><div class="spinner"></div>Scan in progress — tokens will appear shortly</div></td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(t => buildRow(t)).join("");
}

function buildRow(t) {
  const score  = t.finalScore || t.final_score || 0;
  const risk   = t.riskScore  || t.risk_score  || 0;
  const vol    = t.volume1hUsd || t.volume_1h  || 0;
  const liq    = t.liquidityUsd || t.liquidity_usd || 0;
  const ch1h   = t.priceChange1h || t.price_change_1h || 0;
  const price  = t.priceUsd || t.price_usd || 0;
  const dec    = t.decision || "watch";
  const sym    = t.symbol || "???";
  const tier   = t.tier || "C";
  const jup    = t.jupiterRoutable !== undefined ? t.jupiterRoutable
               : (t.jupiter_routable === null || t.jupiter_routable === undefined ? null : !!t.jupiter_routable);

  const scoreColor = score >= 75 ? "var(--lime)" : score >= 55 ? "var(--yellow)" : "var(--blue)";
  const riskColor  = risk  >= 60 ? "var(--red)"  : risk  >= 35 ? "var(--yellow)" : "var(--lime)";
  const sel        = selectedAddr === t.address ? "selected" : "";
  const jupHtml    = jup === null ? `<span style="color:var(--dim)">—</span>`
                    : jup ? `<span style="color:var(--lime)">✓</span>`
                          : `<span style="color:var(--red)">✗</span>`;

  return `<tr class="${sel}" onclick="selectToken('${t.address}')" style="cursor:pointer">
    <td><span class="tier-badge tier-${tier}">${TIER_ICON[tier] ?? tier}</span></td>
    <td>
      <div class="sym-cell">
        <div class="sym-avatar">${sym.slice(0,3)}</div>
        <div>
          <div class="sym-name">$${sym} ${renderSourceBadges(t.sources || (t.source ? [t.source] : []))}</div>
          <div class="sym-dex">${t.dexId || t.dex_id || "—"}</div>
        </div>
      </div>
    </td>
    <td style="font-family:monospace">$${fmtPrice(price)}</td>
    <td class="${ch1h >= 0 ? "pos" : "neg"}">${ch1h >= 0 ? "+" : ""}${ch1h.toFixed(1)}%</td>
    <td style="font-family:monospace">${fmtUsd(vol)}</td>
    <td style="font-family:monospace">${fmtUsd(liq)}</td>
    <td>
      <div class="score-wrap">
        <div class="score-num" style="color:${riskColor}">${risk}</div>
        <div class="score-bar"><div class="score-fill" style="width:${risk}%;background:${riskColor}"></div></div>
      </div>
    </td>
    <td>
      <div class="score-wrap">
        <div class="score-num" style="color:${scoreColor}">${score}</div>
        <div class="score-bar"><div class="score-fill" style="width:${score}%;background:${scoreColor}"></div></div>
      </div>
    </td>
    <td><span class="badge badge-${dec}">${dec.toUpperCase()}</span></td>
    <td>${jupHtml}</td>
  </tr>`;
}

// ─── Detail panel ────────────────────────────────────────────────────────────
function selectToken(address) {
  selectedAddr = selectedAddr === address ? null : address;
  renderTable();

  const panel = document.getElementById("detailPanel");
  if (!selectedAddr) { panel.classList.remove("open"); return; }

  const t = allTokens.find(x => x.address === address);
  if (t) { panel.classList.add("open"); renderDetail(t); }
}

function renderDetail(t) {
  const checks = t.checks || {};
  const comps  = t.components || {};
  const sym    = t.symbol || "???";
  const score  = t.finalScore || t.final_score || 0;
  const addr   = t.address || "—";
  const url    = t.pairUrl || t.pair_url || `https://dexscreener.com/solana/${addr}`;
  const age    = t.ageMinutes ?? t.age_minutes;
  const tier   = t.tier || "C";
  const ev     = t.evidence ? (Array.isArray(t.evidence) ? t.evidence : JSON.parse(t.evidence)) : [];

  const checkNames = { age:"Age", liquidity:"Liquidity", volume:"Volume", volatility:"Volatility", fdvRatio:"FDV/Liq", holderConc:"Top 10", honeypot:"Sell Sim", mintAuth:"Mint Auth" };
  const checkHtml = Object.entries(checkNames).map(([k, lbl]) => {
    const c = checks[k] || {};
    return `<div class="check-row">
      <span>${c.passed ? "✅" : "❌"}</span>
      <span class="check-lbl">${lbl}</span>
      <span class="check-val">${c.value || "—"}</span>
    </div>`;
  }).join("");

  const compNames = { volumeVelocity:"Vol Velocity", priceMomentum:"Price Mom", holderGrowth:"Holder Dist", liquidityDepth:"Liq Depth", txActivity:"TX Activity", ageWindow:"Age Window" };
  const compHtml = Object.entries(compNames).map(([k, lbl]) => {
    const v = comps[k] || 0;
    return `<div class="comp-row">
      <div class="comp-lbl">${lbl}</div>
      <div class="comp-bar"><div class="comp-fill" style="width:${v}%"></div></div>
      <div class="comp-val">${v}</div>
    </div>`;
  }).join("");

  document.getElementById("detailInner").innerHTML = `
    <div class="detail-col">
      <div>
        <div class="detail-title">
          <span class="tier-badge tier-${tier}" style="margin-right:6px">${TIER_ICON[tier] ?? tier}</span>
          $${sym} — Score ${score}/100 · Age ${age != null ? fmtAge(age) : "?"}
        </div>
        ${ev.length ? `<div style="font-size:10px;color:var(--dim);line-height:1.7">${ev.join(" · ")}</div>` : ""}
        <div class="address-box">
          <div class="address-text" title="${addr}">${addr}</div>
          <button class="copy-btn" onclick="copyAddr('${addr}')">Copy</button>
        </div>
        <a class="detail-link" href="${url}" target="_blank">📊 View on DexScreener ↗</a>
      </div>

      <div class="trade-form">
        <div class="detail-title" style="margin-top:4px">Paper Trade</div>
        <div class="trade-row">
          <input class="trade-input" id="tradeAmount" type="number" step="0.01" placeholder="SOL amount" value="0.1"/>
          <input class="trade-input" id="tradeSl" type="number" step="1" placeholder="SL % (opt)"/>
          <input class="trade-input" id="tradeTp" type="number" step="1" placeholder="TP % (opt)"/>
        </div>
        <button class="buy-btn" onclick="paperBuy('${addr}','${sym}')">
          📈 Open Paper Position
        </button>
      </div>
    </div>

    <div class="detail-col">
      <div class="detail-title">Anti-Scam Checks</div>
      ${checkHtml}
    </div>

    <div class="detail-col">
      <div class="detail-title">Momentum Components</div>
      ${compHtml}
    </div>`;
}

// ─── Paper trading ───────────────────────────────────────────────────────────
async function loadPositions() {
  try {
    const r = await fetch(`${API_URL}/positions`);
    const d = await r.json();
    openPositions   = d.open   || [];
    closedPositions = d.closed || [];
    pnlStats        = d.stats  || pnlStats;
    renderPnlBar();
    if (currentTab === "positions") renderPositions();
  } catch { /* backend offline — silently skip */ }
}

function renderPnlBar() {
  const sign = pnlStats.totalPnlSol >= 0 ? "+" : "";
  const el = document.getElementById("pnlTotal");
  el.textContent = `${sign}${pnlStats.totalPnlSol.toFixed(4)} SOL`;
  el.style.color = pnlStats.totalPnlSol >= 0 ? "var(--lime)" : "var(--red)";
  document.getElementById("pnlWinRate").textContent = `${pnlStats.winRate.toFixed(1)}%`;
  document.getElementById("pnlTrades").textContent  = pnlStats.totalTrades;
  document.getElementById("pnlOpen").textContent    = openPositions.length;
}

function renderPositions() {
  const panel = document.getElementById("positionsPanel");
  const rows = [];

  if (openPositions.length === 0 && closedPositions.length === 0) {
    panel.innerHTML = `<div class="empty">No paper positions yet. Select a token and open one.</div>`;
    return;
  }

  if (openPositions.length > 0) {
    rows.push(`<div class="section-title" style="padding:0 4px">Open (${openPositions.length})</div>`);
    rows.push(...openPositions.map(p => `
      <div class="position-card">
        <div class="pos-head">
          <span class="pos-sym">$${p.symbol}</span>
          <span class="pos-pnl" style="color:var(--dim)">${p.amount_sol} SOL</span>
        </div>
        <div class="pos-meta">
          Entry: $${fmtPrice(p.entry_price)}<br/>
          SL: ${p.sl_pct ? `-${p.sl_pct}%` : "none"} · TP: ${p.tp_pct ? `+${p.tp_pct}%` : "none"}<br/>
          Opened: ${fmtTime(p.opened_at)}
        </div>
        <div class="pos-actions">
          <button onclick="paperSell('${p.id}', 0.5)">Sell 50%</button>
          <button onclick="paperSell('${p.id}', 1)">Sell 100%</button>
        </div>
      </div>`));
  }

  if (closedPositions.length > 0) {
    rows.push(`<div class="section-title" style="padding:8px 4px 0">Closed (${closedPositions.length})</div>`);
    rows.push(...closedPositions.map(p => {
      const pnlColor = (p.pnl_pct ?? 0) >= 0 ? "var(--lime)" : "var(--red)";
      const pnlSign  = (p.pnl_pct ?? 0) >= 0 ? "+" : "";
      return `
      <div class="position-card closed">
        <div class="pos-head">
          <span class="pos-sym">$${p.symbol}</span>
          <span class="pos-pnl" style="color:${pnlColor}">${pnlSign}${p.pnl_pct?.toFixed(2) ?? "—"}%</span>
        </div>
        <div class="pos-meta">
          $${fmtPrice(p.entry_price)} → $${fmtPrice(p.exit_price)} · ${p.reason}<br/>
          PnL: ${pnlSign}${p.pnl_sol?.toFixed(4) ?? "—"} SOL · ${fmtTime(p.closed_at)}
        </div>
      </div>`;
    }));
  }

  panel.innerHTML = rows.join("");
}

async function paperBuy(address, symbol) {
  const amountSol = parseFloat(document.getElementById("tradeAmount")?.value || "0");
  const slPct     = parseFloat(document.getElementById("tradeSl")?.value || "");
  const tpPct     = parseFloat(document.getElementById("tradeTp")?.value || "");

  if (!amountSol || amountSol <= 0) return toast("❌ Enter a valid SOL amount", true);

  try {
    const r = await fetch(`${API_URL}/positions/buy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address, amountSol,
        slPct: isNaN(slPct) ? undefined : slPct,
        tpPct: isNaN(tpPct) ? undefined : tpPct,
      }),
    });
    const d = await r.json();
    if (!r.ok) return toast(`❌ ${d.error || "Failed to open position"}`, true);
    toast(`✅ Opened $${symbol} — ${amountSol} SOL @ $${fmtPrice(d.position.entry_price)}`);
    loadPositions();
  } catch {
    toast("❌ Backend unreachable", true);
  }
}

async function paperSell(positionId, fraction) {
  try {
    const r = await fetch(`${API_URL}/positions/${positionId}/sell`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fraction }),
    });
    const d = await r.json();
    if (!r.ok) return toast(`❌ ${d.error || "Sell failed"}`, true);
    const c = d.closed;
    const pnlEmoji = (c.pnl_pct ?? 0) >= 0 ? "🟢" : "🔴";
    toast(`${pnlEmoji} Sold $${c.symbol} (${(fraction*100).toFixed(0)}%): ${c.pnl_pct?.toFixed(2) ?? "—"}%`);
    loadPositions();
  } catch {
    toast("❌ Backend unreachable", true);
  }
}

// ─── Alert feed ──────────────────────────────────────────────────────────────
function loadAlerts(alerts) {
  const feed = document.getElementById("alertFeed");
  if (!alerts.length) return;
  feed.innerHTML = "";
  alerts.slice(0, 15).forEach(a => addFeedItemRaw(
    a.symbol || a.token_symbol,
    a.finalScore || a.final_score,
    a.volume1hUsd || a.volume_1h,
    a.createdAt || a.created_at,
    a.tokenAddress || a.token_address
  ));
}

function addFeedItem({ token, scoreData }) {
  if (!token) return;
  addFeedItemRaw(token.symbol, scoreData?.finalScore, token.volume1hUsd, new Date().toISOString(), token.address);
}

function addFeedItemRaw(symbol, score, vol, ts, address) {
  const feed = document.getElementById("alertFeed");
  const ph = feed.querySelector('[style*="cursor:default"]');
  if (ph) ph.remove();

  const el = document.createElement("div");
  el.className = "alert-item";
  el.innerHTML = `
    <span class="alert-time">${fmtTime(ts)}</span>
    <div class="alert-sym">🚀 $${symbol}</div>
    <div class="alert-meta">Score: ${score}/100 · ${fmtUsd(vol || 0)} vol</div>`;
  el.onclick = () => selectToken(address);
  feed.insertBefore(el, feed.firstChild);
  while (feed.children.length > 20) feed.removeChild(feed.lastChild);
}

// ─── UI helpers ──────────────────────────────────────────────────────────────
function setStatus(state, text) {
  document.getElementById("scanDot").className = `dot ${state}`;
  document.getElementById("scanText").textContent = text;
}

function prog(pct, label) {
  document.getElementById("progFill").style.width  = `${pct}%`;
  document.getElementById("progLabel").textContent = label;
}

function updateStats(s) {
  if (!s) return;
  document.getElementById("sScanned").textContent = s.totalCandidates ?? s.scanned ?? "—";
  document.getElementById("sAlerts").textContent  = s.alertsCount ?? s.alerts ?? "—";
  document.getElementById("sWatch").textContent   = s.watchCount  ?? s.watch  ?? "—";
  document.getElementById("sAvoid").textContent   = s.avoidCount  ?? s.avoid  ?? "—";
}

function refreshTgStatus(alertsH) {
  document.getElementById("tgSub").textContent = `Alerts this hour: ${alertsH ?? 0}`;
}

function startCountdown() {
  clearInterval(countdownTimer);
  nextScanSecs = 30 * 60;
  countdownTimer = setInterval(() => {
    nextScanSecs--;
    if (nextScanSecs <= 0) { clearInterval(countdownTimer); return; }
    const m = Math.floor(nextScanSecs / 60);
    const s = String(nextScanSecs % 60).padStart(2, "0");
    document.getElementById("nextScan").textContent = `Next: ${m}m ${s}s`;
  }, 1000);
}

function switchTab(tab, el) {
  currentTab = tab;
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  el.classList.add("active");
  selectedAddr = null;
  document.getElementById("detailPanel").classList.remove("open");

  const tableWrap     = document.getElementById("tableWrap");
  const positionsPanel= document.getElementById("positionsPanel");

  if (tab === "positions") {
    tableWrap.style.display = "none";
    positionsPanel.style.display = "flex";
    loadPositions();
  } else {
    tableWrap.style.display = "block";
    positionsPanel.style.display = "none";
    renderTable();
  }
}

function setSort(col) {
  if (currentSort === col) sortAsc = !sortAsc;
  else { currentSort = col; sortAsc = false; }
  document.querySelectorAll("th").forEach(th => th.classList.remove("sorted"));
  if (window.event?.currentTarget) window.event.currentTarget.classList.add("sorted");
  renderTable();
}

async function triggerScan() {
  try {
    const r = await fetch(`${API_URL}/scan/trigger`, { method: "POST" });
    const d = await r.json();
    if (d.status === "already_scanning") toast("⏳ Scan already running");
    else toast("⚡ Scan triggered");
  } catch { toast("❌ Backend unreachable", true); }
}

function copyAddr(addr) {
  navigator.clipboard.writeText(addr).then(() => toast("📋 Copied"));
}

function toast(msg, err = false) {
  const el = document.createElement("div");
  el.style.cssText = `
    position:fixed;bottom:16px;right:16px;z-index:9999;
    padding:10px 14px;border-radius:8px;font-size:11px;
    font-family:'JetBrains Mono',monospace;
    background:${err ? "rgba(248,81,73,.15)" : "rgba(63,185,80,.12)"};
    border:1px solid ${err ? "rgba(248,81,73,.35)" : "rgba(63,185,80,.3)"};
    color:${err ? "#f47067" : "#3fb950"};
    backdrop-filter:blur(12px);
  `;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ─── Format helpers ───────────────────────────────────────────────────────────
function fmtUsd(n) {
  if (!n) return "—";
  if (n >= 1e9) return `$${(n/1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n/1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n/1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}
function fmtPrice(n) {
  if (!n) return "—";
  if (n < 0.000001) return n.toExponential(4);
  if (n < 0.01) return n.toFixed(8);
  if (n < 1)    return n.toFixed(6);
  return n.toFixed(4);
}
function fmtAge(m) {
  if (m < 60)   return `${m}m`;
  if (m < 1440) return `${Math.floor(m/60)}h ${m%60}m`;
  return `${Math.floor(m/1440)}d`;
}
function fmtTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
connectWS();
