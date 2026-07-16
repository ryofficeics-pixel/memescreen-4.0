import type BetterSqlite3 from "better-sqlite3";
import type { Position, ClosedPosition, PositionRow, ClosedPositionRow } from "../domain/types.js";
import { evaluateTrigger } from "../domain/triggers.js";
import { randomUUID } from "node:crypto";

export class PositionsRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS positions (
        id          TEXT PRIMARY KEY,
        address     TEXT NOT NULL,
        symbol      TEXT NOT NULL,
        entry_price REAL NOT NULL,
        amount_sol  REAL NOT NULL,
        sl_pct      REAL,
        tp_pct      REAL,
        trailing_stop_pct REAL,
        peak_price  REAL,
        notes       TEXT,
        opened_at   TEXT DEFAULT (datetime('now')),
        status      TEXT DEFAULT 'open'
      );

      CREATE TABLE IF NOT EXISTS closed_positions (
        id           TEXT PRIMARY KEY,
        position_id  TEXT NOT NULL,
        address      TEXT NOT NULL,
        symbol       TEXT NOT NULL,
        entry_price  REAL NOT NULL,
        exit_price   REAL,
        amount_sol   REAL NOT NULL,
        pnl_pct      REAL,
        pnl_sol      REAL,
        reason       TEXT DEFAULT 'manual',
        notes        TEXT,
        opened_at    TEXT,
        closed_at    TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_positions_address    ON positions(address);
      CREATE INDEX IF NOT EXISTS idx_closed_positions_addr ON closed_positions(address);
      CREATE INDEX IF NOT EXISTS idx_closed_positions_at   ON closed_positions(closed_at DESC);
    `);

    // 4.0 migration: add notes column if upgrading from 3.1
    const posCols = (this.db.prepare("PRAGMA table_info(positions)").all() as { name: string }[]).map(r => r.name);
    if (!posCols.includes("notes")) {
      this.db.exec(`ALTER TABLE positions ADD COLUMN notes TEXT`);
    }
    // Adaptive take-profit migration: trailing stop + peak price tracking
    if (!posCols.includes("trailing_stop_pct")) {
      this.db.exec(`ALTER TABLE positions ADD COLUMN trailing_stop_pct REAL`);
    }
    if (!posCols.includes("peak_price")) {
      this.db.exec(`ALTER TABLE positions ADD COLUMN peak_price REAL`);
      // Backfill existing open positions so peak tracking starts from entry
      this.db.exec(`UPDATE positions SET peak_price = entry_price WHERE peak_price IS NULL`);
    }
    const closedCols = (this.db.prepare("PRAGMA table_info(closed_positions)").all() as { name: string }[]).map(r => r.name);
    if (!closedCols.includes("notes")) {
      this.db.exec(`ALTER TABLE closed_positions ADD COLUMN notes TEXT`);
    }

    // Backfill null SL/TP for positions opened without them
    const nullSl = this.db.prepare(
      `SELECT COUNT(*) AS cnt FROM positions WHERE sl_pct IS NULL AND status = 'open'`
    ).get() as { cnt: number };
    if (nullSl.cnt > 0) {
      this.db.exec(`UPDATE positions SET sl_pct = 25 WHERE sl_pct IS NULL AND status = 'open'`);
      console.log(`[DB] Backfilled SL=25% for ${nullSl.cnt} open position(s)`);
    }
    const nullTp = this.db.prepare(
      `SELECT COUNT(*) AS cnt FROM positions WHERE tp_pct IS NULL AND status = 'open'`
    ).get() as { cnt: number };
    if (nullTp.cnt > 0) {
      console.log(`[DB] ${nullTp.cnt} open position(s) have no TP set (will use hard ceiling or manual close)`);
    }
  }

  // ── Open positions ────────────────────────────────────────────────────────
  openPosition(p: Omit<Position, "id" | "openedAt" | "status"> & { notes?: string }): PositionRow {
    // Reject duplicate: already an open position for this address
    const existing = this.db.prepare(
      `SELECT id FROM positions WHERE address = ? AND status = 'open' LIMIT 1`
    ).get(p.address);
    if (existing) {
      throw new Error(`Position already open for ${p.symbol} (${p.address})`);
    }
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO positions (id, address, symbol, entry_price, amount_sol, sl_pct, tp_pct, trailing_stop_pct, peak_price, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, p.address, p.symbol, p.entryPrice, p.amountSol,
      p.slPct ?? null, p.tpPct ?? null, p.trailingStopPct ?? null,
      p.entryPrice, // peak starts at entry
      p.notes ?? null
    );
    return this.getPosition(id)!;
  }

  getPosition(id: string): PositionRow | undefined {
    return this.db.prepare(
      `SELECT * FROM positions WHERE id = ? AND status = 'open'`
    ).get(id) as PositionRow | undefined;
  }

  listOpenPositions(): PositionRow[] {
    return this.db.prepare(
      `SELECT * FROM positions WHERE status = 'open' ORDER BY opened_at DESC`
    ).all() as PositionRow[];
  }

  // ── Close (full or partial) ───────────────────────────────────────────────
  closePosition(
    id: string,
    fraction: number,
    exitPrice: number,
    reason: ClosedPosition["reason"]
  ): ClosedPositionRow | null {
    const pos = this.getPosition(id);
    if (!pos) return null;

    fraction = Math.max(0.01, Math.min(1, fraction));
    const closedAmount = pos.amount_sol * fraction;
    const pnlPct = pos.entry_price > 0
      ? ((exitPrice - pos.entry_price) / pos.entry_price) * 100
      : null;
    const pnlSol = pnlPct !== null ? closedAmount * (pnlPct / 100) : null;
    const closedId = randomUUID();

    this.db.prepare(`
      INSERT INTO closed_positions
        (id, position_id, address, symbol, entry_price, exit_price, amount_sol, pnl_pct, pnl_sol, reason, notes, opened_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      closedId, id, pos.address, pos.symbol,
      pos.entry_price, exitPrice, closedAmount,
      pnlPct, pnlSol, reason, pos.notes ?? null, pos.opened_at
    );

    if (fraction >= 0.999) {
      this.db.prepare(`UPDATE positions SET status = 'closed' WHERE id = ?`).run(id);
    } else {
      this.db.prepare(
        `UPDATE positions SET amount_sol = amount_sol - ? WHERE id = ?`
      ).run(closedAmount, id);
    }

    return this.db.prepare(
      `SELECT * FROM closed_positions WHERE id = ?`
    ).get(closedId) as ClosedPositionRow;
  }

  // ── SL/TP/trailing trigger check ────────────────────────────────────────
  // Adaptive take-profit: a fixed tp_pct sells a token the moment it hits
  // one target, which is exactly wrong for a meme coin that can keep running
  // 10-100x past that point. If trailing_stop_pct is set, this instead
  // tracks the peak price the position has reached and only closes once
  // price retraces trailing_stop_pct off that peak — riding the move
  // instead of capping it, while still locking in gains once it actually
  // reverses. tp_pct (if also set) remains a hard ceiling. The actual
  // decision logic lives in domain/triggers.ts (pure, unit-tested); this
  // method only handles reading/persisting state and closing positions.
  checkTriggers(currentPrices: Map<string, number>): ClosedPositionRow[] {
    const positions = this.listOpenPositions();
    const closed: ClosedPositionRow[] = [];

    for (const pos of positions) {
      const price = currentPrices.get(pos.address);
      if (price === undefined) continue;

      const { reason, newPeak } = evaluateTrigger(
        {
          entryPrice:      pos.entry_price,
          slPct:           pos.sl_pct,
          tpPct:           pos.tp_pct,
          trailingStopPct: pos.trailing_stop_pct,
          peakPrice:       pos.peak_price ?? pos.entry_price,
        },
        price
      );

      if (newPeak !== pos.peak_price) {
        this.db.prepare(`UPDATE positions SET peak_price = ? WHERE id = ?`).run(newPeak, pos.id);
      }

      if (reason) {
        const result = this.closePosition(pos.id, 1, price, reason);
        if (result) closed.push(result);
      }
    }

    return closed;
  }

  // ── Stats ─────────────────────────────────────────────────────────────────
  listClosedPositions(limit = 50): ClosedPositionRow[] {
    return this.db.prepare(
      `SELECT * FROM closed_positions ORDER BY closed_at DESC LIMIT ?`
    ).all(limit) as ClosedPositionRow[];
  }

  getPnlStats(): {
    totalPnlSol:    number;
    realizedPnlSol: number;
    winRate:        number;
    totalTrades:    number;
    bestTradePct:   number | null;
    worstTradePct:  number | null;
    avgHoldMinutes: number | null;
    solAtRisk:      number;
  } {
    const closed = this.db.prepare(
      `SELECT pnl_sol, pnl_pct, opened_at, closed_at FROM closed_positions WHERE pnl_sol IS NOT NULL`
    ).all() as { pnl_sol: number; pnl_pct: number; opened_at: string; closed_at: string }[];

    const open = this.listOpenPositions();
    const solAtRisk = open.reduce((s, p) => s + p.amount_sol, 0);

    const realizedPnlSol = closed.reduce((s, r) => s + r.pnl_sol, 0);
    const wins           = closed.filter(r => r.pnl_pct >= 0).length;
    const winRate        = closed.length > 0 ? (wins / closed.length) * 100 : 0;
    const bestTradePct   = closed.length > 0 ? Math.max(...closed.map(r => r.pnl_pct)) : null;
    const worstTradePct  = closed.length > 0 ? Math.min(...closed.map(r => r.pnl_pct)) : null;

    const holdTimes = closed
      .map(r => {
        const o = new Date(r.opened_at).getTime();
        const c = new Date(r.closed_at).getTime();
        return isNaN(o) || isNaN(c) ? null : (c - o) / 60000;
      })
      .filter((v): v is number => v !== null);
    const avgHoldMinutes = holdTimes.length > 0
      ? holdTimes.reduce((s, v) => s + v, 0) / holdTimes.length
      : null;

    return {
      totalPnlSol:    realizedPnlSol,
      realizedPnlSol,
      winRate,
      totalTrades:    closed.length,
      bestTradePct,
      worstTradePct,
      avgHoldMinutes,
      solAtRisk,
    };
  }
}
