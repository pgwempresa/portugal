// Sua Historinha PL — servidor do funil (Express)
// Roda local (npm start) e na Vercel (export default app).
//   GET  /config            preços, pixels e métodos liberados
//   POST /criar-pagamento   cria o checkout BLIK na Zenith (+ Purchase na Meta)
//   GET  /status/:id        estado do pedido (approved | pending | expired | rejected)
//   POST /webhook/zenith    eventos assinados da Zenith
//   POST /registrar-falha   falhas detetadas na página (nunca recebe o código BLIK)
//   GET  /admin/            painel (public/admin) + /api/admin/* com sessão
// Os arquivos de /public são servidos pelo express.static localmente e pela CDN da Vercel.

import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { criarZenith, validarWebhook, mapearEstado, nextActionPublica, ZenithError } from './zenith.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;

// ─────────────────────────── Configuração ───────────────────────────
const PORT          = Number(env.PORT || 3000);
const PAIS          = 'PL';
const MOEDA         = 'PLN';
const ZENITH_ENV    = env.ZENITH_ENV === 'sandbox' ? 'sandbox' : 'production';
const ZENITH_WH_SEC = env.ZENITH_WEBHOOK_SECRET || '';
const PIXEL_ID      = '1594585312427182';        // Meta
const TIKTOK_PIXEL  = 'DC26VD3C77U8S1HK5NHG';    // TikTok
const META_TOKEN    = env.META_TOKEN || '';      // token da API de Conversões (opcional)
const ADMIN_SENHA   = env.ADMIN_SENHA || '';     // senha do /admin
// Upstash ligado pela Vercel: KV_REST_API_URL/TOKEN, com ou sem prefixo (ex.: STORAGE_KV_REST_API_URL)
const KV_PREFIXO    = Object.keys(env).find(k => k.endsWith('KV_REST_API_URL') && env[k])?.slice(0, -'KV_REST_API_URL'.length);
const REDIS_URL     = (KV_PREFIXO != null ? env[KV_PREFIXO + 'KV_REST_API_URL'] : env.UPSTASH_REDIS_REST_URL) || '';
const REDIS_TOKEN   = (KV_PREFIXO != null ? env[KV_PREFIXO + 'KV_REST_API_TOKEN'] : env.UPSTASH_REDIS_REST_TOKEN) || '';

// Credenciais só do ambiente, nunca no código nem nos logs
const zenith = criarZenith({ publicKey: env.ZENITH_PUBLIC_KEY || '', secretKey: env.ZENITH_SECRET_KEY || '', timeoutMs: 20000 });
const TEM_ZENITH = !!(env.ZENITH_PUBLIC_KEY && env.ZENITH_SECRET_KEY);

const PRODUTO = {
  nome: 'Sua Historinha',
  imagem: '/img/chatgpt-image-17-de-jun-de-2026-14-54-47.png',
};
// Preços em grosze (1 zł = 100 gr) — inteiros, sem erro de arredondamento
const GR = {
  base: 8490, discount: 4500, colorir: 1290, colorirOriginal: 2490, expressa: 790, expressaOriginal: 1690,
  extras: 1990, extrasOriginal: 3990, cartinha: 1290,
};
const zl = gr => gr / 100;
const PRECOS = {
  base: zl(GR.base), discount: zl(GR.discount), colorir: zl(GR.colorir), colorirOriginal: zl(GR.colorirOriginal),
  expressa: zl(GR.expressa), expressaOriginal: zl(GR.expressaOriginal),
};
const ORDER_BUMP = { id: 'historinhas-extras', titulo: '+2 dodatkowe, w 100% spersonalizowane bajki', preco: zl(GR.extras), precoOriginal: zl(GR.extrasOriginal) };
const ORDER_BUMP_CARTINHA = { id: 'list-mikolaja', titulo: 'List od Świętego Mikołaja', preco: zl(GR.cartinha), ativo: true };

// ─────────────────────────── Utilitários ───────────────────────────
const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || ''));
const sha256  = v => crypto.createHash('sha256').update(String(v)).digest('hex');
const log     = (...a) => console.log(new Date().toISOString(), ...a);
const comTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(r, ms))]);
const espera  = ms => new Promise(r => setTimeout(r, ms));
const corta   = (v, n = 160) => v == null ? undefined : String(v).slice(0, n);

