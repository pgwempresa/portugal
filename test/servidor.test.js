// Testes do fluxo completo do servidor com a Zenith simulada (sem rede nem cobrança)
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Zenith falsa ──
const zen = { checkouts: new Map(), chaves: new Map(), chamadasCriar: 0, modo: 'ok', estado: {}, sessoes: [], originsZenith: [], modoSessao: 'ok' };
const realFetch = globalThis.fetch;
const json = (s, o) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, opt = {}) => {
  url = String(url);
  if (!url.startsWith('https://api.zenithworld.com.br')) return realFetch(url, opt);
  assert.ok(opt.headers['X-API-Key'] && opt.headers['X-API-Secret'], 'credenciais em falta');
  if (url.includes('/integrations/payment-methods')) return json(200, { country: 'PL', currency: 'PLN', items: [{ code: 'blik', requiredPayloadFields: [] }, { code: 'card', category: 'card' }], conflicts: [] });
  if (url.endsWith('/elements/sessions')) {
    const b = JSON.parse(opt.body);
    zen.sessoes.push(b);
    if (zen.modoSessao === 'timeout-uma-vez') { zen.modoSessao = 'ok'; throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); }
    if (!zen.originsZenith.includes(b.origin)) return json(403, { code: 'ORIGIN_NOT_ALLOWED', message: 'origin não autorizada' });
    return json(200, { elementSessionId: 'es_' + b.referenceId, clientToken: 'ct_x', elementUrl: 'https://api.zenithworld.com.br/elements/frame', sdkUrl: 'https://api.zenithworld.com.br/elements/sdk.js', expiresAt: new Date(Date.now() + 15 * 60e3).toISOString() });
  }
  if (opt.method === 'POST' && url.endsWith('/integrations/checkouts')) {
    zen.chamadasCriar++;
    const chave = opt.headers['Idempotency-Key'];
    const b = JSON.parse(opt.body);
    if (zen.modo === 'timeout-uma-vez') { zen.modo = 'ok'; zen.chaves.set(chave, null); throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); }
    if (zen.modo === 'recusa') return json(400, { code: 'CUSTOMER_NAME_INVALID', message: 'customerName inválido' });
    if (zen.modo === 'sempre-timeout') throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    if (zen.chaves.get(chave)) return json(200, zen.checkouts.get(zen.chaves.get(chave)));
    const id = 'checkout_' + crypto.randomBytes(4).toString('hex');
    const r = {
      checkout: { id, referenceId: b.referenceId, amount: b.amount, currency: b.currency, status: 'pending' },
      payment: { status: 'pending' }, method: { code: 'blik', displayName: 'BLIK' },
      nextAction: { type: 'blik', clientSecret: 'pi_secret_' + id, publishableKey: 'pk_test_x' },
    };
    zen.checkouts.set(id, r); zen.chaves.set(chave, id);
    return json(200, r);
  }
  const m = /\/integrations\/checkouts\/([^/?]+)$/.exec(url);
  if (m) { const r = zen.checkouts.get(m[1]); return r ? json(200, { ...r, payment: { status: zen.estado[m[1]] || 'pending' } }) : json(404, {}); }
  return json(404, {});
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-teste-'));
Object.keys(process.env).filter(k => /KV_REST_API|UPSTASH/.test(k)).forEach(k => delete process.env[k]);
Object.assign(process.env, {
  SEM_LISTEN: '1', DATA_FILE: path.join(dir, 'pedidos.json'), ZENITH_PUBLIC_KEY: 'zp_pub_teste', ZENITH_SECRET_KEY: 'zp_sec_teste',
  ZENITH_WEBHOOK_SECRET: 'whsec_teste', ADMIN_SENHA: 'segredo', META_TOKEN: '',
});
const { default: app } = await import('../server.js');
const srv = app.listen(0); await new Promise(r => srv.once('listening', r));
const B = 'http://127.0.0.1:' + srv.address().port;
test.after(() => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const criar = (extra = {}) => realFetch(B + '/criar-pagamento', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ metodo: 'blik', intentId: 'intent_' + crypto.randomUUID(), email: 'anna.kowalska@gmail.com', nome: 'Anna Kowalska', quizData: { child_name_full: 'Zosia', has_discount: 'Sim' }, obCartinha: true, ...extra }),
});
const webhook = (tipo, data, { secret = 'whsec_teste', ts = String(Math.floor(Date.now() / 1000)), id = 'evt_' + crypto.randomUUID() } = {}) => {
  const corpo = JSON.stringify({ id, type: tipo, createdAt: new Date().toISOString(), data });
  const sig = crypto.createHmac('sha256', secret).update(ts + '.').update(corpo).digest('hex');
  return realFetch(B + '/webhook/zenith', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Zenith-Event-Id': id, 'X-Zenith-Event-Type': tipo, 'X-Zenith-Timestamp': ts, 'X-Zenith-Signature': sig }, body: corpo });
};

test('sucesso: cria checkout BLIK com o total calculado no servidor (em grosze)', async () => {
  const r = await criar({ total: 1 });
  const d = await r.json();
  assert.equal(r.status, 200);
  assert.equal(d.total, 52.80);        // 84,90 − 45,00 + 12,90
  assert.equal(d.nextAction.type, 'blik');
  assert.ok(d.nextAction.clientSecret && d.nextAction.publishableKey);
  const [, ck] = [...zen.checkouts].at(-1);
  assert.equal(ck.checkout.amount, 5280);
});

test('falha: nome recusado pela Zenith volta como NOME_INVALIDO', async () => {
  zen.modo = 'recusa';
  const r = await criar();
  zen.modo = 'ok';
  assert.equal(r.status, 400);
  assert.equal((await r.json()).code, 'NOME_INVALIDO');
});

test('validação local: nome de uma palavra não chega à Zenith', async () => {
  const antes = zen.chamadasCriar;
  const r = await criar({ nome: 'Anna' });
  assert.equal(r.status, 400);
  assert.equal(zen.chamadasCriar, antes);
});

test('timeout: repete com a MESMA Idempotency-Key e não duplica', async () => {
  zen.modo = 'timeout-uma-vez';
  const antesCk = zen.checkouts.size;
  const r = await criar();
  assert.equal(r.status, 200);
  assert.equal(zen.checkouts.size, antesCk + 1);
});

test('timeout persistente: devolve INCERTO e o retry do cliente reaproveita a mesma chave', async () => {
  zen.modo = 'sempre-timeout';
  const intentId = 'intent_' + crypto.randomUUID();
  const r1 = await criar({ intentId });
  assert.equal(r1.status, 502);
  assert.equal((await r1.json()).code, 'INCERTO');
  zen.modo = 'ok';
  const antesCk = zen.checkouts.size;
  const r2 = await criar({ intentId });
  const r3 = await criar({ intentId });
  const [d2, d3] = [await r2.json(), await r3.json()];
  assert.equal(d2.id, d3.id, 'mesmo checkout nos dois retries');
  assert.equal(zen.checkouts.size, antesCk + 1, 'só um checkout criado');
});

test('retry com o mesmo intentId mas payload diferente é recusado (409)', async () => {
  const intentId = 'intent_' + crypto.randomUUID();
  assert.equal((await criar({ intentId })).status, 200);
  const r = await criar({ intentId, obExtras: true });
  assert.equal(r.status, 409);
});

test('webhook: assinatura inválida → 401 e não marca pago', async () => {
  const d = await (await criar()).json();
  const ck = zen.checkouts.get(d.id).checkout;
  const r = await webhook('payment.captured', { checkoutId: d.id, referenceId: ck.referenceId, amount: ck.amount, currency: 'PLN', status: 'captured' }, { secret: 'errado' });
  assert.equal(r.status, 401);
  const r2 = await webhook('payment.captured', { checkoutId: d.id, referenceId: ck.referenceId, amount: ck.amount, currency: 'PLN', status: 'captured' }, { ts: String(Math.floor(Date.now() / 1000) - 400) });
  assert.equal(r2.status, 401, 'timestamp antigo');
  assert.equal((await (await realFetch(B + '/status/' + d.id)).json()).status, 'pending');
});

test('webhook válido marca pago; repetido é aceite sem processar de novo', async () => {
  const d = await (await criar()).json();
  const ck = zen.checkouts.get(d.id).checkout;
  const id = 'evt_' + crypto.randomUUID();
  const dados = { checkoutId: d.id, referenceId: ck.referenceId, amount: ck.amount, currency: 'PLN', status: 'captured' };
  assert.equal((await webhook('payment.captured', dados, { id })).status, 200);
  assert.equal((await webhook('payment.captured', dados, { id })).status, 200);
  assert.equal((await (await realFetch(B + '/status/' + d.id)).json()).status, 'approved');
  const db = JSON.parse(fs.readFileSync(process.env.DATA_FILE, 'utf8'));
  const confirmados = db.logs.filter(l => l.tipo === 'pagamento_confirmado' && l.pedido === d.id);
  assert.equal(confirmados.length, 1, 'confirmado uma única vez');
});

test('webhook com valor diferente do pedido é ignorado', async () => {
  const d = await (await criar()).json();
  const ck = zen.checkouts.get(d.id).checkout;
  assert.equal((await webhook('payment.captured', { checkoutId: d.id, referenceId: ck.referenceId, amount: 1, currency: 'PLN', status: 'captured' })).status, 200);
  assert.equal((await (await realFetch(B + '/status/' + d.id)).json()).status, 'pending');
});

test('consulta GET do checkout também confirma o pagamento', async () => {
  const d = await (await criar()).json();
  zen.estado[d.id] = 'succeeded';
  assert.equal((await (await realFetch(B + '/status/' + d.id)).json()).status, 'approved');
});

test('sem secret: webhook falso dizendo "pago" NÃO marca pago (a Zenith ainda diz pending)', async () => {
  const d = await (await criar()).json();
  const antes = process.env.ZENITH_WEBHOOK_SECRET; delete process.env.ZENITH_WEBHOOK_SECRET;
  try {
    const corpo = JSON.stringify({ id: 'evt_falso', type: 'payment.captured', data: { checkoutId: d.id, status: 'captured', amount: 1, currency: 'PLN' } });
    const r = await realFetch(B + '/webhooks/zenith', { method: 'POST', headers: { 'content-type': 'application/json' }, body: corpo });
    assert.equal(r.status, 200);
    assert.equal((await (await realFetch(B + '/status/' + d.id)).json()).status, 'pending');
  } finally { process.env.ZENITH_WEBHOOK_SECRET = antes; }
});

test('sem secret: webhook em /webhooks/zenith confirma pagando quando a Zenith diz succeeded', async () => {
  const d = await (await criar()).json();
  zen.estado[d.id] = 'succeeded';
  const antes = process.env.ZENITH_WEBHOOK_SECRET; delete process.env.ZENITH_WEBHOOK_SECRET;
  try {
    const r = await realFetch(B + '/webhooks/zenith', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'payment.captured', data: { checkoutId: d.id } }) });
    assert.equal(r.status, 200);
    const db = JSON.parse(fs.readFileSync(process.env.DATA_FILE, 'utf8'));
    assert.equal(db.pedidos[d.id].status, 'pago');
    assert.ok(db.logs.some(l => l.tipo === 'pagamento_confirmado' && l.pedido === d.id && l.origem === 'webhook'));
  } finally { process.env.ZENITH_WEBHOOK_SECRET = antes; }
});

