import type BetterSqlite3 from "better-sqlite3";
import type { Position, ClosedPosition, PositionRow, ClosedPositionRow } from "../domain/types.js";
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
        opened_at    TEXT,
        closed_at    TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_positions_address    ON positions(address);
      CREATE INDEX IF NOT EXISTS idx_closed_positions_addr ON closed_positions(address);
      CREATE INDEX IF NOT EXISTS idx_closed_positions_at   ON closed_positions(closed_at DESC);
    `);
  }

  // ── Open positions ────────────────────────────────────────────────────────
  openPosition(p: Omit<Position, "id" | "status" | "openedAt">): PositionRow {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO positions (id, address, symbol, entry_price, amount_sol, sl_pct, tp_pct)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, p.address, p.symbol, p.entryPrice, p.amountSol, p.slPct ?? null, p.tpPct ?? null);
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

    // Record closed slice
    this.db.prepare(`
      INSERT INTO closed_positions
        (id, position_id, address, symbol, entry_price, exit_price, amount_sol, pnl_pct, pnl_sol, reason, opened_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      closedId, id, pos.address, pos.symbol,
      pos.entry_price, exitPrice, closedAmount,
      pnlPct, pnlSol, reason, pos.opened_at
    );

    if (fraction >= 0.999) {
      // Full close
      this.db.prepare(`UPDATE positions SET status = 'closed' WHERE id = ?`).run(id);
    } else {
      // Partial close — reduce remaining amount
      this.db.prepare(
        `UPDATE positions SET amount_sol = amount_sol - ? WHERE id = ?`
      ).run(closedAmount, id);
    }

    return this.db.prepare(
      `SELECT * FROM closed_positions WHERE id = ?`
    ).get(closedId) as ClosedPositionRow;
  }

  // ── SL/TP trigger check ───────────────────────────────────────────────────
  checkTriggers(currentPrices: Map<string, number>): ClosedPositionRow[] {
    const positions = this.listOpenPositions();
    const closed: ClosedPositionRow[] = [];

    for (const pos of positions) {
      const price = currentPrices.get(pos.address);
      if (price === undefined || pos.entry_price <= 0) continue;

      const pnlPct = ((price - pos.entry_price) / pos.entry_price) * 100;

      if (pos.sl_pct !== null && pnlPct <= -Math.abs(pos.sl_pct)) {
        const result = this.closePosition(pos.id, 1, price, "stop-loss");
        if (result) closed.push(result);
      } else if (pos.tp_pct !== null && pnlPct >= Math.abs(pos.tp_pct)) {
        const result = this.closePosition(pos.id, 1, price, "take-profit");
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

  getPnlStats(): { totalPnlSol: number; winRate: number; totalTrades: number } {
    const rows = this.db.prepare(
      `SELECT pnl_sol, pnl_pct FROM closed_positions WHERE pnl_sol IS NOT NULL`
    ).all() as { pnl_sol: number; pnl_pct: number }[];

    const totalPnlSol  = rows.reduce((s, r) => s + r.pnl_sol, 0);
    const wins         = rows.filter(r => r.pnl_pct >= 0).length;
    const winRate      = rows.length > 0 ? (wins / rows.length) * 100 : 0;

    return { totalPnlSol, winRate, totalTrades: rows.length };
  }
}
