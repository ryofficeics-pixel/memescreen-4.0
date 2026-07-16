// ─── MemeScreener 4.0 — Dashboard ───────────────────────────────────────────
const WS_URL  = `ws://${location.host}/ws`;
const API_URL = `${location.origin}/api`;

let ws, wsTimer;
let allTokens      = [];
let openPositions  = [];
let closedPositions= [];
let pnlStats        = { totalPnlSol: 0, winRate: 0, totalTrades: 0 };
let selectedAddr    = null;
let currentTab      = "positions";
let currentSort     = "finalScore";
let sortAsc         = false;
let nextScanSecs    = 0;
let countdownTimer;

const TIER_ICON = { S: "S", A: "A", B: "B", C: "C", REJECT: "✗" };

// ─── XSS guard ──────────────────────────────────────────────────────────────
// Token symbol/name/dexId come straight from on-chain metadata via
// DexScreener — fully attacker-controlled (anyone can mint a token with any
// name). Every such value MUST go through esc() before landing in innerHTML.
// Never interpolate untrusted strings into inline event handler attributes
// (onclick="...('${x}')") even after escaping — HTML-entity decoding of an
// attribute value happens before the browser treats it as JS source, so
// escaping a quote does not prevent a breakout there. Pass only
// system-generated identifiers (address, position id) through inline
// handlers, and look up anything else from state by that identifier.
function esc(str) {
  return String(str ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

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
      updateStats(data.lastScan);
      loadAlerts(data.alerts || []);
      refreshTgStatus(data.alertsLastHour);
      startCountdown();
      // Start on positions tab — load positions and show positionsView
      loadPositions();
      document.getElementById("positionsView").style.display = "flex";
      document.getElementById("tableWrap").style.display     = "none";
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
  const isMoonshot = t.moonshot?.isMoonshotCandidate ?? !!t.moonshot_flag;

  const scoreColor = score >= 75 ? "var(--lime)" : score >= 55 ? "var(--yellow)" : "var(--blue)";
  const riskColor  = risk  >= 60 ? "var(--red)"  : risk  >= 35 ? "var(--yellow)" : "var(--lime)";
  const sel        = selectedAddr === t.address ? "selected" : "";
  const jupHtml    = jup === null ? `<span style="color:var(--dim)">—</span>`
                    : jup ? `<span style="color:var(--lime)">✓</span>`
                          : `<span style="color:var(--red)">✗</span>`;
  const moonshotBadge = isMoonshot
    ? `<span title="Moonshot candidate — up to ${t.moonshot?.suggestedTpMultiplier ?? "?"}x suggested TP" style="margin-left:4px">🚀</span>`
    : "";
  const pumpBadge = t.moonshot?.pumpAlreadyDetected
    ? `<span title="Pump already detected: ${t.moonshot.cumulativeMultipleFromFirstSeen?.toFixed(1)}x since first seen" style="margin-left:2px">⚡</span>`
    : "";

  return `<tr class="${sel}" onclick="selectToken('${t.address}'); fillQuickBuy('${t.address}')" style="cursor:pointer">
    <td><span class="tier-badge tier-${tier}">${TIER_ICON[tier] ?? tier}</span></td>
    <td>
      <div class="sym-cell">
        <div class="sym-avatar">${esc(sym.slice(0,3))}</div>
        <div>
          <div class="sym-name">$${esc(sym)} ${renderSourceBadges(t.sources || (t.source ? [t.source] : []))}${moonshotBadge}${pumpBadge}</div>
          <div class="sym-dex">${esc(t.dexId || t.dex_id || "—")}</div>
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
  const moonshot = t.moonshot || null;

  const checkNames = { age:"Age", liquidity:"Liquidity", volume:"Volume", volatility:"Volatility", fdvRatio:"FDV/Liq", holderConc:"Top 10", honeypot:"Sell Sim", mintAuth:"Mint Auth" };
  const checkHtml = Object.entries(checkNames).map(([k, lbl]) => {
    const c = checks[k] || {};
    return `<div class="check-row">
      <span>${c.passed ? "✅" : "❌"}</span>
      <span class="check-lbl">${lbl}</span>
      <span class="check-val">${c.value || "—"}</span>
    </div>`;
  }).join("");

  const compNames = {
    volumeVelocity: "Vol Velocity",
    priceMomentum:  "Price Mom",
    holderGrowth:   "Holder Dist",
    liquidityDepth: "Liq Depth",
    txActivity:     "TX Activity",
    ageWindow:      "Age Window",
    buySellPressure:"Buy Pressure",
    liquidityGrowth:"Liq Growth",
    crossSourceBonus:"Multi-Source",
  };
  const compHtml = Object.entries(compNames).map(([k, lbl]) => {
    const v = comps[k] || 0;
    return `<div class="comp-row">
      <div class="comp-lbl">${lbl}</div>
      <div class="comp-bar"><div class="comp-fill" style="width:${v}%"></div></div>
      <div class="comp-val">${v}</div>
    </div>`;
  }).join("");

  const moonshotBlock = moonshot?.isMoonshotCandidate
    ? `<div style="font-size:11px;color:var(--lime);line-height:1.6;margin:4px 0">
        🚀 Moonshot candidate (${moonshot.score}/100) — suggested ceiling <b>${moonshot.suggestedTpMultiplier}x</b>,
        SL -${moonshot.suggestedSlPct}%
        ${moonshot.pumpAlreadyDetected ? `<br>⚡ Pump already detected: <b>${moonshot.cumulativeMultipleFromFirstSeen?.toFixed(1)}x</b> since first seen` : ""}
      </div>`
    : (moonshot?.pumpAlreadyDetected
        ? `<div style="font-size:11px;color:var(--yellow);line-height:1.6;margin:4px 0">
             ⚡ Pump already detected: <b>${moonshot.cumulativeMultipleFromFirstSeen?.toFixed(1)}x</b> since first seen
           </div>`
        : "");

  document.getElementById("detailInner").innerHTML = `
    <div class="detail-col">
      <div>
        <div class="detail-title">
          <span class="tier-badge tier-${tier}" style="margin-right:6px">${TIER_ICON[tier] ?? tier}</span>
          $${esc(sym)} — Score ${score}/100 · Age ${age != null ? fmtAge(age) : "?"}
        </div>
        ${moonshotBlock}
        ${ev.length ? `<div style="font-size:10px;color:var(--dim);line-height:1.7">${ev.map(esc).join(" · ")}</div>` : ""}
        <div class="address-box">
          <div class="address-text" title="${esc(addr)}">${esc(addr)}</div>
          <button class="copy-btn" onclick="copyAddr('${addr}')">Copy</button>
        </div>
        <a class="detail-link" href="${esc(url)}" target="_blank">📊 View on DexScreener ↗</a>
      </div>

      <div class="trade-form">
        <div class="detail-title" style="margin-top:4px">Paper Trade</div>
        <div class="trade-row">
          <input class="trade-input" id="tradeAmount" type="number" step="0.01" placeholder="SOL amount" value="0.1"/>
          <input class="trade-input" id="tradeSl" type="number" step="1" placeholder="SL % (opt)" value="${moonshot?.suggestedSlPct ?? ""}"/>
          <input class="trade-input" id="tradeTp" type="number" step="1" placeholder="TP % (opt)" value="${moonshot?.suggestedTpPct ?? ""}"/>
        </div>
        <div class="trade-row">
          <input class="trade-input" id="tradeTrail" type="number" step="1" placeholder="Trailing stop % (opt, adaptive)"/>
        </div>
        <button class="buy-btn" onclick="paperBuy('${addr}')">
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
let pnlPollTimer = null;
let unrealizedPnl = 0;
let walletBalance = 0;
let autoTradeCfg = { enabled: false, solPerTrade: 0.5, maxPositions: 5, minTier: "A", minScore: 60 };

async function loadPositions() {
  try {
    const r = await fetch(`${API_URL}/positions`);
    if (!r.ok) return false;
    const d = await r.json();
    openPositions   = d.open   || [];
    closedPositions = d.closed || [];
    pnlStats        = d.stats  || pnlStats;
    walletBalance   = d.walletBalance ?? 0;
    autoTradeCfg    = d.autoTrade || autoTradeCfg;
    renderPortfolioHeader();
    renderOpenPositions();
    renderJournal();
    schedulePnlPoll();
    return true;
  } catch { return false; }
}

function tx(id) { const e = document.getElementById(id); return e || { textContent: "", style: {} }; }
function renderPortfolioHeader() {
  const s  = pnlStats;
  const rz = s.realizedPnlSol ?? s.totalPnlSol ?? 0;
  const rzColor = rz >= 0 ? "var(--lime)" : "var(--red)";
  const rzSign  = rz >= 0 ? "+" : "";

  tx("portRealized").textContent = `${rzSign}${rz.toFixed(4)} SOL`;
  tx("portRealized").style.color = rzColor;
  tx("portWinRate").textContent  = `${(s.winRate ?? 0).toFixed(1)}% win rate`;
  tx("portAtRisk").textContent   = `${(s.solAtRisk ?? 0).toFixed(3)} SOL`;
  tx("portOpenCount").textContent= `${openPositions.length} open positions`;
  tx("portTrades").textContent   = s.totalTrades ?? 0;
  tx("portBest").textContent     = s.bestTradePct  != null ? `best +${s.bestTradePct.toFixed(1)}%`  : "best —";
  tx("portWorst").textContent    = s.worstTradePct != null ? `worst ${s.worstTradePct.toFixed(1)}%` : "worst —";

  // wallet balance + auto-trade
  const wb = walletBalance ?? 0;
  tx("portWallet").textContent = `${wb.toFixed(4)} SOL`;
  tx("portWallet").style.color = wb > 0 ? "var(--lime)" : "var(--red)";
  const at = autoTradeCfg;
  tx("portAutoTrade").textContent = at.enabled
    ? `auto: ${at.solPerTrade}SOL × ${at.maxPositions}max (≥${at.minTier}, ≥${at.minScore})`
    : "auto-trade: off";
  const btn = document.getElementById("autoTradeBtn");
  if (btn) {
    btn.textContent = at.enabled ? "ON" : "OFF";
    btn.style.borderColor = at.enabled ? "var(--lime)" : "var(--red)";
    btn.style.color = at.enabled ? "var(--lime)" : "var(--red)";
  }

  // unrealized from poll
  const urColor = unrealizedPnl >= 0 ? "var(--lime)" : "var(--red)";
  const urSign  = unrealizedPnl >= 0 ? "+" : "";
  tx("portUnrealized").textContent = unrealizedPnl !== 0 ? `${urSign}${unrealizedPnl.toFixed(4)} SOL` : "— SOL";
  tx("portUnrealized").style.color = unrealizedPnl !== 0 ? urColor : "var(--text)";
}

function renderOpenPositions() {
  const grid = el("openPositionsGrid");
  el("openCount").textContent = openPositions.length;

  if (openPositions.length === 0) {
    grid.innerHTML = `<div style="color:var(--dim);font-size:11px;padding:12px;grid-column:1/-1">No open positions — buy from Alerts tab or use Quick Buy above.</div>`;
    return;
  }

  grid.innerHTML = openPositions.map(p => {
    const slTxt = p.sl_pct  ? `-${p.sl_pct}%`  : "—";
    const tpTxt = p.tp_pct  ? `+${p.tp_pct}%`  : "—";
    const holdMin = Math.floor((Date.now() - new Date(p.opened_at).getTime()) / 60000);
    const holdTxt = holdMin < 60 ? `${holdMin}m` : `${(holdMin/60).toFixed(1)}h`;
    return `
    <div class="pos-card" id="poscard-${p.id}">
      <div class="pos-card-head">
        <span class="pos-card-sym">$${esc(p.symbol)}</span>
        <span class="pos-card-pnl" id="pnl-${p.id}" style="color:var(--dim)">loading…</span>
      </div>
      <div class="pos-card-grid">
        <div><div class="pos-card-lbl">Entry</div><div class="pos-card-val">$${fmtPrice(p.entry_price)}</div></div>
        <div><div class="pos-card-lbl">Size</div><div class="pos-card-val">${p.amount_sol} SOL</div></div>
        <div><div class="pos-card-lbl">SL / TP</div><div class="pos-card-val">${slTxt} / ${tpTxt}</div></div>
        <div><div class="pos-card-lbl">Hold</div><div class="pos-card-val">${holdTxt}</div></div>
        ${p.trailing_stop_pct ? `<div><div class="pos-card-lbl">Trail</div><div class="pos-card-val">${p.trailing_stop_pct}% off peak ($${fmtPrice(p.peak_price)})</div></div>` : ""}
        ${p.notes ? `<div style="grid-column:1/-1"><div class="pos-card-lbl">Note</div><div class="pos-card-val" style="color:var(--dim);font-size:10px">${esc(p.notes)}</div></div>` : ""}
      </div>
      <div class="pos-card-actions">
        <button class="pos-btn half"   onclick="paperSell('${p.id}',0.25)">Sell 25%</button>
        <button class="pos-btn half"   onclick="paperSell('${p.id}',0.5)">Sell 50%</button>
        <button class="pos-btn danger" onclick="paperSell('${p.id}',1)">Close 100%</button>
      </div>
    </div>`;
  }).join("");
}

function renderJournal() {
  const tbody = el("journalTbody");
  el("journalCount").textContent = closedPositions.length;

  if (closedPositions.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="color:var(--dim);text-align:center;padding:20px">No closed trades yet</td></tr>`;
    return;
  }

  tbody.innerHTML = closedPositions.map(p => {
    const pct     = p.pnl_pct ?? 0;
    const sol     = p.pnl_sol ?? 0;
    const color   = pct >= 0 ? "var(--lime)" : "var(--red)";
    const sign    = pct >= 0 ? "+" : "";
    const holdMs  = new Date(p.closed_at).getTime() - new Date(p.opened_at).getTime();
    const holdMin = Math.floor(holdMs / 60000);
    const holdTxt = holdMin < 60 ? `${holdMin}m` : holdMin < 1440 ? `${(holdMin/60).toFixed(1)}h` : `${(holdMin/1440).toFixed(1)}d`;
    const reasonClass = `reason-${p.reason.replace(/ /g,"-")}`;
    return `<tr>
      <td style="font-weight:700">$${esc(p.symbol)}</td>
      <td style="font-family:monospace">$${fmtPrice(p.entry_price)}</td>
      <td style="font-family:monospace">$${fmtPrice(p.exit_price)}</td>
      <td>${p.amount_sol} SOL</td>
      <td style="color:${color};font-weight:700">${sign}${pct.toFixed(2)}%</td>
      <td style="color:${color};font-weight:700">${sign}${sol.toFixed(4)}</td>
      <td style="color:var(--dim)">${holdTxt}</td>
      <td><span class="reason-badge ${reasonClass}">${p.reason}</span></td>
      <td style="color:var(--dim)">${fmtTime(p.closed_at)}</td>
    </tr>`;
  }).join("");
}

// Live unrealized P&L — polls all open positions concurrently every 30s
async function schedulePnlPoll() {
  clearTimeout(pnlPollTimer);
  if (openPositions.length === 0) { unrealizedPnl = 0; renderPortfolioHeader(); return; }
  try {
    const results = await Promise.allSettled(
      openPositions.map(p => fetch(`${API_URL}/positions/${p.id}/pnl`).then(r => r.json()))
    );
    unrealizedPnl = 0;
    results.forEach((r, i) => {
      if (r.status !== "fulfilled") return;
      const d = r.value;
      unrealizedPnl += d.pnlSol ?? 0;
      // Update individual card P&L display
      const pnlEl = document.getElementById(`pnl-${openPositions[i]?.id}`);
      const card  = document.getElementById(`poscard-${openPositions[i]?.id}`);
      if (pnlEl) {
        if (d.stale) {
          pnlEl.textContent = "stale";
          pnlEl.style.color = "var(--dim)";
        } else if (d.pnlPct != null) {
          const color = d.pnlPct >= 0 ? "var(--lime)" : "var(--red)";
          const sign  = d.pnlPct >= 0 ? "+" : "";
          pnlEl.textContent = `${sign}${d.pnlPct.toFixed(2)}% / ${sign}${d.pnlSol.toFixed(4)} SOL`;
          pnlEl.style.color = color;
          if (card) { card.classList.toggle("profit", d.pnlPct >= 0); card.classList.toggle("loss", d.pnlPct < 0); }
        }
      }
    });
    renderPortfolioHeader();
  } catch {}
  pnlPollTimer = setTimeout(schedulePnlPoll, 30000);
}

// Quick Buy from bar
async function quickBuy() {
  const address = el("qbAddr").value.trim();
  const amountSol = parseFloat(el("qbSol").value);
  const slPct     = parseFloat(el("qbSl").value);
  const tpPct     = parseFloat(el("qbTp").value);
  const status    = el("qbStatus");

  if (!address) { status.textContent = "⚠ Enter token address"; status.style.color = "var(--yellow)"; return; }
  if (!amountSol || amountSol <= 0) { status.textContent = "⚠ Enter SOL amount"; status.style.color = "var(--yellow)"; return; }

  status.textContent = "⏳ Opening…"; status.style.color = "var(--dim)";
  try {
    const r = await fetch(`${API_URL}/positions/buy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, amountSol, slPct: isNaN(slPct) ? undefined : slPct, tpPct: isNaN(tpPct) ? undefined : tpPct }),
    });
    const d = await r.json();
    if (!r.ok) { status.textContent = `❌ ${d.error || "Failed"}`; status.style.color = "var(--red)"; return; }
    status.textContent = `✅ $${d.position.symbol} opened @ $${fmtPrice(d.position.entry_price)}`;
    status.style.color = "var(--lime)";
    el("qbAddr").value = "";
    await loadPositions();
    // Switch to positions tab
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".tab")[0].classList.add("active");
    switchTab("positions", document.querySelectorAll(".tab")[0]);
  } catch { status.textContent = "❌ Backend unreachable"; status.style.color = "var(--red)"; }
}

