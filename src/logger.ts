// Log estruturado (JSON) com pino. A escrita fica com o transporte `pino/file`, que roda numa
// worker thread: a thread principal só serializa o objeto e segue atendendo requisições.
import pino, { type DestinationStream, type Logger } from "pino";

export type { Logger };

/** Campos que nunca devem aparecer no log, mesmo que alguém passe o objeto inteiro. */
const REDACT = ["access_token", "*.access_token", "token", "*.token", "*.authorization", "headers.authorization"];

/**
 * Logger da aplicação. `LOG_LEVEL` define o nível (padrão "info"). Sem `destination`, escreve
 * no stdout pela worker thread; os testes passam um destino em memória para ler as linhas.
 */
export function createLogger(
  level: string = process.env.LOG_LEVEL ?? "info",
  destination?: DestinationStream,
): Logger {
  return pino(
    { level, redact: { paths: REDACT, censor: "[removido]" } },
    destination ?? pino.transport({ target: "pino/file", options: { destination: 1 } }),
  );
}

/** Logger que não escreve nada nem abre worker. É o padrão do createApp, usado nos testes. */
export const silentLogger: Logger = pino({ level: "silent" });

/**
 * No SIGINT/SIGTERM, fecha o que precisar (`close`), esvazia o transporte e só então sai,
 * para não perder as últimas linhas que ainda estão na fila da worker thread.
 */
export function flushOnShutdown(logger: Logger, close?: () => void): void {
  const stop = (signal: NodeJS.Signals) => {
    logger.info({ signal }, "encerrando");
    close?.();
    exitAfterFlush(logger, 0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

/** Sai do processo depois de esvaziar o transporte (com um teto, caso a worker não responda). */
export function exitAfterFlush(logger: Logger, code: number): void {
  const timer = setTimeout(() => process.exit(code), 2_000);
  timer.unref();
  logger.flush(() => process.exit(code));
}