// Nome e apelido reais (a Zenith recusa nomes de uma palavra, números ou iniciais soltas)
function normalizarNome(v) {
  const n = String(v || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  const partes = n.split(' ');
  const ok = partes.length >= 2 && partes.every(p => /^[\p{L}][\p{L}'’-]+$/u.test(p)) && n.length <= 140;
  return ok ? n : null;
}

// O total é sempre recalculado aqui (em grosze): o valor enviado pelo browser é ignorado
export function calcularTotalGr({ quizData = {}, obExtras, obCartinha, addon_colorir, addon_expressa }) {
  let t = GR.base;
  if (quizData.has_discount === 'Sim') t -= GR.discount;
  if (addon_colorir)  t += GR.colorir;
  if (addon_expressa) t += GR.expressa;
  if (obExtras)       t += GR.extras;
  if (obCartinha && ORDER_BUMP_CARTINHA.ativo) t += GR.cartinha;
  return t;
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

// ─────────────────────────── Armazenamento ───────────────────────────
// Na Vercel: Upstash Redis. Local sem Redis: arquivo data/pedidos.json.
//   pedido:<id>   JSON do pedido (id = checkout.id da Zenith)
//   intent:<id>   tentativa de pagamento: Idempotency-Key, payload e resposta (24 h)
//   evt:<id>      eventos de webhook já processados (30 dias)
//   gerados / pagos / pendentes   zsets por data
//   falhas / logs                 listas para o /admin
const store = REDIS_URL ? redisStore() : arquivoStore();

function redisStore() {
  async function cmd(...cmds) {
    const r = await fetch(REDIS_URL.replace(/\/$/, '') + '/pipeline', {
      method: 'POST', headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds), signal: AbortSignal.timeout(8000),
    });
    const d = await r.json();
    if (!Array.isArray(d)) throw new Error('Redis: ' + JSON.stringify(d).slice(0, 200));
    return d.map(x => { if (x.error) throw new Error('Redis: ' + x.error); return x.result; });
  }
  const pares = a => { const o = []; for (let i = 0; i < a.length; i += 2) o.push({ id: a[i], criado: Number(a[i + 1]) }); return o; };
  return {
    async salvar(p) {
      const agora = String(Date.now());
      await cmd(['SET', 'pedido:' + p.id, JSON.stringify(p)], ['ZADD', 'gerados', agora, p.id], ['ZADD', 'pendentes', agora, p.id]);
    },
    async get(id) { const [v] = await cmd(['GET', 'pedido:' + id]); return v ? JSON.parse(v) : null; },
    async marcarPago(id) {
      const p = await this.get(id);
      if (!p || p.status === 'pago') return null;
      Object.assign(p, { status: 'pago', pagoEm: new Date().toISOString() });
      await cmd(['SET', 'pedido:' + id, JSON.stringify(p)], ['ZADD', 'pagos', String(Date.now()), id], ['ZREM', 'pendentes', id]);
      return p;
    },
    async encerrar(id, status) { // devolve o pedido se o estado mudou
      const p = await this.get(id);
      const mudou = p && p.status !== 'pago' && p.status !== status;
      if (mudou) { p.status = status; p.encerradoEm = new Date().toISOString(); await cmd(['SET', 'pedido:' + id, JSON.stringify(p)]); }
      await cmd(['ZREM', 'pendentes', id]);
      return mudou ? p : null;
    },
    async atualizar(p) { await cmd(['SET', 'pedido:' + p.id, JSON.stringify(p)]); },
    async pendentes() { const [ids] = await cmd(['ZRANGE', 'pendentes', '0', '99', 'WITHSCORES']); return pares(ids); },
    async intent(id) { const [v] = await cmd(['GET', 'intent:' + id]); return v ? JSON.parse(v) : null; },
    async salvarIntent(id, i) { await cmd(['SET', 'intent:' + id, JSON.stringify(i), 'EX', String(86400)]); },
    async eventoVisto(id) { const [v] = await cmd(['EXISTS', 'evt:' + id]); return v === 1; },
    async marcarEvento(id) { await cmd(['SET', 'evt:' + id, '1', 'EX', String(30 * 86400)]); },
    async falha(f) { await cmd(['LPUSH', 'falhas', JSON.stringify(f)], ['LTRIM', 'falhas', '0', '999']); },
    async falhas() { const [l] = await cmd(['LRANGE', 'falhas', '0', '999']); return l.map(v => JSON.parse(v)); },
    async log(e) { await cmd(['LPUSH', 'logs', JSON.stringify(e)], ['LTRIM', 'logs', '0', '1999']); },
    async logs() { const [l] = await cmd(['LRANGE', 'logs', '0', '1999']); return l.map(v => JSON.parse(v)); },
    async listar(lista) {
      const [ids] = await cmd(['ZREVRANGE', lista, '0', '999']);
      if (!ids.length) return [];
      const [vals] = await cmd(['MGET', ...ids.map(i => 'pedido:' + i)]);
      return vals.filter(Boolean).map(v => JSON.parse(v));
    },
  };
}

function arquivoStore() {
  const FILE = env.DATA_FILE || path.join(__dirname, 'data', 'pedidos.json');
  let db = {};
  try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* primeiro arranque */ }
  for (const k of ['pedidos', 'gerados', 'pagos', 'pendentes', 'intents', 'eventos']) db[k] ||= {};
  for (const k of ['falhas', 'logs']) db[k] ||= [];
  const gravar = () => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(db, null, 1)); };
  return {
    async salvar(p) { db.pedidos[p.id] = p; db.gerados[p.id] = db.pendentes[p.id] = Date.now(); gravar(); },
    async get(id) { return db.pedidos[id] || null; },
    async marcarPago(id) {
      const p = db.pedidos[id];
      if (!p || p.status === 'pago') return null;
      Object.assign(p, { status: 'pago', pagoEm: new Date().toISOString() });
      db.pagos[id] = Date.now(); delete db.pendentes[id]; gravar();
      return p;
    },
    async encerrar(id, status) {
      const p = db.pedidos[id];
      const mudou = p && p.status !== 'pago' && p.status !== status;
      if (mudou) { p.status = status; p.encerradoEm = new Date().toISOString(); }
      delete db.pendentes[id]; gravar();
      return mudou ? p : null;
    },
    async atualizar(p) { db.pedidos[p.id] = p; gravar(); },
    async pendentes() { return Object.entries(db.pendentes).map(([id, criado]) => ({ id, criado })); },
    async intent(id) { return db.intents[id] || null; },
    async salvarIntent(id, i) { db.intents[id] = i; gravar(); },
    async eventoVisto(id) { return !!db.eventos[id]; },
    async marcarEvento(id) { db.eventos[id] = Date.now(); gravar(); },
    async falha(f) { db.falhas.unshift(f); db.falhas = db.falhas.slice(0, 1000); gravar(); },
    async falhas() { return db.falhas; },
    async log(e) { db.logs.unshift(e); db.logs = db.logs.slice(0, 2000); gravar(); },
    async logs() { return db.logs; },
    async listar(lista) { return Object.entries(db[lista]).sort((a, b) => b[1] - a[1]).map(([id]) => db.pedidos[id]).filter(Boolean); },
  };
}

