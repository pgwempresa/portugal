// Sua Historinha PT — servidor do funil (Express)
// Roda local (npm start) e na Vercel (export default app).
//   GET  /config            preços, pixel e métodos ativos
//   POST /criar-pagamento   cria o pedido MB WAY na LeonaPay (+ Purchase na Meta)
//   GET  /status/:id        estado do pedido (approved | pending | expired | rejected)
//   POST /webhook/leonapay  eventos assinados da LeonaPay (opcional)
//   GET  /admin/            painel de pedidos (public/admin) + /api/admin/* com sessão
// Os arquivos de /public (site, imagens, fontes) são servidos pelo express.static
// localmente e pela CDN da Vercel em produção.

import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;

// ─────────────────────────── Configuração ───────────────────────────
const PORT          = Number(env.PORT || 3000);
const LEONA_ENV     = env.LEONAPAY_ENV === 'sandbox' ? 'sandbox' : 'production'; // padrão: produção
const LEONA_BASE    = LEONA_ENV === 'production' ? 'https://api.leonapay.com.br' : 'https://sandbox.api.leonapay.com.br';
const LEONA_KEY     = env.LEONAPAY_API_KEY || '';
const LEONA_WH_SEC  = env.LEONAPAY_WEBHOOK_SECRET || ''; // opcional: sem ele o status vem só da consulta
const MBWAY_EXPIRA  = 300; // prazo para aprovar na app MB WAY (5 min, igual ao site antigo)
const PIXEL_ID      = '1594585312427182';        // Meta
const TIKTOK_PIXEL  = 'DC26VD3C77U8S1HK5NHG';    // TikTok
const META_TOKEN    = env.META_TOKEN || '';      // token da API de Conversões (opcional)
const ADMIN_SENHA   = env.ADMIN_SENHA || '';     // senha do /admin
// Upstash ligado pela Vercel: KV_REST_API_URL/TOKEN, com ou sem prefixo (ex.: STORAGE_KV_REST_API_URL)
const KV_PREFIXO    = Object.keys(env).find(k => k.endsWith('KV_REST_API_URL') && env[k])?.slice(0, -'KV_REST_API_URL'.length);
const REDIS_URL     = (KV_PREFIXO != null ? env[KV_PREFIXO + 'KV_REST_API_URL'] : env.UPSTASH_REDIS_REST_URL) || '';
const REDIS_TOKEN   = (KV_PREFIXO != null ? env[KV_PREFIXO + 'KV_REST_API_TOKEN'] : env.UPSTASH_REDIS_REST_TOKEN) || '';

// Mesmos valores que o /config do site no ar devolvia (24/11/2026)
const PRODUTO = {
  nome: 'Sua Historinha',
  imagem: '/img/chatgpt-image-17-de-jun-de-2026-14-54-47.png',
};
const PRECOS = { base: 19.9, discount: 10, colorir: 2.9, colorirOriginal: 5.9, expressa: 1.9, expressaOriginal: 3.9 };
const ORDER_BUMP = { id: 'historinhas-extras', titulo: '+2 Histórias Extras 100% Personalizadas', preco: 4.9, precoOriginal: 9.9 };
const ORDER_BUMP_CARTINHA = { id: 'cartinha-noel', titulo: 'Cartinha do Pai Natal', preco: 2.9, ativo: true };

// ─────────────────────────── Utilitários ───────────────────────────
const round2  = v => Math.round(Number(v) * 100) / 100;
const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || ''));
const sha256  = v => crypto.createHash('sha256').update(String(v)).digest('hex');
const log     = (...a) => console.log(new Date().toISOString(), ...a);
const comTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(r, ms))]);

