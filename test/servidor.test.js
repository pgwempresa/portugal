// Testes do fluxo completo do servidor com a Zenith simulada (sem rede nem cobrança).
// Pagamento: sessão do Zenith Elements → o cliente paga no formulário → a Zenith cria o
// checkout → o servidor liga-o ao pedido (conferindo na Zenith) e confirma por webhook/consulta.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Zenith falsa ──
const zen = { checkouts: new Map(), estado: {}, sessoes: [], originsZenith: [], modoSessao: 'ok', metodos: ['blik', 'card'] };
const realFetch = globalThis.fetch;
const json = (s, o) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, opt = {}) => {
  url = String(url);
  if (!url.startsWith('https://api.zenithworld.com.br')) return realFetch(url, opt);
  assert.ok(opt.headers['X-API-Key'] && opt.headers['X-API-Secret'], 'credenciais em falta');
  if (url.includes('/integrations/payment-methods')) return json(200, { country: 'PL', currency: 'PLN', items: zen.metodos.map(code => ({ code, category: code === 'card' ? 'card' : 'instant' })), conflicts: [] });
  if (url.endsWith('/elements/sessions')) {
    const b = JSON.parse(opt.body);
    zen.sessoes.push(b);
    if (zen.modoSessao === 'timeout-uma-vez') { zen.modoSessao = 'ok'; throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); }
    if (zen.modoSessao === 'sempre-timeout') throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    if (zen.modoSessao === 'nome-recusado') return json(400, { code: 'CUSTOMER_NAME_INVALID', message: 'customerName inválido' });
    if (!zen.originsZenith.includes(b.origin)) return json(403, { code: 'ORIGIN_NOT_ALLOWED', message: 'origin não autorizada' });
    return json(200, { elementSessionId: 'es_' + b.referenceId, clientToken: 'ct_x', elementUrl: 'https://api.zenithworld.com.br/elements/frame', sdkUrl: 'https://api.zenithworld.com.br/elements/sdk.js', expiresAt: new Date(Date.now() + 15 * 60e3).toISOString() });
  }
  const m = /\/integrations\/checkouts\/([^/?]+)$/.exec(url);
  if (m) { const r = zen.checkouts.get(m[1]); return r ? json(200, { ...r, payment: { status: zen.estado[m[1]] || 'pending', method: r.metodo } }) : json(404, {}); }
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
process.env.ZENITH_ELEMENTS_ORIGIN = B; zen.originsZenith = [B];
test.after(() => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const post = (rota, corpo) => realFetch(B + rota, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) });
const sessao = (extra = {}) => post('/criar-sessao-pagamento', { intentId: 'intent_' + crypto.randomUUID(), email: 'anna.kowalska@gmail.com', nome: 'Anna Kowalska', quizData: { child_name_full: 'Zosia', has_discount: 'Sim' }, obCartinha: true, ...extra });
const status = async ref => (await (await realFetch(B + '/status/' + ref)).json()).status;
const db = () => JSON.parse(fs.readFileSync(process.env.DATA_FILE, 'utf8'));
// checkout que a Zenith cria quando o cliente paga no formulário
const pagoNoFormulario = (ref, amount, { estado = 'succeeded', metodo = 'blik' } = {}) => {
  const id = 'checkout_' + crypto.randomBytes(4).toString('hex');
  zen.checkouts.set(id, { checkout: { id, referenceId: ref, amount, currency: 'PLN', status: estado }, metodo }); zen.estado[id] = estado;
  return id;
};
const webhook = (tipo, data, { secret = 'whsec_teste', ts = String(Math.floor(Date.now() / 1000)), id = 'evt_' + crypto.randomUUID(), rota = '/webhooks/zenith' } = {}) => {
  const corpo = JSON.stringify({ id, type: tipo, createdAt: new Date().toISOString(), data });
  const sig = crypto.createHmac('sha256', secret).update(ts + '.').update(corpo).digest('hex');
  return realFetch(B + rota, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Zenith-Event-Id': id, 'X-Zenith-Event-Type': tipo, 'X-Zenith-Timestamp': ts, 'X-Zenith-Signature': sig }, body: corpo });
};

test('sucesso: sessão com o total do servidor (grosze), origin autorizada e só campos públicos', async () => {
  const r = await sessao({ total: 1 });
  const d = await r.json();
  assert.equal(r.status, 200);
  assert.equal(d.total, 52.80); // 84,90 − 45,00 + 12,90
  assert.equal(d.origin, B);
  assert.ok(d.elementSessionId && d.clientToken && d.elementUrl.startsWith('https://'));
  const s = zen.sessoes.at(-1);
  assert.equal(s.amount, 5280); assert.equal(s.currency, 'PLN'); assert.equal(s.country, 'PL'); assert.equal(s.origin, B);
  assert.equal(s.customerName, 'Anna Kowalska'); assert.equal(s.customerEmail, 'anna.kowalska@gmail.com');
  assert.equal(db().pedidos[d.reference].metodo, 'elements');
});

test('falha: nome recusado pela Zenith volta como NOME_INVALIDO', async () => {
  zen.modoSessao = 'nome-recusado';
  const r = await sessao();
  zen.modoSessao = 'ok';
  assert.equal(r.status, 400);
  assert.equal((await r.json()).code, 'NOME_INVALIDO');
});

test('validação local: nome de uma palavra não chega à Zenith', async () => {
  const antes = zen.sessoes.length;
  assert.equal((await sessao({ nome: 'Anna' })).status, 400);
  assert.equal(zen.sessoes.length, antes);
});

test('sem nenhum método liberado na conta: 422 e não abre sessão', async () => {
  zen.metodos = [];
  const antes = zen.sessoes.length;
  // o catálogo tem cache de 10 min: força uma consulta nova pelo diagnóstico do painel
  const login = await post('/api/admin/login', { senha: 'segredo' });
  await realFetch(B + '/api/admin/pedidos', { headers: { cookie: (login.headers.get('set-cookie') || '').split(';')[0] } });
  const r = await sessao();
  zen.metodos = ['blik', 'card'];
  await realFetch(B + '/api/admin/pedidos', { headers: { cookie: (login.headers.get('set-cookie') || '').split(';')[0] } });
  assert.equal(r.status, 422);
  assert.equal(zen.sessoes.length, antes);
});

test('origin autorizada ✓ / origin fora da lista do servidor ✗ (sem chamar a Zenith)', async () => {
  assert.equal((await sessao()).status, 200);
  const antes = zen.sessoes.length;
  process.env.ZENITH_ELEMENTS_ORIGIN = 'https://outro.example';
  try {
    const r = await sessao();
    assert.equal(r.status, 403);
    assert.equal((await r.json()).code, 'ORIGIN_NOT_ALLOWED');
  } finally { process.env.ZENITH_ELEMENTS_ORIGIN = B; }
  assert.equal(zen.sessoes.length, antes);
});

test('a Zenith responde ORIGIN_NOT_ALLOWED → 403 ORIGIN_NOT_ALLOWED', async () => {
  zen.originsZenith = [];
  const r = await sessao();
  zen.originsZenith = [B];
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, 'ORIGIN_NOT_ALLOWED');
});