// ─────────────────────────── Logs ───────────────────────────
// nivel: erro | aviso | sucesso | info
async function registrarLog(nivel, tipo, dados = {}) {
  const e = { em: new Date().toISOString(), nivel, tipo, ...dados };
  for (const k of Object.keys(e)) if (e[k] === undefined || e[k] === '') delete e[k];
  await comTimeout(store.log(e).catch(err => log('[logs] erro ao guardar', err.message)), 3000);
}
const resumoPedido = p => p ? {
  pedido: p.id, reference: p.reference, email: p.email, cliente: p.nome, total: p.total,
  crianca: p.quizData?.child_name_full,
} : {};
// Evita repetir o mesmo aviso — no máximo 1 por chave por minuto
const ultimoAviso = new Map();
function avisoUmaVez(chave) {
  const agora = Date.now();
  if ((ultimoAviso.get(chave) || 0) > agora - 60e3) return false;
  ultimoAviso.set(chave, agora);
  if (ultimoAviso.size > 5000) ultimoAviso.clear();
  return true;
}
async function registrarFalha(req, tipo, dados = {}) {
  const f = { em: new Date().toISOString(), tipo, ip: clientIp(req), ...dados };
  log('[falha]', tipo, JSON.stringify(dados));
  await Promise.all([
    comTimeout(store.falha(f).catch(e => log('[falhas] erro ao guardar', e.message)), 3000),
    registrarLog('erro', tipo, { ...dados, ip: f.ip }),
  ]);
}

// ─────────────────────────── Zenith: catálogo e estado ───────────────────────────
// Métodos liberados para a conta (PL/PLN/ambiente), consultados em runtime com cache de 10 min.
let catalogoCache = { ate: 0, dados: null };
async function catalogo() {
  if (catalogoCache.dados && catalogoCache.ate > Date.now()) return catalogoCache.dados;
  try {
    const d = await zenith.metodos({ country: PAIS, currency: MOEDA, environment: ZENITH_ENV });
    catalogoCache = { ate: Date.now() + 10 * 60e3, dados: d };
    return d;
  } catch (e) {
    if (avisoUmaVez('catalogo')) await registrarLog('aviso', 'zenith_catalogo', { http: e.http, codigo: e.code, mensagem: e.message });
    if (catalogoCache.dados) return catalogoCache.dados; // usa o último conhecido
    throw e;
  }
}
const metodosLiberados = cat => (Array.isArray(cat?.items) ? cat.items : []).map(i => i.code).filter(Boolean);

// O checkout devolvido tem de bater com o pedido guardado antes de liberar qualquer coisa
function confere(pedido, dados) {
  if (!pedido || !dados) return 'sem_dados';
  if (dados.referenceId != null && dados.referenceId !== pedido.reference) return 'referenceId';
  if (dados.amount != null && Number(dados.amount) !== pedido.amount) return 'amount';
  if (dados.currency != null && String(dados.currency).toUpperCase() !== pedido.currency) return 'currency';
  if (pedido.subMerchantId && dados.subMerchantId !== pedido.subMerchantId) return 'subMerchantId';
  return null;
}

