// Testes do cliente Zenith (sem rede: fetch injetado)
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { criarZenith, validarWebhook, mapearEstado, ZenithError, escolherOrigin, lerOrigins } from '../zenith.js';

const resposta = (status, corpo) => new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });

test('envia as credenciais nos cabeçalhos (só no backend)', async () => {
  let visto;
  const z = criarZenith({ publicKey: 'pub', secretKey: 'sec', fetch: async (url, opt) => { visto = { url, opt }; return resposta(200, { checkout: { id: 'checkout_1' } }); } });
  const r = await z.checkout('checkout_1');
  assert.equal(r.checkout.id, 'checkout_1');
  assert.equal(visto.url, 'https://api.zenithworld.com.br/integrations/checkouts/checkout_1');
  assert.equal(visto.opt.headers['X-API-Key'], 'pub');
  assert.equal(visto.opt.headers['X-API-Secret'], 'sec');
});

test('catálogo consulta país, moeda e ambiente', async () => {
  let url;
  const z = criarZenith({ publicKey: 'p', secretKey: 's', fetch: async u => { url = u; return resposta(200, { items: [{ code: 'blik' }] }); } });
  await z.metodos({ country: 'PL', currency: 'PLN', environment: 'production' });
  assert.match(url, /\/integrations\/payment-methods\?country=PL&currency=PLN&environment=production$/);
});

test('4xx vira ZenithError com código e não é incerto', async () => {
  const z = criarZenith({ publicKey: 'p', secretKey: 's', fetch: async () => resposta(400, { code: 'CUSTOMER_NAME_INVALID', message: 'nome' }) });
  await assert.rejects(z.sessaoElements({}), e => e instanceof ZenithError && e.code === 'CUSTOMER_NAME_INVALID' && e.http === 400 && !e.incerto);
});

test('5xx e timeout são resultado incerto', async () => {
  const z5 = criarZenith({ publicKey: 'p', secretKey: 's', fetch: async () => resposta(503, {}) });
  await assert.rejects(z5.sessaoElements({}), e => e.incerto && e.http === 503);
  const zt = criarZenith({ publicKey: 'p', secretKey: 's', timeoutMs: 30, fetch: (u, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(o.signal.reason))) });
  await assert.rejects(zt.sessaoElements({}), e => e.incerto && e.code === 'TIMEOUT');
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

test('estados públicos da Zenith', () => {
  assert.equal(mapearEstado('succeeded'), 'approved');
  assert.equal(mapearEstado('authorized'), 'pending');
  assert.equal(mapearEstado('failed'), 'rejected');
  assert.equal(mapearEstado('canceled'), 'expired');
});

test('Elements: sessão vai para /elements/sessions com as credenciais', async () => {
  let visto;
  const z = criarZenith({ publicKey: 'p', secretKey: 's', fetch: async (url, opt) => { visto = { url, opt }; return resposta(200, { elementSessionId: 'es_1', clientToken: 'ct', elementUrl: 'https://x' }); } });
  const r = await z.sessaoElements({ referenceId: 'r1', origin: 'https://twojahistoria.vercel.app' });
  assert.equal(r.elementSessionId, 'es_1');
  assert.equal(visto.url, 'https://api.zenithworld.com.br/elements/sessions');
  assert.equal(JSON.parse(visto.opt.body).origin, 'https://twojahistoria.vercel.app');
});

test('origins: só HTTPS exata (sem path, query ou wildcard), localhost em http', () => {
  assert.deepEqual(lerOrigins('https://twojahistoria.vercel.app'), ['https://twojahistoria.vercel.app']);
  assert.deepEqual(lerOrigins('https://a.pl/, http://localhost:3000, https://b.pl/checkout, http://inseguro.pl, https://*.pl'), ['https://a.pl', 'http://localhost:3000']);
  const ok = ['https://twojahistoria.vercel.app'];
  assert.equal(escolherOrigin('https://twojahistoria.vercel.app', ok), 'https://twojahistoria.vercel.app');
  assert.equal(escolherOrigin('https://twojahistoria.vercel.app/qualquer?x=1', ok), 'https://twojahistoria.vercel.app');
  assert.equal(escolherOrigin('https://outro.vercel.app', ok), null);
  assert.equal(escolherOrigin('http://twojahistoria.vercel.app', ok), null);
  assert.equal(escolherOrigin('lixo', ok), null);
});
