/**
 * Vercel용 초경량 어댑터 — 같은 폴더의 `../../confirm.js`(Worker 본체)를 그대로 사용합니다.
 * Vercel 프로젝트 루트가 `serverless/vercel` 이면 이 파일이 /api/confirm · /api/license · /api/health 로 연결됩니다.
 *
 * 환경변수(Project Settings > Environment Variables):
 *   TOSS_SECRET_KEY (필수), LICENSE_SECRET (선택), ALLOWED_ORIGINS (선택)
 */
import worker from '../../confirm.js';

export default async function handler(req, res) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const url = proto + '://' + (req.headers.host || 'localhost') + (req.url || '/');

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue;
    headers.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = Buffer.concat(chunks);
  }

  const response = await worker.fetch(new Request(url, { method: req.method, headers, body }), process.env);
  res.status(response.status);
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.send(Buffer.from(await response.arrayBuffer()));
}