// Quick-fill address from token row click
function fillQuickBuy(address) {
  const t = allTokens.find(x => x.address === address);
  el("qbAddr").value = address;
  el("qbStatus").textContent = `$${t?.symbol || "?"} selected`;
  el("qbStatus").style.color = "var(--blue)";
}

async function paperBuy(address) {
  // Reads the detail panel's own Paper Trade form (tradeAmount/tradeSl/
  // tradeTp/tradeTrail) — previously this silently read the unrelated
  // Quick Buy bar fields instead, so whatever the user typed here was
  // ignored. Falls back to the moonshot-adaptive suggestion when a field
  // is left blank rather than a fixed default.
  const t = allTokens.find(x => x.address === address);
  const moonshot = t?.moonshot;

  const amountSol = parseFloat(el("tradeAmount")?.value || "0.1");
  const slRaw     = el("tradeSl")?.value;
  const tpRaw     = el("tradeTp")?.value;
  const trailRaw  = el("tradeTrail")?.value;

  const slPct    = slRaw    !== "" && slRaw    !== undefined ? parseFloat(slRaw)    : (moonshot?.suggestedSlPct ?? undefined);
  const tpPct    = tpRaw    !== "" && tpRaw    !== undefined ? parseFloat(tpRaw)    : (moonshot?.suggestedTpPct ?? undefined);
  const trailPct = trailRaw !== "" && trailRaw !== undefined ? parseFloat(trailRaw) : undefined;

  if (!amountSol || amountSol <= 0) return toast("❌ Enter a valid SOL amount", true);
  try {
    const r = await fetch(`${API_URL}/positions/buy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address, amountSol,
        slPct: isNaN(slPct) ? undefined : slPct,
        tpPct: isNaN(tpPct) ? undefined : tpPct,
        trailingStopPct: trailPct === undefined || isNaN(trailPct) ? undefined : trailPct,
      }),
    });
    const d = await r.json();
    if (!r.ok) return toast(`❌ ${d.error || "Failed to open position"}`, true);
    toast(`✅ Opened $${d.position.symbol} — ${amountSol} SOL @ $${fmtPrice(d.position.entry_price)}`);
    await loadPositions();
  } catch { toast("❌ Backend unreachable", true); }
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
    toast(`${pnlEmoji} Sold $${c.symbol} (${(fraction*100).toFixed(0)}%): ${c.pnl_pct != null ? (c.pnl_pct >= 0 ? "+" : "") + c.pnl_pct.toFixed(2) + "%" : "—"}`);
    await loadPositions();
  } catch { toast("❌ Backend unreachable", true); }
}

function el(id) { return document.getElementById(id); }

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
    <div class="alert-sym">🚀 $${esc(symbol)}</div>
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
  // Update portfolio header scan duration
  const dur = s.durationMs != null ? `last scan ${(s.durationMs/1000).toFixed(1)}s` : "last scan —s";
  const scanDurEl = document.getElementById("scanDuration");
  if (scanDurEl) scanDurEl.textContent = dur;
}

function refreshTgStatus(alertsH) {
  document.getElementById("tgSub").textContent = `Alerts this hour: ${alertsH ?? 0}`;
  // Also update portfolio header alerts/hr
  const el = document.getElementById("alertsHour");
  if (el) el.textContent = alertsH ?? "—";
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

function switchTab(tab, tabEl) {
  currentTab = tab;
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  tabEl.classList.add("active");
  selectedAddr = null;
  document.getElementById("detailPanel").classList.remove("open");

  const tableWrap     = document.getElementById("tableWrap");
  const positionsView = document.getElementById("positionsView");

  if (tab === "positions") {
    tableWrap.style.display     = "none";
    positionsView.style.display = "flex";
    loadPositions();
  } else {
    tableWrap.style.display     = "block";
    positionsView.style.display = "none";
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

// ─── Graceful shutdown ─────────────────────────────────────────────────────────
async function shutdownServer() {
  if (!confirm("Stop the server?")) return;
  try {
    await fetch(`${API_URL}/shutdown`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  } catch {}
}

// ─── Auto-trade toggle ───────────────────────────────────────────────────────────
async function toggleAutoTrade() {
  try {
    const r = await fetch(`${API_URL}/auto-trade/toggle`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const d = await r.json();
    autoTradeCfg.enabled = d.enabled;
    renderPortfolioHeader();
  } catch {}
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
// Poll loadPositions until it succeeds (server may still be warming up)
let _bootRetries = 0;
(function bootLoad() {
  loadPositions().then(ok => {
    if (!ok && _bootRetries++ < 10) setTimeout(bootLoad, 2000);
  });
})();

connectWS();
