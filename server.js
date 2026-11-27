// Sua Historinha PT — servidor do funil (Express)
// Roda local (npm start) e na Vercel (export default app). Não guarda estado:
// o estado de cada pedido vem sempre da LeonaPay.
//   GET  /config            preços e métodos ativos
//   POST /criar-pagamento   cria o pedido MB WAY na LeonaPay
//   GET  /status/:id        estado do pedido (approved | pending | expired | rejected)
//   POST /webhook/leonapay  eventos assinados da LeonaPay (payment.paid etc.)
// Os arquivos de /public (site, imagens, fontes) são servidos pelo express.static
// localmente e pela CDN da Vercel em produção.

import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
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
const log     = (...a) => console.log(new Date().toISOString(), ...a);

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

// Cache curto do status por pedido: vários polls seguidos geram uma só consulta à LeonaPay
// (o limite da LeonaPay é por IP, 1000 pedidos a cada 5 min)
const statusCache = new Map(); // id -> { status, ate }
function cacheStatus(id, status, ms) {
  statusCache.set(id, { status, ate: Date.now() + ms });
  if (statusCache.size > 5000) for (const [k, v] of statusCache) if (v.ate < Date.now()) statusCache.delete(k);
}

// ─────────────────────────── App ───────────────────────────
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

// Webhook precisa do corpo bruto para validar o HMAC — registado antes do express.json()
app.post('/webhook/leonapay', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  const ts = req.get('x-leonapay-timestamp') || '';
  const eventId = req.get('x-leonapay-event-id') || '';
  const sig = req.get('x-leonapay-signature') || '';

  if (!LEONA_WH_SEC) return res.sendStatus(404); // webhook não configurado
  const expected = 'sha256=' + crypto.createHmac('sha256', LEONA_WH_SEC).update(`${ts}.${eventId}.${raw}`, 'utf8').digest('hex');
  const fresh = Math.abs(Date.now() / 1000 - Number(ts)) <= 300;
  const valid = fresh && expected.length === sig.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  if (!valid) { log('[webhook] assinatura inválida'); return res.sendStatus(401); }

  let ev = {}; try { ev = JSON.parse(raw); } catch { /* corpo inválido */ }
  const t = ev.data || {};
  log('[webhook]', ev.event, t.id, t.status, t.reference, t.amount, t.currency);
  if (t.id && mapStatus(t.status) !== 'pending') cacheStatus(t.id, mapStatus(t.status), 10 * 60 * 1000);
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
  const total = calcularTotal({ quizData, obExtras: !!b.obExtras, obCartinha: !!b.obCartinha, addon_colorir: !!b.addon_colorir, addon_expressa: !!b.addon_expressa });
  const pedidoId = 'sh-pt-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');

  if (!LEONA_KEY) {
    log('[leonapay] FALTA LEONAPAY_API_KEY');
    return res.status(500).json({ erro: 'Pagamento indisponível de momento. Tente novamente mais tarde.' });
  }

  const body = {
    method: 'MBWAY', currency: 'EUR', amount: total, reference: pedidoId,
    payer: { name: quizData.mom_name || undefined, phone: '+' + tel },
    expiresIn: MBWAY_EXPIRA,
  };

  let r;
  try { r = await leona('POST', '/api/v2/payments', body, crypto.randomUUID()); }
  catch (e) {
    // Timeout: o pedido pode ter sido criado — não gerar outra cobrança automaticamente
    log('[leonapay] erro de rede ao criar', pedidoId, e.message);
    return res.status(502).json({ erro: 'Não foi possível contactar o MB WAY. Verifique a app antes de tentar novamente.' });
  }

  if (!r.ok || !r.d?.data?.id) {
    const code = r.d?.error?.leonapayCode || r.d?.leonapayCode;
    log('[leonapay] recusou', pedidoId, r.http, code, r.d?.error?.message, r.d?.requestId || '');
    if (code === 'LP400_PAYER_PHONE') return res.status(400).json({ code: 'TELEMOVEL_INVALIDO', erro: 'Este número não está associado ao MB WAY. Confirme o telemóvel.' });
    if (code === 'LP422_MBWAY_REJECTED') return res.status(400).json({ erro: 'O pedido MB WAY foi recusado. Confirme o número ou tente outro telemóvel.' });
    return res.status(502).json({ erro: 'Não foi possível enviar o pedido MB WAY. Tente novamente.' });
  }

  const t = r.d.data;
  const expiraSeg = t.expiresAt ? Math.max(30, Math.round((Date.parse(t.expiresAt) - Date.now()) / 1000)) : MBWAY_EXPIRA;
  log('[mbway] pedido enviado', t.id, pedidoId, email, total);
  res.json({ id: t.id, total, expiraSeg });
});

app.get('/status/:id', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = req.params.id;

  if (!/^pay_[A-Za-z0-9_-]{4,80}$/.test(id)) return res.status(404).json({ status: 'not_found' });

  const c = statusCache.get(id);
  if (c && c.ate > Date.now()) return res.json({ status: c.status });

  try {
    const r = await leona('GET', '/api/v2/transactions/' + encodeURIComponent(id));
    if (r.http === 404) return res.status(404).json({ status: 'not_found' });
    if (!r.ok || !r.d?.data?.status) {
      log('[leonapay] consulta falhou', id, r.http, r.d?.error?.leonapayCode || '');
      return res.json({ status: 'pending' });
    }
    const status = mapStatus(r.d.data.status);
    cacheStatus(id, status, status === 'pending' ? 4000 : 10 * 60 * 1000);
    if (status === 'approved' && !c) log('[aprovado]', id, r.d.data.reference, r.d.data.amount, r.d.data.currency);
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
  });
}