test('retry da mesma tentativa devolve a mesma sessão (sem nova chamada); dados diferentes → 409', async () => {
  const intentId = 'intent_' + crypto.randomUUID();
  const d1 = await (await sessao({ intentId })).json();
  const antes = zen.sessoes.length;
  const d2 = await (await sessao({ intentId })).json();
  assert.equal(d1.elementSessionId, d2.elementSessionId);
  assert.equal(zen.sessoes.length, antes);
  assert.equal((await sessao({ intentId, obExtras: true })).status, 409);
});

test('timeout: repete uma vez com o mesmo referenceId', async () => {
  zen.modoSessao = 'timeout-uma-vez';
  const antes = zen.sessoes.length;
  assert.equal((await sessao()).status, 200);
  const [s1, s2] = zen.sessoes.slice(antes);
  assert.equal(s1.referenceId, s2.referenceId);
});

test('timeout persistente: INCERTO; o retry do cliente reaproveita a referência (não duplica)', async () => {
  zen.modoSessao = 'sempre-timeout';
  const intentId = 'intent_' + crypto.randomUUID();
  const antes = zen.sessoes.length;
  const r1 = await sessao({ intentId });
  zen.modoSessao = 'ok';
  assert.equal(r1.status, 502);
  assert.equal((await r1.json()).code, 'INCERTO');
  const d = await (await sessao({ intentId })).json();
  const refs = new Set(zen.sessoes.slice(antes).map(s => s.referenceId));
  assert.equal(refs.size, 1, 'mesma referência em todas as tentativas');
  assert.ok(refs.has(d.reference));
});

test('checkout com outra referência não é ligado ao pedido', async () => {
  const d = await (await sessao()).json();
  const alheio = pagoNoFormulario('outra-referencia', 5280);
  assert.equal((await (await post('/pagamento/vincular', { reference: d.reference, checkoutId: alheio })).json()).ligado, false);
  assert.equal(await status(d.reference), 'pending');
});

test('pago com BLIK no formulário: ligado + consulta succeeded → pago, com o método guardado', async () => {
  const d = await (await sessao()).json();
  const ck = pagoNoFormulario(d.reference, 5280, { metodo: 'blik' });
  assert.equal((await (await post('/pagamento/vincular', { reference: d.reference, checkoutId: ck })).json()).ligado, true);
  assert.equal(await status(d.reference), 'approved');
  assert.equal(db().pedidos[d.reference].metodoPago, 'blik');
});