// O total é sempre recalculado aqui: o valor enviado pelo browser é ignorado
function calcularTotal({ quizData = {}, obExtras, obCartinha, addon_colorir, addon_expressa }) {
  let t = PRECOS.base;
  if (quizData.has_discount === 'Sim') t -= PRECOS.discount;
  if (addon_colorir)  t += PRECOS.colorir;
  if (addon_expressa) t += PRECOS.expressa;
  if (obExtras)       t += ORDER_BUMP.preco;
  if (obCartinha && ORDER_BUMP_CARTINHA.ativo) t += ORDER_BUMP_CARTINHA.preco;
  return round2(t);
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

// ─────────────────────────── Pedidos ───────────────────────────
// Na Vercel: Upstash Redis (KV_REST_API_URL/TOKEN, criados ao ligar o Upstash ao projeto).
// Local sem Redis: arquivo data/pedidos.json.
//   pedido:<id>  JSON do pedido
//   gerados      zset id → data de criação (todo MB WAY gerado)
//   pagos        zset id → data de pagamento
//   pendentes    zset id → data de criação (para conferir os que ficaram sem resposta)
//   falhas       lista das últimas 1000 falhas ao gerar o MB WAY
//   logs         lista dos últimos 2000 acontecimentos (página Logs do /admin)
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
      if (!p || p.status === 'pago') return false;
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
    async pendentes() { const [ids] = await cmd(['ZRANGE', 'pendentes', '0', '99', 'WITHSCORES']); return pares(ids); },
    async falha(f) { await cmd(['LPUSH', 'falhas', JSON.stringify(f)], ['LTRIM', 'falhas', '0', '999']); },
    async falhas() { const [l] = await cmd(['LRANGE', 'falhas', '0', '999']); return l.map(v => JSON.parse(v)); },
    async log(e) { await cmd(['LPUSH', 'logs', JSON.stringify(e)], ['LTRIM', 'logs', '0', '1999']); },
    async logs() { const [l] = await cmd(['LRANGE', 'logs', '0', '1999']); return l.map(v => JSON.parse(v)); },
    async listar(lista) { // 'pagos' | 'gerados', mais recentes primeiro
      const [ids] = await cmd(['ZREVRANGE', lista, '0', '999']);
      if (!ids.length) return [];
      const [vals] = await cmd(['MGET', ...ids.map(i => 'pedido:' + i)]);
      return vals.filter(Boolean).map(v => JSON.parse(v));
    },
  };
}

function arquivoStore() {
  const FILE = path.join(__dirname, 'data', 'pedidos.json');
  let db = { pedidos: {}, gerados: {}, pagos: {}, pendentes: {} };
  try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* primeiro arranque */ }
  db.gerados ||= {}; db.falhas ||= []; db.logs ||= [];
  const gravar = () => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(db, null, 1)); };
  return {
    async salvar(p) { db.pedidos[p.id] = p; db.gerados[p.id] = db.pendentes[p.id] = Date.now(); gravar(); },
    async get(id) { return db.pedidos[id] || null; },
    async marcarPago(id) {
      const p = db.pedidos[id];
      if (!p || p.status === 'pago') return false;
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
    async pendentes() { return Object.entries(db.pendentes).map(([id, criado]) => ({ id, criado })); },
    async falha(f) { db.falhas.unshift(f); db.falhas = db.falhas.slice(0, 1000); gravar(); },
    async falhas() { return db.falhas; },
    async log(e) { db.logs.unshift(e); db.logs = db.logs.slice(0, 2000); gravar(); },
    async logs() { return db.logs; },
    async listar(lista) { return Object.entries(db[lista]).sort((a, b) => b[1] - a[1]).map(([id]) => db.pedidos[id]).filter(Boolean); },
  };
}

// ─────────────────────────── Logs ───────────────────────────
// Cada acontecimento relevante vai para a página Logs do /admin.
// nivel: erro | aviso | sucesso | info
async function registrarLog(nivel, tipo, dados = {}) {
  const e = { em: new Date().toISOString(), nivel, tipo, ...dados };
  for (const k of Object.keys(e)) if (e[k] === undefined || e[k] === '') delete e[k];
  await comTimeout(store.log(e).catch(err => log('[logs] erro ao guardar', err.message)), 3000);
}
const resumoPedido = p => p ? {
  pedido: p.id, reference: p.reference, email: p.email, telefone: p.telefone, total: p.total,
  cliente: p.quizData?.mom_name, crianca: p.quizData?.child_name_full,
} : {};
// Evita repetir o mesmo aviso (ex.: consultas falhadas a cada 4 s) — no máximo 1 por chave por minuto
const ultimoAviso = new Map();
function avisoUmaVez(chave) {
  const agora = Date.now();
  if ((ultimoAviso.get(chave) || 0) > agora - 60e3) return false;
  ultimoAviso.set(chave, agora);
  if (ultimoAviso.size > 5000) ultimoAviso.clear();
  return true;
}

