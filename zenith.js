// Cliente server-side da Zenith Payments API (sem dependências).
// As credenciais vêm só de variáveis de ambiente no backend; nunca vão para o browser nem para logs.
// Docs: https://docs.zenithworld.com.br/payments-api

import crypto from 'node:crypto';

export const ZENITH_BASE = 'https://api.zenithworld.com.br';

/** Erro da Zenith com o estado HTTP e o código devolvido (sem dados sensíveis). */
export class ZenithError extends Error {
  /**
   * @param {string} message
   * @param {{ http?: number, code?: string, details?: unknown, incerto?: boolean }} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'ZenithError';
    this.http = info.http;
    this.code = info.code;
    this.details = info.details;
    // incerto = timeout, rede ou 5xx: o checkout pode ter sido criado. Repetir só com a MESMA Idempotency-Key.
    this.incerto = !!info.incerto;
  }
}

/**
 * @param {{ publicKey: string, secretKey: string, fetch?: typeof fetch, baseUrl?: string, timeoutMs?: number }} cfg
 */
export function criarZenith(cfg) {
  const fazerFetch = cfg.fetch || globalThis.fetch;
  const base = (cfg.baseUrl || ZENITH_BASE).replace(/\/$/, '');
  const timeoutMs = cfg.timeoutMs || 20000;

  async function pedido(method, caminho, { body, idempotencyKey } = {}) {
    if (!cfg.publicKey || !cfg.secretKey) throw new ZenithError('Credenciais Zenith em falta', { code: 'ZENITH_SEM_CREDENCIAIS' });
    const headers = { 'X-API-Key': cfg.publicKey, 'X-API-Secret': cfg.secretKey, Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let r;
    try {
      r = await fazerFetch(base + caminho, {
        method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      throw new ZenithError(timeout ? 'Tempo esgotado a contactar a Zenith' : 'Sem ligação à Zenith', { code: timeout ? 'TIMEOUT' : 'REDE', incerto: true });
    }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new ZenithError(d.message || d.error || `Zenith respondeu ${r.status}`, {
        http: r.status, code: d.code || d.error?.code, details: d.missingFields || d.details, incerto: r.status >= 500,
      });
    }
    return d;
  }

  return {
    /** Métodos liberados para esta conta, país, moeda e ambiente (consultar em runtime). */
    metodos: ({ country, currency, environment }) =>
      pedido('GET', `/integrations/payment-methods?${new URLSearchParams({ country, currency, environment })}`),

    /**
     * Cria o checkout. Em retry use a MESMA idempotencyKey e o MESMO payload.
     * @param {Record<string, unknown>} payload
     * @param {string} idempotencyKey 8–120 caracteres
     */
    criarCheckout: (payload, idempotencyKey) => {
      if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 120) {
        throw new ZenithError('Idempotency-Key inválida', { code: 'IDEMPOTENCY_KEY_INVALID' });
      }
      return pedido('POST', '/integrations/checkouts', { body: payload, idempotencyKey });
    },

    /** Estado atual do checkout (pending | authorized | succeeded | failed | canceled | refunded). */
    checkout: id => pedido('GET', `/integrations/checkouts/${encodeURIComponent(id)}`),

    /**
     * Sessão do Zenith Elements (cartão). Uma sessão por compra; o referenceId fica preso à sessão
     * (mesmo referenceId com outros dados → 409 ELEMENT_REFERENCE_BINDING_CONFLICT).
     * @param {Record<string, unknown>} payload deve incluir origin exata autorizada no painel Zenith
     */
    sessaoElements: payload => pedido('POST', '/elements/sessions', { body: payload }),
  };
}

/**
 * Valida a assinatura de um webhook da Zenith.
 * Assinatura = HMAC SHA-256 (hex) de `${timestamp}.${corpo bruto}` com o webhook secret; janela de 300 s.
 * @param {{ rawBody: string|Buffer, timestamp: string, signature: string, secret: string, agoraMs?: number }} p
 * @returns {{ ok: true } | { ok: false, motivo: string }}
 */
export function validarWebhook({ rawBody, timestamp, signature, secret, agoraMs = Date.now() }) {
  if (!secret) return { ok: false, motivo: 'sem_secret' };
  if (!timestamp || !signature) return { ok: false, motivo: 'sem_cabecalhos' };
  // aceita timestamp em segundos ou ms, e assinatura com ou sem prefixo "sha256="
  const tsNum = Number(timestamp);
  const tsMs = Number.isFinite(tsNum) ? (tsNum > 1e12 ? tsNum : tsNum * 1000) : Date.parse(timestamp);
  if (!Number.isFinite(tsMs) || Math.abs(agoraMs - tsMs) > 300_000) return { ok: false, motivo: 'fora_do_prazo' };
  const recebido = String(signature).replace(/^sha256=/, '').trim().toLowerCase();
  const esperado = crypto.createHmac('sha256', secret).update(String(timestamp) + '.').update(rawBody).digest('hex');
  if (recebido.length !== esperado.length) return { ok: false, motivo: 'assinatura' };
  return crypto.timingSafeEqual(Buffer.from(recebido), Buffer.from(esperado)) ? { ok: true } : { ok: false, motivo: 'assinatura' };
}

/**
 * Escolhe a origin do Elements: tem de ser exatamente uma das autorizadas (protocolo + host + porta).
 * @param {string} origemPedido origin de onde a página foi servida
 * @param {string[]} permitidas lista configurada no backend
 * @returns {string|null}
 */
export function escolherOrigin(origemPedido, permitidas) {
  let o;
  try { const u = new URL(origemPedido); o = u.origin; } catch { return null; }
  return permitidas.find(p => p === o) || null;
}

/** Normaliza a lista de origins do ambiente: só origins HTTPS (ou http://localhost) sem path. */
export function lerOrigins(valor) {
  return String(valor || '').split(',').map(v => v.trim()).filter(Boolean).filter(v => {
    if (v.includes('*')) return false; // sem curingas: a origin tem de ser exata
    try {
      const u = new URL(v);
      const local = u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
      return (u.protocol === 'https:' || local) && u.origin === v.replace(/\/$/, '');
    } catch { return false; }
  }).map(v => v.replace(/\/$/, ''));
}

/** Estado público da Zenith → estado que a página entende. */
export function mapearEstado(s) {
  switch (String(s || '').toLowerCase()) {
    case 'succeeded': case 'captured': case 'paid': return 'approved';
    case 'failed': return 'rejected';
    case 'canceled': case 'cancelled': case 'expired': return 'expired';
    case 'refunded': return 'refunded';
    default: return 'pending'; // pending, authorized, processing
  }
}

/**
 * Só deixa passar para o browser os campos públicos de cada nextAction (nada de segredos nem URLs inventadas).
 * @param {any} na
 */
export function nextActionPublica(na) {
  if (!na || typeof na !== 'object') return null;
  const str = v => (typeof v === 'string' ? v : undefined);
  const base = nextActionPorTipo(na, str);
  const i = na.instructions;
  if (i && typeof i === 'object') {
    base.instructions = { title: str(i.title), steps: Array.isArray(i.steps) ? i.steps.filter(x => typeof x === 'string').slice(0, 10) : undefined };
  }
  return base;
}

function nextActionPorTipo(na, str) {
  switch (na.type) {
    case 'blik': return { type: 'blik', clientSecret: str(na.clientSecret), publishableKey: str(na.publishableKey) };
    case 'redirect': return { type: 'redirect', url: /^https:\/\//.test(na.url || '') ? na.url : undefined, expiresAt: str(na.presentation?.expiresAt) };
    case 'qr_code': case 'voucher': return { type: na.type, code: str(na.code), reference: str(na.reference) };
    case 'bank_transfer': return { type: 'bank_transfer', details: na.details && typeof na.details === 'object' ? na.details : undefined };
    case 'app_approval': return { type: 'app_approval', app: str(na.app) };
    default: return { type: String(na.type || 'desconhecido') };
  }
}
