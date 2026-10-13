import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { LIVE_BLOCK_LABEL } from "@/lib/supremo";
import type { Bankroll } from "@/hooks/useBankroll";
import type { Bet, PlaceResult } from "@/hooks/useBets";
import { readActiveCombo } from "@/lib/supremo-combo";
import { comboLabel } from "@/lib/target-stop-lab";
import { appendAudit, exposureBlock, newId, readExposure } from "@/lib/supremo-live";
import type { ScoredRow } from "@/hooks/supremoScoring";
import type { RegimeReading } from "@/lib/market-regime";
import { betOptsFromRow, runSupremoCycle } from "@/lib/supremo-cycle";
import { supremoBetId } from "@/lib/bet-engine";
import { CLOUD_BEAT_KEY, readAutoOn } from "@/lib/cloud-keys";
import { classifyError, classifyResult, isFailure, type CyclePhase, type CycleStatus } from "@/lib/cycle-status";

export { protectionBlocks } from "@/lib/supremo-cycle";

type PlaceBet = (b: any) => Promise<PlaceResult> | void;

export const SUPREMO_INTERVAL_MS = 60_000;

/** Trava global: só UMA geração Supremo roda por vez na aba. */
let inFlight = false;
let inFlightSince = 0;
/** Geração da execução atual: uma Promise antiga (que estourou o tempo) não altera estado nem libera a trava da nova. */
let runToken = 0;
/** Controlador do ciclo em curso: timeout ou ciclo novo abortam o trabalho real. */
let runAbort: AbortController | null = null;
/** Tempo máximo de um ciclo; passou disso, a trava é liberada e o próximo ciclo roda. */
export const CYCLE_TIMEOUT_MS = 55_000;
export function __resetSupremoLock() {
  inFlight = false;
  inFlightSince = 0;
  runToken++;
  runAbort?.abort();
  runAbort = null;
}
/** Se a nuvem não dá sinal de vida há este tempo, o navegador assume a geração a cada minuto. */
export const SERVER_STALE_MS = 2.5 * 60_000;
/**
 * Último sinal de vida da nuvem (gravado só pelo servidor). Não usa a auditoria,
 * porque os ciclos do próprio navegador também entram nela e mascaravam a falha.
 */
export function lastCloudBeat(): number {
  try {
    const v = Number(JSON.parse(localStorage.getItem(CLOUD_BEAT_KEY) ?? "0"));
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}
export function isCloudStale(now: number, beat: number = lastCloudBeat()): boolean {
  return now - beat > SERVER_STALE_MS;
}
/** Roda `work` com um sinal que é abortado no timeout: o trabalho para de verdade, não só a espera. Exportado para teste. */
export async function withAbortTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, ctl = new AbortController()): Promise<T> {
  const t = setTimeout(() => ctl.abort(new Error("ciclo demorou demais; tentando de novo no próximo minuto")), ms);
  try {
    return await Promise.race([
      work(ctl.signal),
      new Promise<never>((_, reject) => {
        if (ctl.signal.aborted) reject(ctl.signal.reason);
        ctl.signal.addEventListener("abort", () => reject(ctl.signal.reason), { once: true });
      }),
    ]);
  } finally {
    clearTimeout(t);
  }
}

/** Agenda um único intervalo; devolve a função de cancelamento. Exportado para teste. */
export function startSupremoTimer(
  onTick: (now: number) => void,
  onDue: () => void,
  intervalMs = SUPREMO_INTERVAL_MS,
  clock: () => number = Date.now,
) {
  let next = clock() + intervalMs;
  const id = setInterval(() => {
    const n = clock();
    onTick(n);
    if (n >= next) {
      next = n + intervalMs;
      onDue();
    }
  }, 1000);
  return { next: () => next, stop: () => clearInterval(id) };
}

/**
 * Geração automática de apostas Supremo (a cada 1 min).
 * `serverRuns`: a rodada acontece no servidor; aqui só atualizamos o painel.
 */