test('com secret: a URL /webhooks/zenith (plural) também valida a assinatura', async () => {
  const r = await realFetch(B + '/webhooks/zenith', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
});

// ── Cartão (Zenith Elements) ──
const sessaoCartao = (extra = {}) => realFetch(B + '/criar-sessao-cartao', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ intentId: 'intent_' + crypto.randomUUID(), email: 'anna.kowalska@gmail.com', nome: 'Anna Kowalska', quizData: { child_name_full: 'Zosia' }, obExtras: true, ...extra }),
});
const comOrigin = async (origins, fn) => { const a = process.env.ZENITH_ELEMENTS_ORIGIN; process.env.ZENITH_ELEMENTS_ORIGIN = origins; try { return await fn(); } finally { process.env.ZENITH_ELEMENTS_ORIGIN = a; } };
// checkout que a Zenith criaria quando o cliente paga com cartão no Elements
const checkoutDoCartao = (ref, amount, estado = 'succeeded') => {
  const id = 'checkout_card_' + crypto.randomBytes(3).toString('hex');
  zen.checkouts.set(id, { checkout: { id, referenceId: ref, amount, currency: 'PLN', status: estado } }); zen.estado[id] = estado;
  return id;
};

test('cartão: origin autorizada cria a sessão e devolve só os campos públicos', async () => {
  zen.originsZenith = [B];
  await comOrigin(B, async () => {
    const r = await sessaoCartao();
    const d = await r.json();
    assert.equal(r.status, 200);
    assert.equal(d.origin, B);
    assert.ok(d.elementSessionId && d.clientToken && d.elementUrl.startsWith('https://'));
    assert.equal(d.total, 104.80); // 84,90 + 19,90
    const s = zen.sessoes.at(-1);
    assert.equal(s.origin, B); assert.equal(s.amount, 10480); assert.equal(s.currency, 'PLN'); assert.equal(s.customerName, 'Anna Kowalska');
    assert.ok(!('clientSecret' in d) && !('X-API-Secret' in d));
  });
});