async function registrarStatus(pedido, status, origem) {
  try {
    if (status === 'approved') {
      const p = await store.marcarPago(pedido.id);
      if (p) { log('[pago]', p.id); await registrarLog('sucesso', 'pagamento_confirmado', { ...resumoPedido(p), origem }); }
    } else if (status === 'expired' || status === 'rejected') {
      const p = await store.encerrar(pedido.id, status);
      if (p) await registrarLog('aviso', status === 'expired' ? 'pagamento_expirado' : 'pagamento_recusado', { ...resumoPedido(p), origem });
    } else if (status === 'refunded') {
      if (avisoUmaVez('estorno:' + pedido.id)) await registrarLog('aviso', 'pagamento_estornado', { ...resumoPedido(pedido), origem });
    }
  } catch (e) { log('[pedidos] erro ao atualizar', pedido.id, e.message); }
}

// Consulta autenticada GET /integrations/checkouts/:id (servidor → Zenith)
async function consultarCheckout(pedido) {
  const r = await zenith.checkout(pedido.id);
  const estadoBruto = r.payment?.status || r.checkout?.status;
  let status = mapearEstado(estadoBruto);
  if (status === 'approved') {
    const div = confere(pedido, r.checkout);
    if (div) {
      if (avisoUmaVez('div:' + pedido.id)) await registrarLog('erro', 'checkout_divergente', { ...resumoPedido(pedido), campo: div, mensagem: 'Checkout pago não confere com o pedido — não foi liberado' });
      status = 'pending';
    }
  }
  return status;
}

// Cache curto do status por pedido: vários polls seguidos geram uma só consulta
const statusCache = new Map(); // id -> { status, ate }
function cacheStatus(id, status, ms) {
  statusCache.set(id, { status, ate: Date.now() + ms });
  if (statusCache.size > 5000) for (const [k, v] of statusCache) if (v.ate < Date.now()) statusCache.delete(k);
}

// ─────────────────────────── Meta (API de Conversões) ───────────────────────────
// Pagamento gerado = compra no Facebook. Mesmo eventID do Pixel no browser → conta uma vez só.
async function metaPurchase(p, req) {
  if (!META_TOKEN) return;
  const [fn, ...resto] = p.nome.toLowerCase().split(' ');
  const user_data = {
    em: [sha256(p.email.trim().toLowerCase())],
    fn: [sha256(fn)], ln: resto.length ? [sha256(resto.join(' '))] : undefined,
    country: [sha256('pl')],
    client_ip_address: clientIp(req) || undefined,
    client_user_agent: req.get('user-agent') || undefined,
    fbp: p.fbp || undefined, fbc: p.fbc || undefined,
  };
  const body = {
    data: [{
      event_name: 'Purchase', event_time: Math.floor(Date.now() / 1000), event_id: 'purchase_' + p.id,
      action_source: 'website', event_source_url: req.get('referer') || undefined, user_data,
      custom_data: { value: p.total, currency: MOEDA, content_name: PRODUTO.nome, order_id: p.id },
    }],
  };
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${PIXEL_ID}/events?access_token=${encodeURIComponent(META_TOKEN)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) {
      const txt = (await r.text()).slice(0, 300);
      log('[meta] Purchase', r.status, txt);
      if (avisoUmaVez('meta:' + r.status)) await registrarLog('aviso', 'meta_capi', { pedido: p.id, http: r.status, mensagem: txt });
    }
  } catch (e) {
    log('[meta] erro', e.message);
    if (avisoUmaVez('meta:rede')) await registrarLog('aviso', 'meta_capi', { pedido: p.id, mensagem: 'Sem resposta da Meta: ' + e.message });
  }
}

// ─────────────────────────── App ───────────────────────────
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

// Webhook: corpo bruto para o HMAC — registado antes do express.json()
const EVENTOS_PAGO = new Set(['payment.captured', 'checkout.succeeded']);
const EVENTOS_FALHOU = { 'payment.failed': 'rejected', 'checkout.canceled': 'expired' };
const EVENTOS_ESTORNO = new Set(['payment.refunded', 'payment.chargeback']);

