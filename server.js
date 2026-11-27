// Sua Historinha PT — servidor do funil (Express)
// Roda local (npm start) e na Vercel (export default app).
//   GET  /config            preços, pixel e métodos ativos
//   POST /criar-pagamento   cria o pedido MB WAY na LeonaPay (+ Purchase na Meta)
//   GET  /status/:id        estado do pedido (approved | pending | expired | rejected)
//   POST /webhook/leonapay  eventos assinados da LeonaPay (opcional)
//   GET  /admin             pedidos pagos (protegido por senha)
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
const PIXEL_ID      = '1594585312427182';
const META_TOKEN    = env.META_TOKEN || '';      // token da API de Conversões (opcional)
const ADMIN_SENHA   = env.ADMIN_SENHA || '';     // senha do /admin
const REDIS_URL     = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN   = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || '';

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
//   pagos        zset id → data de pagamento
//   pendentes    zset id → data de criação (para conferir os que ficaram sem resposta)
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
    async salvar(p) { await cmd(['SET', 'pedido:' + p.id, JSON.stringify(p)], ['ZADD', 'pendentes', String(Date.now()), p.id]); },
    async get(id) { const [v] = await cmd(['GET', 'pedido:' + id]); return v ? JSON.parse(v) : null; },
    async marcarPago(id) {
      const p = await this.get(id);
      if (!p || p.status === 'pago') return false;
      Object.assign(p, { status: 'pago', pagoEm: new Date().toISOString() });
      await cmd(['SET', 'pedido:' + id, JSON.stringify(p)], ['ZADD', 'pagos', String(Date.now()), id], ['ZREM', 'pendentes', id]);
      return true;
    },
    async encerrar(id, status) {
      const p = await this.get(id);
      if (p && p.status !== 'pago') { p.status = status; await cmd(['SET', 'pedido:' + id, JSON.stringify(p), 'EX', String(7 * 86400)]); }
      await cmd(['ZREM', 'pendentes', id]);
    },
    async pendentes() { const [ids] = await cmd(['ZRANGE', 'pendentes', '0', '99', 'WITHSCORES']); return pares(ids); },
    async pagos() {
      const [ids] = await cmd(['ZREVRANGE', 'pagos', '0', '999']);
      if (!ids.length) return [];
      const [vals] = await cmd(['MGET', ...ids.map(i => 'pedido:' + i)]);
      return vals.filter(Boolean).map(v => JSON.parse(v));
    },
  };
}

function arquivoStore() {
  const FILE = path.join(__dirname, 'data', 'pedidos.json');
  let db = { pedidos: {}, pagos: {}, pendentes: {} };
  try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* primeiro arranque */ }
  const gravar = () => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(db, null, 1)); };
  return {
    async salvar(p) { db.pedidos[p.id] = p; db.pendentes[p.id] = Date.now(); gravar(); },
    async get(id) { return db.pedidos[id] || null; },
    async marcarPago(id) {
      const p = db.pedidos[id];
      if (!p || p.status === 'pago') return false;
      Object.assign(p, { status: 'pago', pagoEm: new Date().toISOString() });
      db.pagos[id] = Date.now(); delete db.pendentes[id]; gravar();
      return true;
    },
    async encerrar(id, status) { if (db.pedidos[id] && db.pedidos[id].status !== 'pago') db.pedidos[id].status = status; delete db.pendentes[id]; gravar(); },
    async pendentes() { return Object.entries(db.pendentes).map(([id, criado]) => ({ id, criado })); },
    async pagos() { return Object.entries(db.pagos).sort((a, b) => b[1] - a[1]).map(([id]) => db.pedidos[id]).filter(Boolean); },
  };
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
async function registrarStatus(id, status) {
  try {
    if (status === 'approved') { if (await store.marcarPago(id)) log('[pago]', id); }
    else if (status === 'expired' || status === 'rejected') await store.encerrar(id, status);
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
  if (!r.ok || !r.d?.data?.status) { log('[leonapay] consulta falhou', id, r.http, r.d?.error?.leonapayCode || ''); return 'pending'; }
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
    if (!r.ok) log('[meta] Purchase', r.status, (await r.text()).slice(0, 300));
  } catch (e) { log('[meta] erro', e.message); }
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
  if (!valid) { log('[webhook] assinatura inválida'); return res.sendStatus(401); }

  let ev = {}; try { ev = JSON.parse(raw); } catch { /* corpo inválido */ }
  const t = ev.data || {};
  log('[webhook]', ev.event, t.id, t.status);
  const status = mapStatus(t.status);
  if (t.id && status !== 'pending') { cacheStatus(t.id, status, 10 * 60 * 1000); await registrarStatus(t.id, status); }
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
    metodos: ['mbway'],
    stripePk: '',
    mbwayExpiraSeg: MBWAY_EXPIRA,
    multibancoDias: 3,
  });
});

