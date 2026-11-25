/**
 * 레슨카드 Pro — 결제 승인 · 이용권 코드 서버 (초경량 서드리스 함수)
 *
 * 이 파일 하나로 Cloudflare Workers에 그대로 붙여넣어 배포할 수 있습니다.
 * (Vercel로 올릴 때는 같은 폴더 `vercel/api/[...path].js` 어댑터가 이 파일을 그대로 씁니다.)
 *
 * ── 필요한 환경변수 ─────────────────────────────────────────
 *   TOSS_SECRET_KEY  (필수) 토스페이먼츠 개발자센터 > API 키 > 시크릿 키 (live_sk_… / test_sk_…)
 *                            ※ 절대 프론트엔드(index.html)에 넣지 마세요. 여기 서버에만.
 *   LICENSE_SECRET   (선택) 이용권 코드 서명용 비밀키. 비워 두면 TOSS_SECRET_KEY에서 자동으로 만듭니다.
 *   ALLOWED_ORIGINS  (선택) 허용할 웹사이트 주소. 쉼표로 여러 개. 기본값에 lessoncard.kr이 들어 있습니다.
 *
 * ── 라우트 ─────────────────────────────────────────────────
 *   GET  /health   → { ok: true }                      배포 확인용
 *   POST /confirm  → { paymentKey, orderId, amount }   토스 결제 승인 + 이용권 코드 발급
 *   POST /license  → { code }                          다른 기기에서 이용권 코드 검증
 *
 * ── 결제 금액은 이 파일의 PRICES가 기준입니다. ────────────────
 *   프론트엔드에서 금액을 조작해도 여기 표와 다르면 승인하지 않습니다.
 */

const PRICES = {
  monthly: { amount: 4900, days: 30, orderName: '레슨카드 Pro 1개월 이용권' },
  yearly: { amount: 49000, days: 365, orderName: '레슨카드 Pro 1년 이용권' },
};

const DEFAULT_ORIGINS = ['https://lessoncard.kr', 'https://www.lessoncard.kr'];
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford Base32 (헷갈리는 I·L·O·U 제외)
const DAY = 86400000;
const EPOCH_DAYS = Date.UTC(2020, 0, 1);

