import http from 'http';
import { startProxy } from '../src/proxy.js';

const proxyPort = 18088;
const backendPort = 18089;
const apiKey = 'testkey';
const backendPassword = 'backendpass';
const sessionStore = new Map();
let activePrompts = 0;
let maxObservedPrompts = 0;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => body += chunk);
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', Buffer.byteLength(text));
  res.end(text);
}

function get(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: proxyPort, path, timeout: 10000, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`timeout GET ${path}`)));
  });
}

function post(path, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      path,
      method: 'POST',
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers
      }
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => text += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`timeout POST ${path}`)));
    req.write(body);
    req.end();
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseBody(result) {
  try {
    return result.body ? JSON.parse(result.body) : {};
  } catch (error) {
    throw new Error(`invalid JSON body: ${error.message}; raw=${result.body}`);
  }
}

function printCheck(name, details) {
  console.log(`OK ${name}${details ? ` :: ${details}` : ''}`);
}

const backendServer = http.createServer(async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const expected = `Basic ${Buffer.from(`opencode:${backendPassword}`).toString('base64')}`;
    const url = new URL(req.url, `http://127.0.0.1:${backendPort}`);

    if (url.pathname === '/health') {
      if (auth !== expected) return sendJson(res, 401, { error: 'unauthorized' });
      return sendJson(res, 200, { status: 'ok' });
    }

    if (url.pathname === '/config/providers' && req.method === 'GET') {
      return sendJson(res, 200, {
        providers: [
          {
            id: 'opencode',
            models: {
              'kimi-k2.5-free': { name: 'Kimi K2.5 Free', release_date: '2024-01-15' }
            }
          }
        ]
      });
    }

    if (url.pathname === '/config' && req.method === 'PATCH') {
      await readJson(req);
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === '/session' && req.method === 'POST') {
      const id = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      sessionStore.set(id, { assistantReadyAt: 0, responseText: '', reasoningText: '' });
      return sendJson(res, 200, { id });
    }

    const messageMatch = url.pathname.match(/^\/session\/([^/]+)\/message$/);
    if (messageMatch && req.method === 'POST') {
      const sessionId = messageMatch[1];
      const body = await readJson(req);
      activePrompts += 1;
      maxObservedPrompts = Math.max(maxObservedPrompts, activePrompts);
      const textPrompt = Array.isArray(body.parts)
        ? body.parts.filter((part) => part.type === 'text').map((part) => part.text || '').join('\n')
        : '';
      const responseText = textPrompt.includes('SECOND')
        ? 'Smoke reply SECOND'
        : textPrompt.includes('responses')
          ? 'Smoke response API'
          : 'Smoke chat API';
      const reasoningText = textPrompt.includes('reasoning') ? 'Mock reasoning path' : '';
      const current = sessionStore.get(sessionId) || {};
      current.responseText = responseText;
      current.reasoningText = reasoningText;
      current.assistantReadyAt = Date.now() + 700;
      sessionStore.set(sessionId, current);
      await delay(700);
      activePrompts -= 1;
      return sendJson(res, 200, {
        parts: [
          ...(reasoningText ? [{ type: 'reasoning', text: reasoningText }] : []),
          { type: 'text', text: responseText }
        ]
      });
    }

    if (messageMatch && req.method === 'GET') {
      const sessionId = messageMatch[1];
      const current = sessionStore.get(sessionId);
      if (!current) return sendJson(res, 404, { error: 'session not found' });
      const ready = Date.now() >= current.assistantReadyAt;
      return sendJson(res, 200, ready ? [{
        info: { role: 'assistant', finish: 'stop' },
        parts: [
          ...(current.reasoningText ? [{ type: 'reasoning', text: current.reasoningText }] : []),
          { type: 'text', text: current.responseText }
        ]
      }] : []);
    }

    const deleteMatch = url.pathname.match(/^\/session\/([^/]+)$/);
    if (deleteMatch && req.method === 'DELETE') {
      sessionStore.delete(deleteMatch[1]);
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { error: `unhandled ${req.method} ${url.pathname}` });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

async function main() {
  await new Promise((resolve) => backendServer.listen(backendPort, '127.0.0.1', resolve));
  const proxy = startProxy({
    PORT: proxyPort,
    BIND_HOST: '127.0.0.1',
    MANAGE_BACKEND: false,
    OPENCODE_SERVER_URL: `http://127.0.0.1:${backendPort}`,
    OPENCODE_SERVER_PASSWORD: backendPassword,
    API_KEY: apiKey,
    MODEL_CACHE_MS: 12345,
    MAX_CONCURRENT_REQUESTS: 1,
    REQUEST_TIMEOUT_MS: 5000,
    DEBUG: true
  });

  try {
    await delay(500);

    const health = await get('/health');
    const healthBody = parseBody(health);
    assert(health.status === 200, `health expected 200 got ${health.status}`);
    assert(healthBody.status === 'ok', `health status expected ok got ${healthBody.status}`);
    printCheck('health', `status=${healthBody.status}`);

    const models = await get('/v1/models', {
      Authorization: `Bearer ${apiKey}`,
      'x-request-id': 'smoke_models_req'
    });
    const modelsBody = parseBody(models);
    assert(models.status === 200, `models expected 200 got ${models.status}`);
    assert(models.headers['x-request-id'] === 'smoke_models_req', 'models x-request-id not echoed');
    assert(Array.isArray(modelsBody.data) && modelsBody.data[0]?.id === 'opencode/kimi-k2.5-free', 'models payload unexpected');
    printCheck('models', `requestId=${models.headers['x-request-id']}`);

    const chat = await post('/v1/chat/completions', {
      model: 'opencode/kimi-k2.5-free',
      messages: [{ role: 'user', content: 'hello with reasoning' }]
    }, {
      Authorization: `Bearer ${apiKey}`,
      'x-request-id': 'smoke_chat_req'
    });
    const chatBody = parseBody(chat);
    assert(chat.status === 200, `chat expected 200 got ${chat.status}`);
    assert(chat.headers['x-request-id'] === 'smoke_chat_req', 'chat x-request-id not echoed');
    assert(chatBody.object === 'chat.completion', `chat object unexpected ${chatBody.object}`);
    assert((chatBody.choices?.[0]?.message?.content || '').includes('Smoke chat API'), 'chat content missing');
    assert((chatBody.choices?.[0]?.message?.content || '').includes('<think>'), 'chat reasoning wrapper missing');
    printCheck('chat completions', `requestId=${chat.headers['x-request-id']}`);

    const responses = await post('/v1/responses', {
      model: 'opencode/kimi-k2.5-free',
      input: 'hello from responses'
    }, {
      Authorization: `Bearer ${apiKey}`,
      'x-request-id': 'smoke_responses_req'
    });
    const responsesBody = parseBody(responses);
    assert(responses.status === 200, `responses expected 200 got ${responses.status}`);
    assert(responses.headers['x-request-id'] === 'smoke_responses_req', 'responses x-request-id not echoed');
    assert(responsesBody.object === 'response', `responses object unexpected ${responsesBody.object}`);
    assert((responsesBody.output?.[0]?.content?.[0]?.text || '').includes('Smoke response API'), 'responses content missing');
    printCheck('responses', `requestId=${responses.headers['x-request-id']}`);

    const concurrent = await Promise.all([
      post('/v1/chat/completions', {
        model: 'opencode/kimi-k2.5-free',
        messages: [{ role: 'user', content: 'FIRST slow request' }]
      }, { Authorization: `Bearer ${apiKey}`, 'x-request-id': 'smoke_limit_first' }),
      post('/v1/chat/completions', {
        model: 'opencode/kimi-k2.5-free',
        messages: [{ role: 'user', content: 'SECOND slow request' }]
      }, { Authorization: `Bearer ${apiKey}`, 'x-request-id': 'smoke_limit_second' })
    ]);

    const first = concurrent.find((item) => item.headers['x-request-id'] === 'smoke_limit_first');
    const second = concurrent.find((item) => item.headers['x-request-id'] === 'smoke_limit_second');
    const firstBody = parseBody(first);
    const secondBody = parseBody(second);
    const got429 = [first, second].some((item) => item.status === 429);
    const got200 = [first, second].some((item) => item.status === 200);
    assert(got429, 'expected one concurrent request to be rate-limited');
    assert(got200, 'expected one concurrent request to succeed');
    const limited = first.status === 429 ? firstBody : secondBody;
    assert(limited.error?.type === 'rate_limit_exceeded', 'rate limit error type unexpected');
    assert(maxObservedPrompts === 1, `backend saw concurrent prompts: ${maxObservedPrompts}`);
    printCheck('concurrency limit', `maxObservedPrompts=${maxObservedPrompts}`);

    console.log('SMOKE_RESULT PASS');
  } finally {
    await new Promise((resolve) => proxy.server.close(resolve));
    await new Promise((resolve) => backendServer.close(resolve));
  }
}

main().catch((error) => {
  console.error('SMOKE_RESULT FAIL', error.message);
  backendServer.close(() => process.exit(1));
});
