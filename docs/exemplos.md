# Exemplos de request e response

Saídas copiadas de uma execução local, com o provedor simulado na porta 3112 e a API na 3102:

```bash
PROVIDER_PORT=3112 npm run provider
PORT=3102 PROVIDER_BASE_URL=http://localhost:3112 SYNC_MAX_RETRY_AFTER_MS=10000 npm start
```

IDs encurtados com `...`. Os números de views mudam conforme a hora em que você roda, porque o simulado mede de hora em hora.

## Conexão

O `external_account_id` é normalizado (sem `@`, minúsculo, sem espaços nas pontas) e o token nunca volta na resposta.

```bash
curl -X POST localhost:3102/connections -H 'content-type: application/json' \
  -d '{"creator_id":"criadora-1","platform":"instagram","external_account_id":"@Ana.Cria","access_token":"token-fake"}'
```

```json
{"connection":{"id":"ac64a167-...","creator_id":"criadora-1","platform":"instagram","external_account_id":"ana.cria","rate_limited_until":null,"created_at":"2026-10-10T04:16:49.713Z"}}
```

A mesma conta de novo, escrita como `ana.cria`, responde `409`:

```json
{"error":{"code":"connection_exists","message":"essa conta já está conectada"},"connection":{"id":"ac64a167-...","external_account_id":"ana.cria","...":"..."}}
```

## Sync e janelas sobrepostas

Janela de 01/09 a 05/09 (`201`): 16 posts em 2 páginas, um repetido entre as páginas.

```bash
curl -X POST localhost:3102/connections/ac64a167-.../sync -H 'content-type: application/json' \
  -d '{"since":"2026-09-01T00:00:00Z","until":"2026-09-05T00:00:00Z"}'
```

```json
{"sync_run":{"id":"78506a02-...","connection_id":"ac64a167-...","window_since":"2026-09-01T00:00:00.000Z","window_until":"2026-09-05T00:00:00.000Z","status":"succeeded","started_at":"2026-10-10T04:16:49.775Z","finished_at":"2026-10-10T04:16:49.801Z","attempts":2,"pages":2,"items_received":17,"items_out_of_window":0,"snapshots_inserted":16,"snapshots_duplicated":1,"error_code":null,"error_message":null,"retry_at":null}}
```

Janela de 03/09 a 09/09: dos 24 itens, 10 já existiam (8 da janela anterior e 2 repetidos entre páginas).

```json
{"sync_run":{"id":"068b984e-...","status":"succeeded","attempts":3,"pages":3,"items_received":24,"items_out_of_window":0,"snapshots_inserted":14,"snapshots_duplicated":10,"...":"..."}}
```

Totais da conexão. O simulado devolvia, no mesmo momento, `{"views":650234,"likes":41063,"comments":4092}` para 30 posts em `/__admin/accounts/instagram/ana.cria/expected`:

```bash
curl localhost:3102/connections/ac64a167-.../metrics
```

```json
{"connection_id":"ac64a167-...","platform":"instagram","totals":{"posts":30,"views":650234,"likes":41063,"comments":4092},"last_fetched_at":"2026-10-10T04:16:49.818Z"}
```

## Posts, histórico e criador

`GET /connections/:id/posts?limit=1`:

```json
{"posts":[{"external_post_id":"instagram-ana.cria-p030","published_at":"2026-09-08T06:00:00.000Z","caption":"Post 30 de ana.cria","metrics":{"views":27344,"likes":1367,"comments":136},"captured_at":"2026-10-10T04:00:00.000Z","fetched_at":"2026-10-10T04:16:49.815Z","last_fetched_at":"2026-10-10T04:16:49.815Z","snapshots":1}],"limit":1,"offset":0}
```

`GET /connections/:id/posts/instagram-ana.cria-p030/snapshots`:

```json
{"external_post_id":"instagram-ana.cria-p030","snapshots":[{"captured_at":"2026-10-10T04:00:00.000Z","fetched_at":"2026-10-10T04:16:49.815Z","views":27344,"likes":1367,"comments":136,"sync_run_id":"068b984e-..."}],"limit":100,"offset":0}
```

`GET /creators/criadora-1/metrics`:

```json
{"creator_id":"criadora-1","totals":{"posts":30,"views":650234,"likes":41063,"comments":4092},"by_platform":[{"platform":"instagram","posts":30,"views":650234,"likes":41063,"comments":4092,"last_fetched_at":"2026-10-10T04:16:52.910Z"}],"last_fetched_at":"2026-10-10T04:16:52.910Z"}
```

