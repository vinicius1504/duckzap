import type { Fail } from "../contacts/result";
import { ApiError } from "../contacts/http";

// Cola HTTP do módulo: reaproveita a de Clientes (sessão → tenant → permissão → validação) e acrescenta os códigos
// de erro do inbox. O código do erro vai igual para o front (`api.ts` o reconhece pelo nome).
export {
  ApiError,
  idParam,
  isGuid,
  jsonLimit,
  moduleErrorHandler,
  parseWith,
  permit,
  readJson,
  requestCtx,
  tenantGuard,
  type ModuleContext,
} from "../contacts/http";

const STATUS: Record<string, 400 | 403 | 404 | 409 | 422 | 429 | 502> = {
  not_found: 404,
  resolved: 409,
  conflict: 409,
  duplicate: 409,
  not_failed: 409,
  channel_down: 409,
  no_channel: 409,
  in_service: 409,
  no_follow_up: 409,
  sending_paused: 403,
  plan_feature: 403,
  rate_limited: 429,
  send_failed: 502,
};

export function toApiError(result: Fail, extra: Record<string, unknown> = {}) {
  return new ApiError(STATUS[result.error] ?? 422, result.error, result.message, extra);
}

export function unwrap<T>(result: { ok: true; data: T } | Fail): T {
  if (result.ok) return result.data;
  throw toApiError(result);
}
