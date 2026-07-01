import type { Repository } from "../db/repository.js";
import type { TelegramService } from "./telegramService.js";
import type { ScreenedTokenV40 } from "./screenerService.js";

export class AlertService {
  constructor(
    private readonly repo: Repository,
    private readonly tg: TelegramService
  ) {}

  async handleScreenedToken(token: ScreenedTokenV40): Promise<void> {
    if (token.decision !== "alert") return;

    // Save alert to DB first to get the ID (needed for Telegram inline buttons)
    const alertId = this.repo.saveAlert(token, false);

    // Send to Telegram
    const sent = await this.tg.sendAlert(token, alertId);

    // Mark as sent if successful
    if (sent) {
      this.repo.markTelegramSent(alertId);
    }

    console.log(`[ALERT] 🚀 $${token.symbol} tier=${token.tier} score=${token.finalScore} alert_id=${alertId} tg_sent=${sent}`);
  }
}