## 429 e Retry-After

Programei no simulado um 429 com `Retry-After: 2` seguido de um 503:

```bash
curl -X POST localhost:3112/__admin/faults -H 'content-type: application/json' \
  -d '{"platform":"instagram","account":"ana.cria","faults":[{"type":"status","status":429,"retry_after":"2"},{"type":"status","status":503}]}'
```

O sync seguinte terminou bem. `GET /sync-runs/d5573c7a-...` mostra cada chamada e quanto o serviço esperou depois dela: 2000 ms pelo `Retry-After` e 1000 ms de backoff (segunda tentativa, base de 500 ms).

```json
{"sync_run":{"id":"d5573c7a-...","status":"succeeded","started_at":"2026-10-10T04:16:49.895Z","finished_at":"2026-10-10T04:16:52.912Z","attempts":3,"...":"..."},
 "attempts":[
  {"page":1,"attempt":1,"outcome":"rate_limited","http_status":429,"detail":"429 com Retry-After=2","wait_ms":2000,"at":"2026-10-10T04:16:49.897Z"},
  {"page":1,"attempt":2,"outcome":"transient","http_status":503,"detail":"provedor respondeu 503","wait_ms":1000,"at":"2026-10-10T04:16:51.905Z"},
  {"page":1,"attempt":3,"outcome":"ok","http_status":200,"detail":null,"wait_ms":0,"at":"2026-10-10T04:16:52.909Z"}]}
```

`Retry-After: 120`, acima do teto de 10 s. O sync não espera:

```
HTTP/1.1 503 Service Unavailable
retry-after: 120
{"error":{"code":"provider_rate_limited","message":"provedor pediu 120000ms de espera, acima do teto de 10000ms"},"retry_at":"2026-10-10T04:18:53.032Z","sync_run":{"id":"6aedfee3-...","status":"rate_limited","attempts":1,"pages":0,"error_code":"provider_rate_limited","retry_at":"2026-10-10T04:18:53.032Z","...":"..."}}
```

Logo em seguida, outro sync nem chama o provedor:

```
HTTP/1.1 503 Service Unavailable
retry-after: 120
{"error":{"code":"provider_rate_limited","message":"provedor pediu para aguardar até 2026-10-10T04:18:53.032Z; nenhuma chamada foi feita"},"retry_at":"2026-10-10T04:18:53.032Z"}
```

## Entradas recusadas

| Entrada | Status | Corpo |
|---|---|---|
| `since` = `2026-02-30T00:00:00Z` | 400 | `{"error":{"code":"validation_error","message":"since deve ser uma data ISO 8601 válida com fuso (ex.: 2026-09-01T00:00:00Z)","details":[{"path":"since","message":"since deve ser uma data ISO 8601 válida com fuso (ex.: 2026-09-01T00:00:00Z)"}]}}` |
| conexão com `creator_id` "ana maria", `platform` "orkut", sem conta, token "   " | 400 | `{"error":{"code":"validation_error","message":"creator_id aceita só letras, números, ponto, hífen e sublinhado","details":[{"path":"creator_id",...},{"path":"platform","message":"platform deve ser um de: instagram, tiktok, youtube, x"},{"path":"external_account_id","message":"external_account_id é obrigatório"},{"path":"access_token","message":"access_token não pode ser vazio"}]}}` |
| corpo sem `content-type` | 415 | `{"error":{"code":"unsupported_media_type","message":"envie o corpo como JSON com content-type: application/json"}}` |
| `{oops` | 400 | `{"error":{"code":"validation_error","message":"corpo não é um JSON válido"}}` |
| corpo de 20 KB | 413 | `{"error":{"code":"payload_too_large","message":"corpo maior que 16 KB"}}` |
| `?limit=500` | 400 | `{"error":{"code":"validation_error","message":"limit deve ser um inteiro entre 1 e 200","details":[{"path":"limit",...}]}}` |
| `DELETE /connections/:id` | 404 | `{"error":{"code":"not_found","message":"rota não encontrada"}}` |

Variável de ambiente inválida impede a subida:

```
$ SYNC_MAX_ATTEMPTS=abc npm start
configuração inválida: SYNC_MAX_ATTEMPTS: deve ser um número
```