app.post('/webhook/zenith', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  if (!ZENITH_WH_SEC) return res.sendStatus(404); // webhook não configurado
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const v = validarWebhook({
    rawBody: raw, timestamp: req.get('x-zenith-timestamp') || '', signature: req.get('x-zenith-signature') || '', secret: ZENITH_WH_SEC,
  });
  if (!v.ok) {
    log('[webhook] recusado:', v.motivo);
    if (avisoUmaVez('webhook:' + clientIp(req))) await registrarLog('erro', 'webhook_invalido', { ip: clientIp(req), mensagem: v.motivo === 'fora_do_prazo' ? 'Timestamp fora do prazo de 5 min' : 'Assinatura não confere' });
    return res.sendStatus(401);
  }

  let ev; try { ev = JSON.parse(raw.toString('utf8')); } catch { return res.sendStatus(400); }
  const eventId = req.get('x-zenith-event-id') || ev.id;
  const tipo = req.get('x-zenith-event-type') || ev.type;
  if (!eventId) return res.sendStatus(400);

  try {
    if (await store.eventoVisto(eventId)) return res.sendStatus(200); // repetido: já processado
    const d = ev.data || {};
    const pedido = d.checkoutId ? await store.get(d.checkoutId) : null;
    if (!pedido) {
      await registrarLog('aviso', 'webhook_desconhecido', { evento: tipo, pedido: d.checkoutId, eventId });
    } else {
      const div = confere(pedido, d);
      if (div) {
        await registrarLog('erro', 'webhook_divergente', { ...resumoPedido(pedido), evento: tipo, campo: div, eventId, mensagem: 'Evento não confere com o pedido — ignorado' });
      } else {
        await registrarLog('info', 'webhook', { evento: tipo, pedido: pedido.id, status: d.status, eventId, codigo: d.failureCode, mensagem: d.failureMessage });
        let status = null;
        if (EVENTOS_PAGO.has(tipo)) status = 'approved';
        else if (EVENTOS_FALHOU[tipo]) status = EVENTOS_FALHOU[tipo];
        else if (EVENTOS_ESTORNO.has(tipo)) status = 'refunded';
        if (status) { cacheStatus(pedido.id, status, 10 * 60e3); await registrarStatus(pedido, status, 'webhook'); }
      }
    }
    await store.marcarEvento(eventId); // só depois de processado: se algo falhar acima, a Zenith reenvia
    res.sendStatus(200);
  } catch (e) {
    log('[webhook] erro ao processar', e.message);
    res.sendStatus(500);
  }
});

app.use(express.json({ limit: '200kb' }));

app.get('/config', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  let metodos = [];
  if (TEM_ZENITH) { try { metodos = metodosLiberados(await catalogo()); } catch { /* registado em catalogo() */ } }
  res.json({
    produto: PRODUTO, moeda: MOEDA, pais: PAIS,
    precos: PRECOS, orderBump: ORDER_BUMP, orderBumpCartinha: ORDER_BUMP_CARTINHA,
    pixelId: PIXEL_ID, tiktokPixelId: TIKTOK_PIXEL,
    metodos,
  });
});

const MSG = {
  email: 'Podaj poprawny adres e-mail.',
  nome: 'Podaj imię i nazwisko (np. Anna Kowalska).',
  indisponivel: 'Płatność BLIK jest chwilowo niedostępna. Spróbuj ponownie za chwilę.',
  rede: 'Nie udało się połączyć z systemem płatności. Spróbuj ponownie — nie pobierzemy opłaty dwa razy.',
  geral: 'Nie udało się utworzyć płatności. Spróbuj ponownie.',
};

