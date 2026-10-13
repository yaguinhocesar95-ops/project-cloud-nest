<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Keep Supremo performance calculations in `src/lib/supremo-ranking.ts` and render them through the shared `SupremoRanking` component so both live pages stay consistent.
- Load numeric fonts locally and apply them through the shared mono token and numeric utilities, so values stay consistent and legible across pages without changing text typography.
- Bet rules (create/advance/merge) live in `src/lib/bet-engine.ts` and the Supremo cycle in `src/lib/supremo-cycle.ts`, so the browser hook and the server cron share one implementation.
- Signed-in users mirror the localStorage keys listed in `src/lib/cloud-keys.ts` to the `user_kv` table via `CloudSync`; bet lists merge by id with tombstones, so browser and server writes never clobber each other.
- The per-minute cron calls `/api/public/cron/supremo`, authenticated by a token stored in `cron_config` (service-role only), and runs Supremo with an in-memory localStorage shim, so lib code stays storage-agnostic.
- Every Binance fetch goes through a timeout+AbortSignal helper and each Supremo cycle runs under an AbortController that the timeout aborts (aborted cycles write nothing), and locks expire, so a hung request never stops or overlaps the automatic runs.
- The app never wipes browser storage on load; any data migration must be per-key, backed up and opt-in, because user bets and settings live there.
- The server picks its Binance host at the start of each cloud run from `SERVER_HOSTS` in `src/lib/binance.ts` (first one that answers), because Binance blocks some hosts from cloud IPs; the cloud writes a heartbeat key and the browser takes over every minute when that heartbeat is stale, never using the audit log as the liveness signal (browser cycles also write to it).
- Per-coin Supremo target/stop lives in `src/lib/supremo-combo-profiles.ts`; scoring attaches the resolved combo to each row and bet creation reads it from the row, so score, plan and saved bet never diverge.
- Automatic Supremo generation has one scheduler (cloud cron, with the main page's useSupremoAuto as stale-cloud fallback); /supremo only triggers manual runs through useSupremoAuto, so no second timer or rule path exists.
- Automatic Supremo bets use `supremoBetId` (user + minute + symbol + combo) on both browser and server, and `placeBet` returns a confirmed accept/block result, so merges dedupe cycles and success feedback is never shown for a rejected bet.
