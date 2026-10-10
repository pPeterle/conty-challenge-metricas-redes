// O redact do logger tem que apagar os segredos antes de a linha sair do processo. Aqui o
// destino é um array em memória no lugar da worker thread, e o teste lê o JSON que o pino escreveu.
import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/logger.ts";

const SEGREDO = "valor-que-nao-pode-vazar";

function logEmMemoria() {
  const linhas: string[] = [];
  const logger = createLogger("info", {
    write: (linha: string) => {
      linhas.push(linha);
    },
  });
  const lidas = () => linhas.map((linha) => JSON.parse(linha) as Record<string, any>);
  return { logger, linhas, lidas };
}

describe("redact do logger", () => {
  it("apaga authorization nos headers e em objetos de primeiro nível, sem mexer no resto", () => {
    const { logger, linhas, lidas } = logEmMemoria();
    logger.info(
      {
        headers: { authorization: `Bearer ${SEGREDO}`, "content-type": "application/json" },
        req: { authorization: `Basic ${SEGREDO}`, method: "POST" },
      },
      "requisição",
    );

    const [linha] = lidas();
    expect(linha.msg).toBe("requisição");
    expect(linha.headers.authorization).toBe("[removido]");
    expect(linha.headers["content-type"]).toBe("application/json");
    expect(linha.req.authorization).toBe("[removido]");
    expect(linha.req.method).toBe("POST");
    expect(linhas.join("")).not.toContain(SEGREDO);
  });

  it("mantém o redact em logger filho", () => {
    const { logger, linhas, lidas } = logEmMemoria();
    logger.child({ servico: "teste" }).warn({ headers: { authorization: SEGREDO } }, "filho");

    const [linha] = lidas();
    expect(linha.servico).toBe("teste");
    expect(linha.headers.authorization).toBe("[removido]");
    expect(linhas.join("")).not.toContain(SEGREDO);
  });

  it("apaga access_token e token no topo e um nível abaixo", () => {
    const { logger, linhas, lidas } = logEmMemoria();
    logger.info({ access_token: SEGREDO, token: SEGREDO, conexao: { id: "c1", access_token: SEGREDO, token: SEGREDO } }, "conexão");

    const [linha] = lidas();
    expect(linha.access_token).toBe("[removido]");
    expect(linha.token).toBe("[removido]");
    expect(linha.conexao).toEqual({ id: "c1", access_token: "[removido]", token: "[removido]" });
    expect(linhas.join("")).not.toContain(SEGREDO);
  });
});