app.post('/criar-pagamento', async (req, res) => {
  const b = req.body || {};
  const quizData = typeof b.quizData === 'object' && b.quizData ? b.quizData : {};
  const flags = { obExtras: !!b.obExtras, obCartinha: !!b.obCartinha, addon_colorir: !!b.addon_colorir, addon_expressa: !!b.addon_expressa };
  const amount = calcularTotalGr({ quizData, ...flags });
  const total = zl(amount);
  const email = String(b.email || '').trim().toLowerCase();
  const nome = normalizarNome(b.nome);
  const metodo = String(b.metodo || 'blik');
  const intentId = String(b.intentId || '');
  const ctx = { email: corta(email), cliente: corta(b.nome), crianca: corta(quizData.child_name_full), total };

  if (!/^[A-Za-z0-9_-]{8,80}$/.test(intentId)) return res.status(400).json({ erro: MSG.geral });
  if (!isEmail(email)) {
    await registrarFalha(req, 'email_invalido', { ...ctx, mensagem: 'E-mail inválido (servidor)' });
    return res.status(400).json({ code: 'EMAIL_INVALIDO', erro: MSG.email });
  }
  if (!nome) {
    await registrarFalha(req, 'nome_invalido', { ...ctx, mensagem: 'Nome e apelido inválidos (servidor)' });
    return res.status(400).json({ code: 'NOME_INVALIDO', erro: MSG.nome });
  }
  if (!TEM_ZENITH) {
    await registrarFalha(req, 'sem_chave', { ...ctx, mensagem: 'ZENITH_PUBLIC_KEY / ZENITH_SECRET_KEY não configuradas' });
    return res.status(503).json({ erro: MSG.indisponivel });
  }

  // 1) O método tem de estar liberado para a conta agora
  let cat;
  try { cat = await catalogo(); }
  catch (e) {
    await registrarFalha(req, 'zenith_sem_resposta', { ...ctx, http: e.http, codigo: e.code, mensagem: 'Catálogo de métodos indisponível: ' + e.message });
    return res.status(503).json({ erro: MSG.indisponivel });
  }
  const item = (cat.items || []).find(i => i.code === metodo);
  if (!item) {
    await registrarFalha(req, 'metodo_indisponivel', { ...ctx, codigo: metodo, mensagem: `Método ${metodo} não está liberado para ${PAIS}/${MOEDA}/${ZENITH_ENV}` });
    return res.status(422).json({ erro: MSG.indisponivel });
  }

  // 2) Uma Idempotency-Key por tentativa. Retry com o mesmo intentId → mesma chave e mesmo payload.
  const origem = `${req.protocol}://${req.get('host')}`;
  let intent = await store.intent(intentId).catch(() => null);
  const reference = intent?.reference || 'sh-pl-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
  const payload = {
    amount, currency: MOEDA, country: PAIS, environment: ZENITH_ENV, paymentMethod: metodo,
    referenceId: reference, customerName: nome, customerEmail: email,
    returnUrl: origem + '/?retorno=1', cancelUrl: origem + '/?cancelado=1',
    metadata: { customerName: nome, customerEmail: email },
  };
  const hash = sha256(JSON.stringify(payload));

  if (intent && intent.hash !== hash) return res.status(409).json({ code: 'INTENCAO_ALTERADA', erro: MSG.geral });
  if (intent?.resposta) return res.json(intent.resposta); // já criado: devolve o mesmo checkout
  if (!intent) {
    intent = { chave: crypto.randomUUID(), hash, reference, criadoEm: new Date().toISOString() };
    try { await store.salvarIntent(intentId, intent); }
    catch (e) { log('[intent] erro ao guardar', e.message); return res.status(503).json({ erro: MSG.geral }); }
  }

  // 3) Cria o checkout. Resultado incerto (timeout/5xx) → 1 nova tentativa com a MESMA chave.
  let r;
  for (let tentativa = 1; ; tentativa++) {
    try { r = await zenith.criarCheckout(payload, intent.chave); break; }
    catch (e) {
      if (e instanceof ZenithError && e.incerto && tentativa < 2) { await espera(800); continue; }
      if (e instanceof ZenithError && e.incerto) {
        await registrarFalha(req, 'zenith_sem_resposta', { ...ctx, reference, http: e.http, codigo: e.code, mensagem: e.message + ' — o cliente pode tentar de novo sem duplicar' });
        return res.status(502).json({ code: 'INCERTO', erro: MSG.rede });
      }
      const code = e.code;
      await registrarFalha(req, 'zenith_recusou', { ...ctx, reference, http: e.http, codigo: corta(code, 60), campo: corta(Array.isArray(e.details) ? e.details.join(',') : undefined, 120), mensagem: corta(e.message, 300) });
      if (code === 'CUSTOMER_EMAIL_INVALID') return res.status(400).json({ code: 'EMAIL_INVALIDO', erro: MSG.email });
      if (code === 'CUSTOMER_NAME_INVALID' || code === 'CUSTOMER_NAME_REQUIRED') return res.status(400).json({ code: 'NOME_INVALIDO', erro: MSG.nome });
      if (code === 'PAYMENT_METHOD_NOT_AVAILABLE' || e.http === 422) { catalogoCache.ate = 0; return res.status(422).json({ erro: MSG.indisponivel }); }
      return res.status(502).json({ erro: MSG.geral });
    }
  }

  const ck = r?.checkout || {};
  const pedido = {
    id: ck.id, reference, metodo, status: 'pendente', amount, currency: MOEDA, total,
    email, nome, subMerchantId: ck.subMerchantId || null,
    ...flags, quizData, utms: b.utms || {}, fbp: b.fbp || null, fbc: b.fbc || null,
    criadoEm: new Date().toISOString(),
  };
  const div = !ck.id ? 'id' : confere(pedido, ck);
  if (div) {
    await registrarFalha(req, 'zenith_recusou', { ...ctx, reference, campo: div, mensagem: 'Resposta do checkout não confere com o pedido' });
    return res.status(502).json({ erro: MSG.geral });
  }
  const nextAction = nextActionPublica(r.nextAction);
  const resposta = { id: ck.id, total, nextAction, metodo: { code: r.method?.code || metodo, displayName: r.method?.displayName || 'BLIK' } };

  await comTimeout(Promise.all([
    store.salvar(pedido).catch(e => log('[pedidos] ERRO ao guardar:', e.message, pedido.id)),
    store.salvarIntent(intentId, { ...intent, checkoutId: ck.id, resposta }).catch(e => log('[intent] erro', e.message)),
    metaPurchase(pedido, req),
  ]), 5000);

  log('[checkout] criado', ck.id, reference, email, total);
  const extras = [flags.addon_colorir && 'Kolorowanka', flags.addon_expressa && 'Ekspres', flags.obExtras && '+2 bajki', flags.obCartinha && 'List'].filter(Boolean).join(', ');
  await registrarLog('info', 'pagamento_gerado', { ...resumoPedido(pedido), metodo, extras, desconto: quizData.has_discount === 'Sim' ? 'Sim' : undefined, origem_utm: b.utms?.utm_source, ip: clientIp(req) });
  res.json(resposta);
});