app.post('/criar-pagamento', async (req, res) => {
  const b = req.body || {};
  if (b.metodo !== 'mbway') return res.status(400).json({ erro: 'Pagamento por cartão indisponível de momento. Use o MB WAY.' });

  const email = String(b.email || '').trim().toLowerCase();
  if (!isEmail(email)) return res.status(400).json({ code: 'EMAIL_INVALIDO', erro: 'Preencha um e-mail válido.' });

  const tel = String(b.telefone || '').replace(/\D/g, '');            // chega como 351XXXXXXXXX
  if (!/^3519[1236]\d{7}$/.test(tel)) {
    return res.status(400).json({ code: 'TELEMOVEL_INVALIDO', erro: 'Indique o número de telemóvel associado ao MB WAY (9 dígitos, começa por 9).' });
  }

  const quizData = typeof b.quizData === 'object' && b.quizData ? b.quizData : {};
  const flags = { obExtras: !!b.obExtras, obCartinha: !!b.obCartinha, addon_colorir: !!b.addon_colorir, addon_expressa: !!b.addon_expressa };
  const total = calcularTotal({ quizData, ...flags });
  const reference = 'sh-pt-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');

  if (!LEONA_KEY) {
    log('[leonapay] FALTA LEONAPAY_API_KEY');
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
    log('[leonapay] erro de rede ao criar', reference, e.message);
    return res.status(502).json({ erro: 'Não foi possível contactar o MB WAY. Verifique a app antes de tentar novamente.' });
  }

  if (!r.ok || !r.d?.data?.id) {
    const code = r.d?.error?.leonapayCode || r.d?.leonapayCode;
    log('[leonapay] recusou', reference, r.http, code, r.d?.error?.message, r.d?.requestId || '');
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
  res.json({ id: t.id, total, expiraSeg });
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
function senhaOk(req) {
  const m = /^Basic (.+)$/.exec(req.get('authorization') || '');
  if (!m) return false;
  const senha = Buffer.from(m[1], 'base64').toString('utf8').split(':').slice(1).join(':');
  return crypto.timingSafeEqual(Buffer.from(sha256(senha)), Buffer.from(sha256(ADMIN_SENHA)));
}

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

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = v => Number(v || 0).toLocaleString('pt-PT', { style: 'currency', currency: 'EUR' });
const dataPT = iso => iso ? new Date(iso).toLocaleString('pt-PT', { timeZone: 'Europe/Lisbon', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

const ROTULOS = {
  child_name_full: 'Nome da criança', child_age: 'Idade', child_gender: 'Género', skin_tone: 'Tom de pele',
  hair_color: 'Cor do cabelo', hair_type: 'Tipo de cabelo', eye_color: 'Cor dos olhos', moral: 'Moral da história',
  setting: 'Cenário', special_notes: 'Notas especiais', temperamento: 'Temperamento', preferencia: 'Preferência',
  compromisso: 'Compromisso', mom_name: 'Nome da mãe/pai', email_quiz: 'E-mail do quiz',
};

function paginaAdmin(pedidos) {
  const soma = pedidos.reduce((s, p) => s + Number(p.total || 0), 0);
  const cards = pedidos.map(p => {
    const q = p.quizData || {};
    const extras = [p.addon_colorir && 'Colorir', p.addon_expressa && 'Expressa', p.obExtras && '+2 Histórias', p.obCartinha && 'Cartinha Pai Natal'].filter(Boolean);
    const detalhes = Object.entries(ROTULOS).filter(([k]) => q[k]).map(([k, r]) => `<dt>${esc(r)}</dt><dd>${esc(q[k])}</dd>`).join('');
    return `<article class="pedido">
      <header><div><strong>${esc(q.child_name_full || q.child_name || '—')}</strong> <span class="sub">${esc(q.child_age ? q.child_age + ' anos' : '')} ${esc(q.child_gender || '')}</span></div><div class="valor">${eur(p.total)}</div></header>
      <div class="linha"><span>${esc(q.mom_name || '')}</span><a href="mailto:${esc(p.email)}">${esc(p.email)}</a><span>${esc(p.telefone)}</span></div>
      <div class="linha sub"><span>Pago ${esc(dataPT(p.pagoEm))}</span>${extras.length ? `<span class="tags">${extras.map(e => `<i>${esc(e)}</i>`).join('')}</span>` : ''}</div>
      <details><summary>Personalização</summary><dl>${detalhes}</dl><p class="sub">Pedido ${esc(p.id)} · ${esc(p.reference || '')}</p></details>
    </article>`;
  }).join('');
  return `<!doctype html><html lang="pt-PT"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Pedidos pagos</title><link href="/fonts/fonts.css" rel="stylesheet">
<style>
:root{--bg:#f6f5fb;--card:#fff;--ink:#20203d;--sub:#6b6b85;--line:#e6e4f0;--accent:#00872b}
@media (prefers-color-scheme:dark){:root{--bg:#14141f;--card:#1e1e2d;--ink:#ececf5;--sub:#a0a0b8;--line:#2e2e42;--accent:#3ccf6a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 'Open Sans',system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 48px}
h1{font:600 22px 'Reddit Sans',system-ui,sans-serif;margin:0 0 4px}.resumo{color:var(--sub);margin:0 0 20px}
.pedido{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:10px}
.pedido header{display:flex;justify-content:space-between;gap:12px;align-items:baseline}
.valor{font-weight:700;color:var(--accent);white-space:nowrap}.sub{color:var(--sub);font-size:13px}
.linha{display:flex;flex-wrap:wrap;gap:4px 16px;margin-top:6px;overflow-wrap:anywhere}.linha a{color:inherit}
.tags{display:flex;gap:6px;flex-wrap:wrap}.tags i{font-style:normal;font-size:12px;border:1px solid var(--line);border-radius:99px;padding:1px 8px}
details{margin-top:8px}summary{cursor:pointer;color:var(--sub);font-size:13px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:10px 0 6px;font-size:14px}dt{color:var(--sub)}dd{margin:0;overflow-wrap:anywhere}
.vazio{color:var(--sub);text-align:center;padding:48px 0}
</style></head><body><main>
<h1>Pedidos pagos</h1><p class="resumo">${pedidos.length} ${pedidos.length === 1 ? 'pedido' : 'pedidos'} · ${eur(soma)}</p>
${cards || '<p class="vazio">Ainda não há pedidos pagos.</p>'}
</main></body></html>`;
}

app.get('/admin', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!ADMIN_SENHA) return res.status(503).send('Defina a variável ADMIN_SENHA para ativar o /admin.');
  if (!senhaOk(req)) return res.set('WWW-Authenticate', 'Basic realm="admin", charset="UTF-8"').status(401).send('Senha necessária');
  try {
    if (LEONA_KEY) await comTimeout(conferirPendentes(), 8000);
    res.send(paginaAdmin(await store.pagos()));
  } catch (e) {
    log('[admin] erro', e.message);
    res.status(500).send('Erro ao carregar os pedidos: ' + esc(e.message));
  }
});

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