test('cartão: origin fora da lista do servidor é recusada sem chamar a Zenith', async () => {
  const antes = zen.sessoes.length;
  await comOrigin('https://outro.example', async () => {
    const r = await sessaoCartao();
    assert.equal(r.status, 403);
    assert.equal((await r.json()).code, 'ORIGIN_NOT_ALLOWED');
  });
  assert.equal(zen.sessoes.length, antes);
});

test('cartão: a Zenith responde ORIGIN_NOT_ALLOWED → 403 ORIGIN_NOT_ALLOWED', async () => {
  zen.originsZenith = [];
  await comOrigin(B, async () => {
    const r = await sessaoCartao();
    assert.equal(r.status, 403);
    assert.equal((await r.json()).code, 'ORIGIN_NOT_ALLOWED');
  });
  zen.originsZenith = [B];
});

test('cartão: retry da mesma tentativa devolve a mesma sessão (sem nova chamada)', async () => {
  await comOrigin(B, async () => {
    const intentId = 'intent_' + crypto.randomUUID();
    const d1 = await (await sessaoCartao({ intentId })).json();
    const antes = zen.sessoes.length;
    const d2 = await (await sessaoCartao({ intentId })).json();
    assert.equal(d1.elementSessionId, d2.elementSessionId);
    assert.equal(zen.sessoes.length, antes);
  });
});