test('BLIK por redirecionamento: o cliente não volta ao site, o webhook conta como pagamento gerado e pago', async () => {
  const d = await (await sessao()).json();
  const ck = pagoNoFormulario(d.reference, 5280, { estado: 'pending', metodo: 'blik' });
  // nenhum /pagamento/vincular: o cliente foi para o banco e fechou a página
  const dados = { checkoutId: ck, referenceId: d.reference, amount: 5280, currency: 'PLN', status: 'captured' };
  assert.equal((await webhook('payment.captured', dados)).status, 200);
  const p = db().pedidos[d.reference];
  assert.equal(p.status, 'pago');
  assert.equal(p.metaEnviado, true);
  assert.equal(p.checkoutId, ck);
  const gerados = db().logs.filter(l => l.tipo === 'pagamento_gerado' && l.pedido === d.reference);
  assert.equal(gerados.length, 1);
  // o cliente volta depois: não conta duas vezes
  await post('/pagamento/vincular', { reference: d.reference, checkoutId: ck });
  assert.equal(db().logs.filter(l => l.tipo === 'pagamento_gerado' && l.pedido === d.reference).length, 1);
});

test('BLIK enviado sem id do checkout: conta como pagamento gerado (uma vez), continua pendente', async () => {
  const d = await (await sessao()).json();
  await post('/pagamento/vincular', { reference: d.reference });
  await post('/pagamento/vincular', { reference: d.reference });
  assert.equal(db().logs.filter(l => l.tipo === 'pagamento_gerado' && l.pedido === d.reference).length, 1);
  assert.equal(db().pedidos[d.reference].status, 'pendente');
  assert.equal(await status(d.reference), 'pending');
});

test('webhook: assinatura inválida ou antiga → 401 e não marca pago', async () => {
  const d = await (await sessao()).json();
  const ck = pagoNoFormulario(d.reference, 5280, { estado: 'pending' });
  const dados = { checkoutId: ck, referenceId: d.reference, amount: 5280, currency: 'PLN', status: 'captured' };
  assert.equal((await webhook('payment.captured', dados, { secret: 'errado' })).status, 401);
  assert.equal((await webhook('payment.captured', dados, { ts: String(Math.floor(Date.now() / 1000) - 400) })).status, 401);
  assert.equal(await status(d.reference), 'pending');
});

test('webhook válido marca pago (pela referência); repetido é aceite sem processar de novo', async () => {
  const d = await (await sessao()).json();
  const ck = pagoNoFormulario(d.reference, 5280, { estado: 'pending' });
  const id = 'evt_' + crypto.randomUUID();
  const dados = { checkoutId: ck, referenceId: d.reference, amount: 5280, currency: 'PLN', status: 'captured' };
  assert.equal((await webhook('payment.captured', dados, { id })).status, 200);
  assert.equal((await webhook('payment.captured', dados, { id })).status, 200);
  assert.equal(await status(d.reference), 'approved');
  assert.equal(db().logs.filter(l => l.tipo === 'pagamento_confirmado' && l.pedido === d.reference).length, 1, 'confirmado uma única vez');
});

test('webhook com valor diferente do pedido é ignorado', async () => {
  const d = await (await sessao()).json();
  const ck = pagoNoFormulario(d.reference, 5280, { estado: 'pending' });
  assert.equal((await webhook('payment.captured', { checkoutId: ck, referenceId: d.reference, amount: 1, currency: 'PLN', status: 'captured' })).status, 200);
  assert.equal(await status(d.reference), 'pending');
});

test('sem secret: webhook falso dizendo "pago" NÃO marca pago (a Zenith ainda diz pending)', async () => {
  const d = await (await sessao()).json();
  const ck = pagoNoFormulario(d.reference, 5280, { estado: 'pending' });
  const antes = process.env.ZENITH_WEBHOOK_SECRET; delete process.env.ZENITH_WEBHOOK_SECRET;
  try {
    const r = await post('/webhooks/zenith', { id: 'evt_falso', type: 'payment.captured', data: { checkoutId: ck, referenceId: d.reference, status: 'captured' } });
    assert.equal(r.status, 200);
    assert.equal(await status(d.reference), 'pending');
  } finally { process.env.ZENITH_WEBHOOK_SECRET = antes; }
});

test('sem secret: webhook confirma quando a Zenith, consultada, diz succeeded', async () => {
  const d = await (await sessao()).json();
  const ck = pagoNoFormulario(d.reference, 5280);
  const antes = process.env.ZENITH_WEBHOOK_SECRET; delete process.env.ZENITH_WEBHOOK_SECRET;
  try {
    assert.equal((await post('/webhooks/zenith', { type: 'payment.captured', data: { checkoutId: ck, referenceId: d.reference } })).status, 200);
    assert.equal(db().pedidos[d.reference].status, 'pago');
  } finally { process.env.ZENITH_WEBHOOK_SECRET = antes; }
});

test('com secret: a URL /webhooks/zenith (plural) e /webhook/zenith validam a assinatura', async () => {
  assert.equal((await post('/webhooks/zenith', {})).status, 401);
  assert.equal((await post('/webhook/zenith', {})).status, 401);
});

test('/registrar-falha ignora campos fora da lista', async () => {
  await post('/registrar-falha', { tipo: 'pagamento_falhou', numeroCartao: '4242424242424242', cvc: '123', email: 'a@b.pl' });
  const t = JSON.stringify(db());
  assert.ok(!t.includes('4242424242424242') && !t.includes('"cvc"'));
});

test('a rota antiga do BLIK direto já não existe', async () => {
  assert.equal((await post('/criar-pagamento', {})).status, 404);
});