// Falhas detetadas na própria página. Lista fechada de campos: o código BLIK nunca é aceite aqui.
const limiteFalhas = new Map(); // ip -> { n, ate }
app.post('/registrar-falha', express.text({ type: '*/*', limit: '4kb' }), async (req, res) => {
  res.sendStatus(204);
  const ip = clientIp(req), agora = Date.now();
  const l = limiteFalhas.get(ip);
  if (l && l.ate > agora && l.n >= 20) return;
  limiteFalhas.set(ip, l && l.ate > agora ? { n: l.n + 1, ate: l.ate } : { n: 1, ate: agora + 10 * 60e3 });
  if (limiteFalhas.size > 5000) limiteFalhas.clear();
  let d = {}; try { d = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); } catch { return; }
  const tipos = {
    email_invalido: 'E-mail recusado pela página', nome_invalido: 'Nome e apelido recusados pela página',
    blik_formato: 'Código BLIK com formato errado (não enviado)', blik_rejeitado: 'Código BLIK recusado ou expirado no banco',
  };
  if (!tipos[d.tipo]) return;
  await registrarFalha(req, d.tipo, {
    email: corta(d.email), cliente: corta(d.nome), total: Number(d.total) || undefined, pedido: corta(d.checkout, 100),
    codigo: corta(d.erroCodigo, 80), mensagem: tipos[d.tipo] + (d.erroMensagem ? ': ' + corta(d.erroMensagem, 200) : ''),
  });
});

app.get('/status/:id', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = req.params.id;
  if (!/^[A-Za-z0-9_-]{6,120}$/.test(id)) return res.status(404).json({ status: 'not_found' });

  const c = statusCache.get(id);
  if (c && c.ate > Date.now()) return res.json({ status: c.status });

  try {
    const pedido = await store.get(id);
    if (!pedido) return res.status(404).json({ status: 'not_found' });
    if (pedido.status === 'pago') { cacheStatus(id, 'approved', 10 * 60e3); return res.json({ status: 'approved' }); }
    const status = await consultarCheckout(pedido);
    cacheStatus(id, status, status === 'pending' ? 4000 : 10 * 60e3);
    await registrarStatus(pedido, status, 'consulta');
    res.json({ status: status === 'refunded' ? 'rejected' : status });
  } catch (e) {
    log('[zenith] erro ao consultar', id, e.message);
    if (avisoUmaVez('consulta:' + id)) await registrarLog('aviso', 'zenith_consulta', { pedido: id, http: e.http, codigo: e.code, mensagem: e.message });
    res.json({ status: 'pending' });
  }
});

// ─────────────────────────── /admin ───────────────────────────
// A página fica em public/admin/ (sem dados). Os dados vêm de /api/admin/*, que exige
// sessão: um cookie assinado com a ADMIN_SENHA (trocar a senha encerra todas as sessões).
const COOKIE = 'sh_admin';
const SESSAO_MS = 30 * 86400 * 1000;
const tokenSessao = exp => exp + '.' + crypto.createHmac('sha256', ADMIN_SENHA).update('sessao:' + exp).digest('hex');

function sessaoOk(req) {
  if (!ADMIN_SENHA) return false;
  const m = new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)').exec(req.get('cookie') || '');
  if (!m) return false;
  const exp = m[1].split('.')[0];
  if (!/^\d{13}$/.test(exp) || Number(exp) < Date.now()) return false;
  const esperado = tokenSessao(exp);
  return esperado.length === m[1].length && crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(m[1]));
}
function exigeSessao(req, res, next) {
  res.set('Cache-Control', 'no-store');
  if (!ADMIN_SENHA) return res.status(503).json({ erro: 'Defina a variável ADMIN_SENHA na Vercel para ativar o painel.' });
  if (!sessaoOk(req)) return res.status(401).json({ erro: 'Sessão expirada.' });
  next();
}