test('cartão: timeout na sessão repete uma vez com o mesmo referenceId', async () => {
  zen.modoSessao = 'timeout-uma-vez';
  await comOrigin(B, async () => {
    const antes = zen.sessoes.length;
    const r = await sessaoCartao();
    assert.equal(r.status, 200);
    const [s1, s2] = zen.sessoes.slice(antes);
    assert.equal(s1.referenceId, s2.referenceId);
  });
});

test('cartão: checkout com outra referência não é ligado ao pedido', async () => {
  await comOrigin(B, async () => {
    const d = await (await sessaoCartao()).json();
    const alheio = checkoutDoCartao('outra-referencia', 10480);
    const r = await (await realFetch(B + '/cartao/vincular', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reference: d.reference, checkoutId: alheio }) })).json();
    assert.equal(r.ligado, false);
    assert.equal((await (await realFetch(B + '/status/' + d.reference)).json()).status, 'pending');
  });
});

test('cartão: checkout certo ligado + consulta succeeded → pago', async () => {
  await comOrigin(B, async () => {
    const d = await (await sessaoCartao()).json();
    const ck = checkoutDoCartao(d.reference, 10480);
    const r = await (await realFetch(B + '/cartao/vincular', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reference: d.reference, checkoutId: ck }) })).json();
    assert.equal(r.ligado, true);
    assert.equal((await (await realFetch(B + '/status/' + d.reference)).json()).status, 'approved');
  });
});

test('cartão: webhook assinado encontra o pedido pela referência e marca pago', async () => {
  await comOrigin(B, async () => {
    const d = await (await sessaoCartao()).json();
    const ck = checkoutDoCartao(d.reference, 10480);
    const r = await webhook('payment.captured', { checkoutId: ck, referenceId: d.reference, amount: 10480, currency: 'PLN', status: 'captured' });
    assert.equal(r.status, 200);
    assert.equal((await (await realFetch(B + '/status/' + d.reference)).json()).status, 'approved');
  });
});

test('/registrar-falha ignora campos fora da lista (o código BLIK nunca é guardado)', async () => {
  await realFetch(B + '/registrar-falha', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tipo: 'blik_rejeitado', codigo: '123456', blik: '123456', email: 'a@b.pl' }) });
  const db = JSON.parse(fs.readFileSync(process.env.DATA_FILE, 'utf8'));
  assert.ok(!JSON.stringify(db).includes('123456'));
});