export function useSupremoAuto(opts: {
  enabled: boolean;
  serverRuns?: boolean;
  /** Usuário com login: entra na chave canônica do ciclo (igual à da nuvem). */
  userId?: string | null;
  placeBet: PlaceBet;
  bets: Bet[];
  bankroll: Bankroll;
  usdtBrl: number | null;
  livePrices?: Map<string, number> | undefined;
}) {
  const [cloudDown, setCloudDown] = useState(false);
  const [nextAt, setNextAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [reason, setReason] = useState<string | null>(null);
  const [scored, setScored] = useState<ScoredRow[]>([]);
  const [scannedAt, setScannedAt] = useState<number | null>(null);
  const [nextPick, setNextPick] = useState<string | null>(null);
  const [regime, setRegime] = useState<RegimeReading | null>(null);
  const regimeRef = useRef<RegimeReading | null>(null);
  const [status, setStatus] = useState<CycleStatus | null>(null);
  const mark = (phase: CyclePhase, detail: string | null = null, data?: { dataOk: number; dataTotal: number }) =>
    setStatus((prev) => {
      const at = Date.now();
      const ok = !isFailure(phase) && phase !== "rodando" && phase !== "ignorada-trava" && phase !== "cancelada";
      return { phase, at, detail, ...data, lastSuccessAt: ok ? at : (prev?.lastSuccessAt ?? null) };
    });
  const ctx = useRef(opts);
  ctx.current = opts;

  /** `cycleT` presente = ciclo automático: id canônico (usuário+minuto+moeda+combo), igual ao da nuvem. */
  const placeRow = async (row: ScoredRow, quote: string, cycleT?: number): Promise<PlaceResult> => {
    const b = betOptsFromRow(row, quote, ctx.current.bankroll, ctx.current.usdtBrl, regimeRef.current?.regime);
    if (!b) return { ok: false, reason: "sem preço ou plano para a moeda" };
    const id = cycleT != null ? supremoBetId(ctx.current.userId ?? "local", cycleT, b.symbol, b.combo) : undefined;
    const res = await ctx.current.placeBet({
      ...b,
      id,
      guard: (current: Bet[]) => exposureBlock(current, b.symbol, b.combo, readExposure(), Date.now()),
    });
    return res ?? { ok: false, reason: "registro sem confirmação" };
  };

  const betOn = (symbol: string) => {
    const row = scored.find((r) => r.symbol === symbol);
    if (!row) return;
    if (!(ctx.current.bankroll.stake > 0)) return void toast.error("Informe o valor por aposta em “Sua banca”.");
    if (row.blocks.length > 0) return void toast.error(`${symbol} está bloqueada: ${row.blocks.map((b) => LIVE_BLOCK_LABEL[b]).join(", ")}.`);
    const combo = row.combo ?? readActiveCombo();
    const exp = exposureBlock(ctx.current.bets, symbol, comboLabel(combo.targetPct, combo.stopPct, combo.mode), readExposure(), Date.now());
    if (exp) return void toast.error(`Aposta não registrada: ${exp}.`);
    appendAudit({ id: newId(), at: Date.now(), chosen: symbol, note: "Manual: Apostar nesta", coins: [] });
    void placeRow(row, row.quote).then((res) =>
      res.ok ? toast.success(`Aposta Supremo registrada em ${symbol}.`) : toast.error(`Aposta não registrada: ${res.reason}.`),
    );
  };

  /** `auto`: chamado pelo agendador (id canônico); manual usa id próprio. */
  const generate = async (place = true, auto = false) => {
    const { bankroll, livePrices, bets, usdtBrl } = ctx.current;
    if (place && !(bankroll.stake > 0)) {
      if (!auto) toast.error("Informe o valor por aposta em “Sua banca”.");
      return;
    }
    if (place && auto && !readAutoOn()) return;
    if (inFlight && Date.now() - inFlightSince < CYCLE_TIMEOUT_MS + 5_000) {
      if (place) mark("ignorada-trava");
      return;
    }
    const token = ++runToken;
    runAbort?.abort();
    const ctl = new AbortController();
    runAbort = ctl;
    inFlight = true;
    inFlightSince = Date.now();
    const current = () => token === runToken;
    mark("rodando");
    try {
      const r = await withAbortTimeout((signal) => runSupremoCycle({ bets, bankroll, usdtBrl, livePrices, place, signal }), CYCLE_TIMEOUT_MS, ctl);
      if (!current()) return;
      regimeRef.current = r.regime;
      setRegime(r.regime);
      setScored(r.scored);
      setScannedAt(Date.now());
      setNextPick(r.nextPick);
      const data = { dataOk: r.dataOk, dataTotal: r.dataTotal };
      const phase = classifyResult({ place, ...data, note: r.note, chosen: !!r.chosenRow });
      if (!place) return void mark(phase, null, data);
      if (r.note) {
        mark(phase, r.note, data);
        return void setReason(r.note);
      }
      if (r.chosenRow) {
        const row = r.chosenRow;
        const res = await placeRow(row, r.bet?.quote ?? "USDT", auto ? r.t : undefined);
        if (!current()) return;
        if (res.ok) {
          mark("aposta-aceita", row.symbol, data);
          setReason(null);
          toast.success(`Aposta Supremo registrada em ${row.symbol} (${row.stars ?? "—"} estrelinha(s), índice ${row.analysis.index}).`);
        } else {
          mark("aposta-bloqueada", `${row.symbol}: ${res.reason}`, data);
          setReason(`Aposta não registrada: ${res.reason}.`);
          if (!auto) toast.error(`Aposta não registrada: ${res.reason}.`);
        }
      }
    } catch (e) {
      if (current()) {
        mark(classifyError(e), (e as Error).message);
        const msg = (e as Error).message;
        const kind = /demorou demais/.test(msg) ? "tempo esgotado" : /fetch|network|Failed/i.test(msg) ? "rede indisponível" : "erro";
        setReason(`Falha ao gerar (${kind}): ${msg}`);
      }
    } finally {
      // Só a execução atual libera a trava; uma antiga que terminou atrasada não mexe nela.
      if (current()) {
        inFlight = false;
        inFlightSince = 0;
      }
    }
  };
  const genRef = useRef(generate);
  genRef.current = generate;

  useEffect(() => {
    void genRef.current(false);
  }, []);

  useEffect(() => {
    if (!opts.enabled) {
      setNextAt(null);
      return;
    }
    if (opts.serverRuns) {
      // O servidor roda a cada minuto cheio; aqui só contamos e atualizamos o painel.
      const nextMinute = () => Math.ceil((Date.now() + 1) / 60_000) * 60_000;
      let due = nextMinute();
      setNextAt(due);
      const id = setInterval(() => {
        const n = Date.now();
        setNow(n);
        if (n >= due + 5_000) {
          due = nextMinute();
          // Rede de segurança: se a nuvem parou de dar sinal de vida, o navegador gera a aposta todo minuto.
          const stale = isCloudStale(n);
          setCloudDown(stale);
          void genRef.current(stale, true);
        }
        setNextAt(due);
      }, 1000);
      return () => {
        clearInterval(id);
        setCloudDown(false);
      };
    }
    const timer = startSupremoTimer(
      (n) => {
        setNow(n);
        setNextAt(timer.next());
      },
      () => void genRef.current(true, true),
    );
    setNextAt(timer.next());
    return () => timer.stop();
  }, [opts.enabled, opts.serverRuns]);

  const countdown =
    nextAt == null
      ? null
      : (() => {
          const s = Math.max(0, Math.ceil((nextAt - now) / 1000));
          return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
        })();

  return {
    countdown,
    reason,
    scored,
    scannedAt,
    nextPick,
    betOn,
    refresh: () => void genRef.current(false),
    generateNow: () => void genRef.current(),
    labels: LIVE_BLOCK_LABEL,
    regime,
    /** Estado explícito da última rodada neste navegador (rodou, dados, sinal, aceita/bloqueada, falha). */
    status,
    now,
    cloudBeat: typeof localStorage === "undefined" ? 0 : lastCloudBeat(),
    /** A nuvem não está rodando: as apostas só continuam com a página aberta. */
    cloudDown,
  };
}
