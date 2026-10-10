export interface Clock {
  now(): Date;
}

/** Espera assíncrona injetável. Em produção é um setTimeout; nos testes avança o relógio manual. */
export type Sleep = (ms: number) => Promise<void>;

export const systemClock: Clock = { now: () => new Date() };

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Relógio controlado para testes. `sleep` não dorme: registra o pedido e avança o relógio. */
export class ManualClock implements Clock {
  readonly sleeps: number[] = [];
  private current: number;

  constructor(start: Date | string) {
    this.current = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current += ms;
  }

  set(at: Date | string): void {
    this.current = new Date(at).getTime();
  }

  sleep: Sleep = async (ms) => {
    this.sleeps.push(ms);
    this.advance(ms);
  };
}