// ─────────────────────────── LeonaPay ───────────────────────────
async function leona(method, pathname, body, idempotencyKey) {
  const headers = { 'x-api-key': LEONA_KEY, 'Accept': 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  const r = await fetch(LEONA_BASE + pathname, {
    method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000),
  });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok && d.success !== false, http: r.status, d };
}

// LeonaPay → estado que o index.html entende
function mapStatus(s) {
  switch (String(s || '').toUpperCase()) {
    case 'PAID':     return 'approved';
    case 'EXPIRED':  return 'expired';
    case 'FAILED':
    case 'REFUNDED': return 'rejected';
    default:         return 'pending'; // CREATED, PENDING, ACTION_REQUIRED
  }
}

// Aplica o estado vindo da LeonaPay ao pedido guardado
async function registrarStatus(id, status, origem = 'consulta') {
  try {
    if (status === 'approved') {
      const p = await store.marcarPago(id);
      if (p) { log('[pago]', id); await registrarLog('sucesso', 'mbway_pago', { ...resumoPedido(p), origem }); }
    } else if (status === 'expired' || status === 'rejected') {
      const p = await store.encerrar(id, status);
      if (p) await registrarLog('aviso', status === 'expired' ? 'mbway_expirado' : 'mbway_recusado', { ...resumoPedido(p), origem });
    }
  } catch (e) { log('[pedidos] erro ao atualizar', id, e.message); }
}

// Cache curto do status por pedido: vários polls seguidos geram uma só consulta à LeonaPay
const statusCache = new Map(); // id -> { status, ate }
function cacheStatus(id, status, ms) {
  statusCache.set(id, { status, ate: Date.now() + ms });
  if (statusCache.size > 5000) for (const [k, v] of statusCache) if (v.ate < Date.now()) statusCache.delete(k);
}

async function consultarLeona(id) {
  const r = await leona('GET', '/api/v2/transactions/' + encodeURIComponent(id));
  if (r.http === 404) return 'not_found';
  if (!r.ok || !r.d?.data?.status) {
    const codigo = r.d?.error?.leonapayCode || r.d?.leonapayCode;
    log('[leonapay] consulta falhou', id, r.http, codigo || '');
    if (avisoUmaVez('consulta:' + id)) await registrarLog('aviso', 'leonapay_consulta', { pedido: id, http: r.http, codigo, mensagem: r.d?.error?.message || 'Consulta do estado falhou' });
    return 'pending';
  }
  return mapStatus(r.d.data.status);
}

