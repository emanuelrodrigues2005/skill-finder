/**
 * `request_id` da busca: sempre cunhado pelo servidor (decisão C4).
 *
 * O header `X-Request-ID` recebido é opaco: ele serve ao rastreio do cliente e
 * **não** vira chave do histórico. Se virasse, qualquer cliente escolheria o id
 * do permalink — e leria (ou sobrescreveria) a busca de outro cliente.
 *
 * O formato é o mesmo do middleware de request (`req_` + ULID), e é por isso que
 * este módulo reusa `newRequestId()` em vez de inventar outro gerador.
 */
import type { Response } from 'express';

import {
  newRequestId,
  REQUEST_ID_HEADER,
  type RequestWithRequestId,
} from '../common/request-id.middleware';

/** Cunha o `request_id` que a resposta e a linha do histórico vão compartilhar. */
export function mintSearchRequestId(): string {
  return newRequestId();
}

/**
 * `request_id` das rotas de leitura: o do middleware (o header ecoado ou um novo).
 *
 * É o valor que as rotas de catálogo devolvem no corpo — o mesmo do header de
 * resposta, para cliente e servidor citarem o mesmo id.
 */
export function requestIdOf(request: RequestWithRequestId): string {
  return request.requestId ?? mintSearchRequestId();
}

/**
 * Reescreve o header `X-Request-ID` com o id cunhado.
 *
 * O middleware já escreveu ali o header **recebido** (ou um id novo, quando ele
 * não veio). Numa resposta de busca o corpo é a fonte da verdade, então corpo e
 * header precisam dizer a mesma coisa — um cliente que só olha o header não pode
 * ver um id que não existe no histórico.
 */
export function stampSearchRequestId(response: Response, requestId: string): void {
  response.setHeader(REQUEST_ID_HEADER, requestId);
}