export default {
  async fetch(request, env) {
    try {
      return await route(request, env || {});
    } catch (err) {
      return json({ ok: false, message: '서버 오류가 났어요', detail: String(err && err.message || err) }, 500, request, env || {});
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (request.method === 'OPTIONS') return corsPreflight(request, env);

  if (path === '/' || path === '/health') {
    return json({ ok: true, service: 'lessoncard-payments', time: new Date().toISOString() }, 200, request, env);
  }
  if (path === '/confirm') {
    if (request.method !== 'POST') return json({ ok: false, message: 'POST로 요청해 주세요' }, 405, request, env);
    return confirmPayment(await readBody(request), env, request);
  }
  if (path === '/license') {
    if (request.method !== 'POST') return json({ ok: false, message: 'POST로 요청해 주세요' }, 405, request, env);
    return verifyLicense(await readBody(request), env, request);
  }
  return json({ ok: false, message: '없는 주소예요' }, 404, request, env);
}

/* ── 결제 승인 ───────────────────────────────────────────── */
async function confirmPayment(body, env, request) {
  const paymentKey = body && body.paymentKey;
  const orderId = body && body.orderId;
  const amount = Number(body && body.amount);

  if (!paymentKey || !orderId || !amount) {
    return json({ ok: false, message: 'paymentKey · orderId · amount가 필요해요' }, 400, request, env);
  }
  const cycle = cycleOf(orderId);
  if (!cycle) return json({ ok: false, message: '알 수 없는 주문 번호예요' }, 400, request, env);

  const plan = PRICES[cycle];
  if (amount !== plan.amount) {
    return json({ ok: false, message: '결제 금액이 상품 금액과 달라요' }, 400, request, env);
  }
  if (!env.TOSS_SECRET_KEY) {
    return json({ ok: false, message: '서버에 TOSS_SECRET_KEY가 설정되지 않았어요' }, 500, request, env);
  }

  // 1) 토스 결제 승인
  const res = await toss(`/v1/payments/confirm`, {
    method: 'POST',
    headers: { 'Idempotency-Key': orderId },
    body: JSON.stringify({ paymentKey, orderId, amount }),
  }, env);
  let pay = res.data;

  if (!res.ok) {
    // 이미 승인된 결제(새로고침·중복 클릭)라면 결제를 조회해 같은 이용권 코드를 다시 발급한다.
    if (pay && (pay.code === 'ALREADY_PROCESSED_PAYMENT' || pay.code === 'IDEMPOTENT_REQUEST_PROCESSING')) {
      const got = await toss('/v1/payments/' + encodeURIComponent(paymentKey), { method: 'GET' }, env);
      if (got.ok && got.data && got.data.status === 'DONE' && Number(got.data.totalAmount) === plan.amount) {
        return issue(got.data, cycle, env, request);
      }
    }
    return json({
      ok: false,
      message: (pay && pay.message) || '결제 승인에 실패했어요',
      code: (pay && pay.code) || 'CONFIRM_FAILED',
    }, 402, request, env);
  }

  if (!pay || pay.status !== 'DONE' || Number(pay.totalAmount) !== plan.amount || pay.orderId !== orderId) {
    return json({ ok: false, message: '결제 상태가 완료가 아니에요', code: 'PAYMENT_NOT_DONE' }, 409, request, env);
  }
  return issue(pay, cycle, env, request);
}

/* ── 이용권 코드 발급 ────────────────────────────────────── */
async function issue(pay, cycle, env, request) {
  const plan = PRICES[cycle];
  const approvedAt = Date.parse(pay.approvedAt || new Date().toISOString());
  const base = isNaN(approvedAt) ? Date.now() : approvedAt;
  const expiresMs = base + plan.days * DAY;
  const code = await signCode(cycle, expiresMs, pay.orderId || pay.paymentKey, await licenseKey(env));

  return json({
    ok: true,
    plan: 'pro',
    cycle,
    orderName: plan.orderName,
    orderId: pay.orderId || null,
    paymentKey: pay.paymentKey || null,
    method: pay.method || null,
    approvedAt: new Date(base).toISOString(),
    expiresAt: new Date(expiresMs).toISOString(),
    licenseCode: code,
  }, 200, request, env);
}

/* ── 이용권 코드 검증 ────────────────────────────────────── */
async function verifyLicense(body, env, request) {
  const raw = String((body && body.code) || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  const m = /^LC1([MY])([0-9A-Z]{3})([0-9A-Z]{4})([0-9A-Z]{8})$/.exec(raw);
  if (!m) return json({ ok: false, message: '이용권 코드 형식이 아니에요' }, 400, request, env);

  const key = await licenseKey(env);
  const payload = m[1] + m[2] + m[3];
  const expect = await hmac32(payload, key, 8);
  if (expect !== m[4]) return json({ ok: false, message: '사용할 수 없는 코드예요' }, 400, request, env);

  const days = unpad32(m[2]);
  if (isNaN(days)) return json({ ok: false, message: '이용권 코드 형식이 아니에요' }, 400, request, env);
  const expiresMs = EPOCH_DAYS + days * DAY;
  if (expiresMs < Date.now()) {
    return json({ ok: false, expired: true, message: '이용 기간이 끝난 코드예요' }, 410, request, env);
  }
  return json({ ok: true, plan: 'pro', cycle: m[1] === 'Y' ? 'yearly' : 'monthly', expiresAt: new Date(expiresMs).toISOString() }, 200, request, env);
}

/* ── 코드 = LC1 + 이용권(M/Y) + 만료일(3) + 주문해시(4) + 서명(8) ── */
async function signCode(cycle, expiresMs, orderId, key) {
  const days = Math.floor((expiresMs - EPOCH_DAYS) / DAY);
  if (days < 0 || days >= 32 ** 3) throw new Error('만료일 범위를 벗어났어요');
  const payload = (cycle === 'yearly' ? 'Y' : 'M') + pad32(days, 3) + (await hmac32(String(orderId), key, 4));
  return 'LC1' + payload.slice(0, 5) + '-' + payload.slice(5) + '-' + (await hmac32(payload, key, 8));
}

async function licenseKey(env) {
  const secret = env.LICENSE_SECRET || env.TOSS_SECRET_KEY || '';
  if (!secret) throw new Error('서명 키가 없어요');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('lessoncard-license-v1:' + secret));
  return new Uint8Array(digest);
}

async function hmac32(text, keyBytes, len) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
  let out = '';
  let bits = 0, buf = 0;
  for (let i = 0; i < sig.length && out.length < len; i++) {
    buf = (buf << 8) | sig[i];
    bits += 8;
    while (bits >= 5 && out.length < len) {
      out += B32[(buf >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

function unpad32(s) {
  let n = 0;
  for (const ch of s) {
    const i = B32.indexOf(ch);
    if (i < 0) return NaN;
    n = n * 32 + i;
  }
  return n;
}

function pad32(n, len) {
  let s = '';
  do { s = B32[n % 32] + s; n = Math.floor(n / 32); } while (n > 0);
  return s.padStart(len, '0');
}

function cycleOf(orderId) {
  const m = /^lc-(monthly|yearly)-/i.exec(String(orderId || ''));
  return m ? m[1].toLowerCase() : null;
}

/* ── 토스 API 호출 ───────────────────────────────────────── */
async function toss(path, init, env) {
  const res = await fetch('https://api.tosspayments.com' + path, {
    ...init,
    headers: {
      Authorization: 'Basic ' + btoa(env.TOSS_SECRET_KEY + ':'),
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  return { ok: res.ok, status: res.status, data };
}

/* ── 응답 · CORS ─────────────────────────────────────────── */
function allowedOrigins(env) {
  const extra = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return new Set(DEFAULT_ORIGINS.concat(extra));
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const headers = { 'Vary': 'Origin' };
  if (origin && allowedOrigins(env).has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
    headers['Access-Control-Max-Age'] = '86400';
  }
  return headers;
}

function corsPreflight(request, env) {
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}

function json(obj, status, request, env) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders(request, env) },
  });
}

async function readBody(request) {
  try { return await request.json(); } catch (e) { return {}; }
}