// ─────────────────────────── Meta (API de Conversões) ───────────────────────────
// MB WAY gerado = compra no Facebook. O eventID é o mesmo do Pixel no browser,
// então a Meta conta uma vez só.
async function metaPurchase(p, req) {
  if (!META_TOKEN) return;
  const user_data = {
    em: [sha256(p.email.trim().toLowerCase())],
    ph: [sha256(p.telefone.replace(/\D/g, ''))],
    country: [sha256('pt')],
    client_ip_address: clientIp(req) || undefined,
    client_user_agent: req.get('user-agent') || undefined,
    fbp: p.fbp || undefined, fbc: p.fbc || undefined,
  };
  if (p.quizData?.mom_name) user_data.fn = [sha256(String(p.quizData.mom_name).trim().split(/\s+/)[0].toLowerCase())];
  const body = {
    data: [{
      event_name: 'Purchase', event_time: Math.floor(Date.now() / 1000), event_id: 'purchase_' + p.id,
      action_source: 'website', event_source_url: req.get('referer') || undefined, user_data,
      custom_data: { value: p.total, currency: 'EUR', content_name: PRODUTO.nome, order_id: p.id },
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

// Webhook precisa do corpo bruto para validar o HMAC — registado antes do express.json()
app.post('/webhook/leonapay', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  if (!LEONA_WH_SEC) return res.sendStatus(404); // webhook não configurado
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  const ts = req.get('x-leonapay-timestamp') || '';
  const eventId = req.get('x-leonapay-event-id') || '';
  const sig = req.get('x-leonapay-signature') || '';

  const expected = 'sha256=' + crypto.createHmac('sha256', LEONA_WH_SEC).update(`${ts}.${eventId}.${raw}`, 'utf8').digest('hex');
  const fresh = Math.abs(Date.now() / 1000 - Number(ts)) <= 300;
  const valid = fresh && expected.length === sig.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  if (!valid) {
    log('[webhook] assinatura inválida');
    if (avisoUmaVez('webhook:' + clientIp(req))) await registrarLog('erro', 'webhook_invalido', { ip: clientIp(req), mensagem: fresh ? 'Assinatura não confere' : 'Timestamp fora do prazo de 5 min' });
    return res.sendStatus(401);
  }

  let ev = {}; try { ev = JSON.parse(raw); } catch { /* corpo inválido */ }
  const t = ev.data || {};
  log('[webhook]', ev.event, t.id, t.status);
  await registrarLog('info', 'webhook', { evento: ev.event, pedido: t.id, status: t.status, eventId });
  const status = mapStatus(t.status);
  if (t.id && status !== 'pending') { cacheStatus(t.id, status, 10 * 60 * 1000); await registrarStatus(t.id, status, 'webhook'); }
  res.sendStatus(200);
});

app.use(express.json({ limit: '200kb' }));

app.get('/config', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    produto: PRODUTO,
    moeda: 'EUR',
    precos: PRECOS,
    orderBump: ORDER_BUMP,
    orderBumpCartinha: ORDER_BUMP_CARTINHA,
    pixelId: PIXEL_ID,
    tiktokPixelId: TIKTOK_PIXEL,
    mbwayExpiraSeg: MBWAY_EXPIRA,
  });
});

// Falhas ao gerar o MB WAY: ficam no /admin (separador Falhas) e no log da Vercel
const corta = (v, n = 160) => v == null ? undefined : String(v).slice(0, n);
async function registrarFalha(req, tipo, dados = {}) {
  const f = { em: new Date().toISOString(), tipo, ip: clientIp(req), ...dados };
  log('[falha]', tipo, JSON.stringify(dados));
  await Promise.all([
    comTimeout(store.falha(f).catch(e => log('[falhas] erro ao guardar', e.message)), 3000),
    registrarLog('erro', tipo, { ...dados, ip: f.ip }),
  ]);
}