const tentativas = new Map(); // ip -> { n, ate }
app.post('/api/admin/login', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!ADMIN_SENHA) return res.status(503).json({ erro: 'Defina a variável ADMIN_SENHA na Vercel para ativar o painel.' });
  const ip = clientIp(req), agora = Date.now();
  let t = tentativas.get(ip);
  if (!t || t.ate < agora) t = { n: 0, ate: agora + 15 * 60e3 };
  if (t.n >= 10) {
    if (avisoUmaVez('bloq:' + ip)) await registrarLog('erro', 'admin_bloqueado', { ip, mensagem: '10 senhas erradas — login bloqueado por 15 min' });
    return res.status(429).json({ erro: 'Muitas tentativas. Aguarde 15 minutos.' });
  }
  const senha = String(req.body?.senha || '');
  if (!crypto.timingSafeEqual(Buffer.from(sha256(senha)), Buffer.from(sha256(ADMIN_SENHA)))) {
    t.n++; tentativas.set(ip, t);
    await registrarLog('aviso', 'admin_senha_errada', { ip, tentativa: t.n, navegador: corta(req.get('user-agent'), 120) });
    await espera(600);
    return res.status(401).json({ erro: 'Senha incorreta.' });
  }
  tentativas.delete(ip);
  await registrarLog('info', 'admin_login', { ip, navegador: corta(req.get('user-agent'), 120) });
  res.cookie(COOKIE, tokenSessao(agora + SESSAO_MS), { httpOnly: true, secure: req.secure, sameSite: 'strict', path: '/', maxAge: SESSAO_MS });
  res.sendStatus(204);
});
app.post('/api/admin/logout', (req, res) => { res.clearCookie(COOKIE, { path: '/' }); res.sendStatus(204); });
app.get('/api/admin/sessao', exigeSessao, (req, res) => res.sendStatus(204));

// Pedidos que ficaram sem resposta (cliente fechou a página): confere na Zenith
async function conferirPendentes() {
  const lista = (await store.pendentes()).filter(p => Date.now() - p.criado > 60 * 1000).slice(0, 25);
  await Promise.all(lista.map(async ({ id, criado }) => {
    try {
      const pedido = await store.get(id);
      // pedidos antigos de Portugal (LeonaPay, EUR) ficam no banco mas não são consultados na Zenith
      if (!pedido || pedido.currency !== MOEDA) return store.encerrar(id, 'expired');
      const s = await consultarCheckout(pedido);
      if (s === 'pending' && Date.now() - criado > 2 * 86400 * 1000) return store.encerrar(id, 'expired');
      await registrarStatus(pedido, s, 'admin');
    } catch (e) { log('[admin] erro ao conferir', id, e.message); }
  }));
}

app.get('/api/admin/pedidos', exigeSessao, async (req, res) => {
  if (env.VERCEL && !REDIS_URL) {
    return res.status(503).json({ erro: 'Banco de pedidos não ligado. Na Vercel: Storage → Upstash (Redis) → Connect ao projeto, e faça redeploy.' });
  }
  try {
    if (TEM_ZENITH) await comTimeout(conferirPendentes(), 8000);
    const [gerados, falhas, logs] = await Promise.all([store.listar('gerados'), store.falhas(), store.logs()]);
    const pedidos = gerados.filter(p => p.currency === MOEDA).map(({ fbp, fbc, ...p }) => p); // só PLN
    res.json({ pedidos, falhas: falhas.map(({ ip, ...f }) => f), logs, moeda: MOEDA });
  } catch (e) {
    log('[admin] erro', e.message);
    res.status(500).json({ erro: 'Erro ao carregar os pedidos: ' + e.message });
  }
});

// /admin → /admin/ (o Express trata os dois como a mesma rota, então confere a barra)
app.get('/admin', (req, res, next) => req.originalUrl.split('?')[0] === '/admin' ? res.redirect(302, '/admin/') : next());

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '1h', setHeaders(res, f) {
  if (f.endsWith('.html')) res.setHeader('Cache-Control', 'public, max-age=0');
} }));
app.use((req, res) => res.status(404).send('Nie znaleziono strony'));

export default app;

// Local: sobe o servidor. Na Vercel (ou nos testes) quem chama o app é a plataforma.
if (!env.VERCEL && !env.SEM_LISTEN) {
  app.listen(PORT, () => {
    log(`Sua Historinha PL em http://localhost:${PORT}`);
    log(`Zenith ${ZENITH_ENV}${TEM_ZENITH ? '' : ' — FALTA ZENITH_PUBLIC_KEY / ZENITH_SECRET_KEY'}`);
    log(`Pedidos: ${REDIS_URL ? 'Upstash Redis' : 'arquivo local ' + (env.DATA_FILE || 'data/pedidos.json')}`);
    if (!ZENITH_WH_SEC) log('Aviso: ZENITH_WEBHOOK_SECRET vazio — confirmação só por consulta GET /integrations/checkouts/:id');
    if (!META_TOKEN) log('Aviso: META_TOKEN vazio — Purchase só pelo Pixel do browser');
    if (!ADMIN_SENHA) log('Aviso: ADMIN_SENHA vazio — /admin desativado');
  });
}
