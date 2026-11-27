// Testes do cliente Zenith (sem rede: fetch injetado)
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { criarZenith, validarWebhook, mapearEstado, nextActionPublica, ZenithError } from '../zenith.js';

const resposta = (status, corpo) => new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });

test('envia credenciais e Idempotency-Key nos cabeçalhos', async () => {
  let visto;
  const z = criarZenith({ publicKey: 'pub', secretKey: 'sec', fetch: async (url, opt) => { visto = { url, opt }; return resposta(200, { checkout: { id: 'checkout_1' } }); } });
  const r = await z.criarCheckout({ amount: 100 }, 'chave-123456');
  assert.equal(r.checkout.id, 'checkout_1');
  assert.equal(visto.url, 'https://api.zenithworld.com.br/integrations/checkouts');
  assert.equal(visto.opt.headers['X-API-Key'], 'pub');
  assert.equal(visto.opt.headers['X-API-Secret'], 'sec');
  assert.equal(visto.opt.headers['Idempotency-Key'], 'chave-123456');
});

test('catálogo consulta país, moeda e ambiente', async () => {
  let url;
  const z = criarZenith({ publicKey: 'p', secretKey: 's', fetch: async u => { url = u; return resposta(200, { items: [{ code: 'blik' }] }); } });
  await z.metodos({ country: 'PL', currency: 'PLN', environment: 'production' });
  assert.match(url, /\/integrations\/payment-methods\?country=PL&currency=PLN&environment=production$/);
});

test('4xx vira ZenithError com código e não é incerto', async () => {
  const z = criarZenith({ publicKey: 'p', secretKey: 's', fetch: async () => resposta(400, { code: 'CUSTOMER_NAME_INVALID', message: 'nome' }) });
  await assert.rejects(z.criarCheckout({}, 'chave-123456'), e => e instanceof ZenithError && e.code === 'CUSTOMER_NAME_INVALID' && e.http === 400 && !e.incerto);
});

test('5xx e timeout são resultado incerto', async () => {
  const z5 = criarZenith({ publicKey: 'p', secretKey: 's', fetch: async () => resposta(503, {}) });
  await assert.rejects(z5.criarCheckout({}, 'chave-123456'), e => e.incerto && e.http === 503);
  const zt = criarZenith({ publicKey: 'p', secretKey: 's', timeoutMs: 30, fetch: (u, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(o.signal.reason))) });
  await assert.rejects(zt.criarCheckout({}, 'chave-123456'), e => e.incerto && e.code === 'TIMEOUT');
});

test('Idempotency-Key fora de 8–120 caracteres é recusada antes da rede', async () => {
  const z = criarZenith({ publicKey: 'p', secretKey: 's', fetch: async () => { throw new Error('não devia chamar'); } });
  assert.throws(() => z.criarCheckout({}, 'curta'), e => e.code === 'IDEMPOTENCY_KEY_INVALID');
});

test('sem credenciais não chama a rede', async () => {
  const z = criarZenith({ publicKey: '', secretKey: '', fetch: async () => { throw new Error('não devia chamar'); } });
  await assert.rejects(z.checkout('x'), e => e.code === 'ZENITH_SEM_CREDENCIAIS');
});

const assinar = (ts, corpo, secret) => crypto.createHmac('sha256', secret).update(ts + '.').update(corpo).digest('hex');

test('webhook: assinatura válida, inválida e fora do prazo', () => {
  const corpo = '{"id":"evt_1"}', secret = 'whsec_teste', agoraMs = 1_800_000_000_000, ts = String(agoraMs / 1000);
  const sig = assinar(ts, corpo, secret);
  assert.deepEqual(validarWebhook({ rawBody: corpo, timestamp: ts, signature: sig, secret, agoraMs }), { ok: true });
  assert.deepEqual(validarWebhook({ rawBody: corpo, timestamp: ts, signature: 'sha256=' + sig, secret, agoraMs }), { ok: true });
  assert.equal(validarWebhook({ rawBody: corpo + ' ', timestamp: ts, signature: sig, secret, agoraMs }).motivo, 'assinatura');
  assert.equal(validarWebhook({ rawBody: corpo, timestamp: ts, signature: sig, secret: 'outro', agoraMs }).motivo, 'assinatura');
  assert.equal(validarWebhook({ rawBody: corpo, timestamp: ts, signature: sig, secret, agoraMs: agoraMs + 301_000 }).motivo, 'fora_do_prazo');
  assert.equal(validarWebhook({ rawBody: corpo, timestamp: '', signature: sig, secret, agoraMs }).motivo, 'sem_cabecalhos');
  assert.equal(validarWebhook({ rawBody: corpo, timestamp: ts, signature: sig, secret: '', agoraMs }).motivo, 'sem_secret');
});

test('estados e nextAction públicos', () => {
  assert.equal(mapearEstado('succeeded'), 'approved');
  assert.equal(mapearEstado('authorized'), 'pending');
  assert.equal(mapearEstado('failed'), 'rejected');
  assert.equal(mapearEstado('canceled'), 'expired');
  assert.deepEqual(nextActionPublica({ type: 'blik', clientSecret: 'cs', publishableKey: 'pk', segredo: 'x' }), { type: 'blik', clientSecret: 'cs', publishableKey: 'pk' });
  assert.equal(nextActionPublica({ type: 'redirect', url: 'http://inseguro' }).url, undefined);
  assert.equal(nextActionPublica({ type: 'redirect', url: 'https://ok.example/x' }).url, 'https://ok.example/x');
});