app.post('/criar-pagamento', async (req, res) => {
  const b = req.body || {};
  const quizData = typeof b.quizData === 'object' && b.quizData ? b.quizData : {};
  const flags = { obExtras: !!b.obExtras, obCartinha: !!b.obCartinha, addon_colorir: !!b.addon_colorir, addon_expressa: !!b.addon_expressa };
  const total = calcularTotal({ quizData, ...flags });
  const email = String(b.email || '').trim().toLowerCase();
  const tel = String(b.telefone || '').replace(/\D/g, '');            // chega como 351XXXXXXXXX
  const ctx = { email: corta(email), telefone: corta(b.telefone, 40), cliente: corta(quizData.mom_name), crianca: corta(quizData.child_name_full), total };

  if (b.metodo !== 'mbway') return res.status(400).json({ erro: 'Método de pagamento indisponível. Use o MB WAY.' });

  if (!isEmail(email)) {
    await registrarFalha(req, 'email_invalido', { ...ctx, mensagem: 'E-mail inválido (servidor)' });
    return res.status(400).json({ code: 'EMAIL_INVALIDO', erro: 'Preencha um e-mail válido.' });
  }
  if (!/^3519\d{8}$/.test(tel)) {
    await registrarFalha(req, 'telemovel_invalido', { ...ctx, mensagem: 'Telemóvel fora do formato +351 9XXXXXXXX (servidor)' });
    return res.status(400).json({ code: 'TELEMOVEL_INVALIDO', erro: 'Indique o número de telemóvel associado ao MB WAY (9 dígitos, começa por 9).' });
  }

  const reference = 'sh-pt-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');

  if (!LEONA_KEY) {
    await registrarFalha(req, 'sem_chave', { ...ctx, mensagem: 'LEONAPAY_API_KEY não configurada' });
    return res.status(500).json({ erro: 'Pagamento indisponível de momento. Tente novamente mais tarde.' });
  }

  const body = {
    method: 'MBWAY', currency: 'EUR', amount: total, reference,
    payer: { name: quizData.mom_name || undefined, phone: '+' + tel },
    expiresIn: MBWAY_EXPIRA,
  };

  let r;
  try { r = await leona('POST', '/api/v2/payments', body, crypto.randomUUID()); }
  catch (e) {
    // Timeout: o pedido pode ter sido criado — não gerar outra cobrança automaticamente
    await registrarFalha(req, 'erro_rede', { ...ctx, reference, mensagem: 'Sem resposta da LeonaPay: ' + e.message });
    return res.status(502).json({ erro: 'Não foi possível contactar o MB WAY. Verifique a app antes de tentar novamente.' });
  }

  if (!r.ok || !r.d?.data?.id) {
    const er = r.d?.error || {};
    const code = er.leonapayCode || r.d?.leonapayCode;
    await registrarFalha(req, 'leonapay_recusou', {
      ...ctx, reference, http: r.http, codigo: corta(code, 60), campo: corta(er.field, 60),
      mensagem: corta(er.message || r.d?.leonapayDescription || 'Resposta sem id', 300), requestId: corta(er.requestId || r.d?.requestId, 80),
    });
    if (code === 'LP400_PAYER_PHONE') return res.status(400).json({ code: 'TELEMOVEL_INVALIDO', erro: 'Este número não está associado ao MB WAY. Confirme o telemóvel.' });
    if (code === 'LP422_MBWAY_REJECTED') return res.status(400).json({ erro: 'O pedido MB WAY foi recusado. Confirme o número ou tente outro telemóvel.' });
    return res.status(502).json({ erro: 'Não foi possível enviar o pedido MB WAY. Tente novamente.' });
  }

  const t = r.d.data;
  const pedido = {
    id: t.id, reference, status: 'pendente', total, email, telefone: '+' + tel,
    ...flags, quizData, utms: b.utms || {}, fbp: b.fbp || null, fbc: b.fbc || null,
    criadoEm: new Date().toISOString(),
  };

  // Guarda o pedido e envia a compra para a Meta em paralelo (no máximo 5 s)
  await comTimeout(Promise.all([
    store.salvar(pedido).catch(e => log('[pedidos] ERRO ao guardar:', e.message, JSON.stringify(pedido))),
    metaPurchase(pedido, req),
  ]), 5000);

  const expiraSeg = t.expiresAt ? Math.max(30, Math.round((Date.parse(t.expiresAt) - Date.now()) / 1000)) : MBWAY_EXPIRA;
  log('[mbway] pedido enviado', t.id, reference, email, total);
  const extras = [flags.addon_colorir && 'Colorir', flags.addon_expressa && 'Expressa', flags.obExtras && '+2 Histórias', flags.obCartinha && 'Cartinha'].filter(Boolean).join(', ');
  await registrarLog('info', 'mbway_gerado', { ...resumoPedido(pedido), extras, desconto: quizData.has_discount === 'Sim' ? 'Sim' : undefined, origem_utm: b.utms?.utm_source, ip: clientIp(req) });
  res.json({ id: t.id, total, expiraSeg });
});

// Falhas detetadas na própria página (antes de chegar ao servidor), ex.: telemóvel inválido
const limiteFalhas = new Map(); // ip -> { n, ate }
app.post('/registrar-falha', express.text({ type: '*/*', limit: '4kb' }), async (req, res) => {
  res.sendStatus(204);
  const ip = clientIp(req), agora = Date.now();
  const l = limiteFalhas.get(ip);
  if (l && l.ate > agora && l.n >= 20) return;
  limiteFalhas.set(ip, l && l.ate > agora ? { n: l.n + 1, ate: l.ate } : { n: 1, ate: agora + 10 * 60e3 });
  if (limiteFalhas.size > 5000) limiteFalhas.clear();
  let d = {}; try { d = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); } catch { return; }
  const tipos = { telemovel_invalido: 'Telemóvel recusado pela página', email_invalido: 'E-mail recusado pela página' };
  if (!tipos[d.tipo]) return;
  await registrarFalha(req, d.tipo, { email: corta(d.email), telefone: corta(d.telefone, 40), total: Number(d.total) || undefined, mensagem: tipos[d.tipo] });
});

app.get('/status/:id', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = req.params.id;
  if (!/^pay_[A-Za-z0-9_-]{4,80}$/.test(id)) return res.status(404).json({ status: 'not_found' });

  const c = statusCache.get(id);
  if (c && c.ate > Date.now()) return res.json({ status: c.status });

  try {
    const status = await consultarLeona(id);
    if (status === 'not_found') return res.status(404).json({ status });
    cacheStatus(id, status, status === 'pending' ? 4000 : 10 * 60 * 1000);
    await registrarStatus(id, status);
    res.json({ status });
  } catch (e) {
    log('[leonapay] erro ao consultar', id, e.message);
    res.json({ status: 'pending' });
  }
});

// Só no sandbox: simula o resultado de um pedido (PAID | FAILED | EXPIRED)
app.post('/dev/simular/:id', async (req, res) => {
  if (LEONA_ENV !== 'sandbox') return res.sendStatus(404);
  const status = String(req.query.status || 'PAID').toUpperCase();
  const r = await leona('POST', '/api/v2/simulations/payments/' + encodeURIComponent(req.params.id), { status }, crypto.randomUUID());
  res.status(r.http).json(r.d);
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
    await new Promise(r => setTimeout(r, 600));
    return res.status(401).json({ erro: 'Senha incorreta.' });
  }
  tentativas.delete(ip);
  await registrarLog('info', 'admin_login', { ip, navegador: corta(req.get('user-agent'), 120) });
  res.cookie(COOKIE, tokenSessao(agora + SESSAO_MS), { httpOnly: true, secure: req.secure, sameSite: 'strict', path: '/', maxAge: SESSAO_MS });
  res.sendStatus(204);
});
app.post('/api/admin/logout', (req, res) => { res.clearCookie(COOKIE, { path: '/' }); res.sendStatus(204); });
app.get('/api/admin/sessao', exigeSessao, (req, res) => res.sendStatus(204));

// Pedidos que ficaram sem resposta (cliente fechou a página antes de aprovar): confere na LeonaPay
async function conferirPendentes() {
  const lista = (await store.pendentes()).filter(p => Date.now() - p.criado > 60 * 1000).slice(0, 25);
  await Promise.all(lista.map(async ({ id, criado }) => {
    try {
      const s = await consultarLeona(id);
      if (s === 'not_found' || (s === 'pending' && Date.now() - criado > 2 * 86400 * 1000)) return store.encerrar(id, 'expired');
      await registrarStatus(id, s);
    } catch (e) { log('[admin] erro ao conferir', id, e.message); }
  }));
}

app.get('/api/admin/pedidos', exigeSessao, async (req, res) => {
  if (env.VERCEL && !REDIS_URL) {
    return res.status(503).json({ erro: 'Banco de pedidos não ligado. Na Vercel: Storage → Upstash (Redis) → Connect ao projeto, e faça redeploy.' });
  }
  try {
    if (LEONA_KEY) await comTimeout(conferirPendentes(), 8000);
    const [gerados, falhas, logs] = await Promise.all([store.listar('gerados'), store.falhas(), store.logs()]);
    const pedidos = gerados.map(({ fbp, fbc, ...p }) => p);
    res.json({ pedidos, falhas: falhas.map(({ ip, ...f }) => f), logs });
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
app.use((req, res) => res.status(404).send('Página não encontrada'));

export default app;

// Local: sobe o servidor. Na Vercel quem chama o app é a própria plataforma.
if (!env.VERCEL) {
  app.listen(PORT, () => {
    log(`Sua Historinha PT em http://localhost:${PORT}`);
    log(`LeonaPay ${LEONA_ENV} (${LEONA_BASE})${LEONA_KEY ? '' : ' — FALTA LEONAPAY_API_KEY'}`);
    log(`Pedidos: ${REDIS_URL ? 'Upstash Redis' : 'arquivo local data/pedidos.json'}`);
    if (!META_TOKEN) log('Aviso: META_TOKEN vazio — Purchase só pelo Pixel do browser');
    if (!ADMIN_SENHA) log('Aviso: ADMIN_SENHA vazio — /admin desativado');
  });
}
