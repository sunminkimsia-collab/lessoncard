# 레슨카드 Pro 결제 서버 (초경량 서드리스)

`index.html`은 그대로 두고, **결제 승인과 이용권 코드 발급만** 처리하는 함수 하나입니다.
지금은 `index.html`의 `TOSS_LIVE_ENABLED = false`라서 **아무 일도 일어나지 않고**, 사이트 화면도 기존과 똑같습니다.
토스페이먼츠 심사가 통과하면 아래 순서대로 세 줄만 채워 결제를 엽니다.

```
serverless/
├─ confirm.js              # 본체 — Cloudflare Worker 단일 파일 (환경변수만 넣으면 끝)
├─ vercel/api/[...path].js # Vercel로 올릴 때 쓰는 15줄 어댑터 (confirm.js를 그대로 사용)
└─ README.md
```

## 하는 일

| 주소 | 하는 일 |
| --- | --- |
| `GET /health` | 배포 확인용 `{ ok: true }` |
| `POST /confirm` | 토스 결제 승인(`/v1/payments/confirm`) → 이용권 코드 발급 |
| `POST /license` | 다른 기기에서 이용권 코드 검증 → Pro 만료일 반환 |

- **결제 금액은 이 파일의 `PRICES`가 기준**입니다. 브라우저에서 금액을 조작해도 표와 다르면 승인하지 않습니다.
  (`monthly` 4,900원 / `yearly` 49,000원 — `index.html`의 `data-toss-amount`와 같아야 합니다.)
- 승인된 결제(`status: DONE`, `totalAmount` 일치, `orderId` 일치)일 때만 코드를 줍니다.
- 새로고침·중복 클릭으로 같은 결제를 다시 승인하면 토스가 `ALREADY_PROCESSED_PAYMENT`를 주는데, 이때는 결제를 조회해 **같은 이용권 코드**를 다시 발급합니다.
- 이용권 코드는 서버 비밀키로 서명한 값이라 위조·만료일 변조가 안 됩니다(저장소·DB 없이 동작).

## 이용권 코드 형식

```
LC1M-2FPCV-7B-NCF8DQMR   ← 예시 (발급할 때마다 달라짐)
 │  │      │  └ 서명 8자리 (HMAC, 서버 비밀키)
 │  │      └ 주문 해시 4자리
 │  └ 만료일 3자리 (2020-01-01부터 일수, Base32)
 └ 이용권 M(1개월) / Y(1년)
```

- 결제 직후 화면에 크게 보여 주고 `이용권 코드 복사` 버튼을 제공합니다.
- 나중에 「이용권 코드로 Pro 복원」에 넣으면 어느 기기에서든 Pro가 열립니다.
- 코드는 서버에 저장하지 않으므로 **분실하면 다시 받을 수 없습니다**(아래 '남은 일' 참고).

---

## 1단계 · 서버 배포 + 시크릿 키 넣기

### A. Cloudflare Workers (권장 · 무료 · 5분)

1. <https://dash.cloudflare.com> 가입 → 왼쪽 **Workers & Pages** → **Create** → **Worker** → 이름 `lessoncard-api` → **Deploy**
2. **Edit code** → 편집기에 `serverless/confirm.js` **전체를 붙여넣기** → **Deploy**
3. 주소 확인: `https://lessoncard-api.<계정이름>.workers.dev/health` → `{"ok":true,...}` 가 보이면 성공
4. **Settings → Variables and Secrets**
   - `TOSS_SECRET_KEY` = 토스 개발자센터의 **시크릿 키**(`live_sk_…`, 심사 전이면 `test_sk_…`) · **Secret으로 저장**
   - (선택) `LICENSE_SECRET` = 아무 긴 문자열 — 비워 두면 `TOSS_SECRET_KEY`에서 자동 생성
   - (선택) `ALLOWED_ORIGINS` = 추가로 허용할 주소(쉼표 구분). `https://lessoncard.kr`은 기본 포함
5. 저장 후 **Deploy** 한 번 더 (환경변수 반영)

> 시크릿 키는 이 서버에만 둡니다. `index.html`, GitHub, 메신저 어디에도 붙이지 마세요.

### B. Vercel로 올리는 경우

`serverless/vercel` 폴더를 프로젝트 루트로 올리면 `/api/confirm` · `/api/license` · `/api/health`로 붙습니다.
같은 이름의 환경변수(`TOSS_SECRET_KEY` 등)를 Project Settings → Environment Variables에 넣고 Redeploy 하세요.

---

## 2단계 · `index.html` 세 줄 채우기

`index.html` 안 `TOSS_LIVE_ENABLED` 근처:

```js
var TOSS_LIVE_ENABLED = true;                                  // ← 켜기
var TOSS_CLIENT_KEY = 'live_ck_…';                             // ← 클라이언트 키 (공개돼도 되는 키)
var TOSS_API_BASE = 'https://lessoncard-api.xxxx.workers.dev'; // ← 1단계에서 받은 주소
```

- 클라이언트 키 위치: 토스 **개발자센터 > API 키 > API 개별 연동 키** → 상점 `q_lessonfv7y` 선택 → **클라이언트 키**(`live_ck_…`)
  - `test_ck_…`로 먼저 넣으면 **실제 돈이 나가지 않는 테스트 결제**로 전 과정을 확인할 수 있습니다(권장).
- 저장(커밋·푸시)하면 라이브에 반영됩니다. 이때부터:
  - Pro 버튼 → 토스 결제창(카드·카카오페이·토스페이)
  - 결제 성공 → `https://lessoncard.kr/?toss_status=success&paymentKey=…&orderId=…&amount=…` 로 돌아와 자동 승인 → Pro 해금 + 이용권 코드 표시
  - 실패·취소 → 모달에 사유 표시
  - 모달 하단에 **이용권 코드로 Pro 복원** 입력칸이 나타남

### 테스트 순서 (테스트 키)

1. 폰에서 `lessoncard.kr` → `Pro 요금제` → `1개월 이용권` → 토스 테스트 결제
2. 돌아온 화면: `결제가 완료됐어요 · Pro가 열렸습니다` + 이용권 코드, 배지 `Pro · 30일 남음`
3. 새로고침해도 Pro 유지 → 시크릿 창(다른 기기 흉내)에서 코드 입력 → Pro 열림
4. 토스 상점관리자 → 결제내역에서 테스트 결제 확인 → **테스트 결제는 취소(환불)** 처리

---

## 3단계 (선택) · 유료 전환 스위치

지금은 `BETA_OPEN = true`라서 **모든 방문자가 Pro를 무료로** 씁니다. 이 상태에서는 결제를 열어도 살 이유가 없습니다.

```js
var BETA_OPEN = false;   // 신규 방문자는 Free(월 3장)
```

- 이미 무료로 써 온 원장님들이 갑자기 잠기지 않도록, `BETA_GRACE_UNTIL`(기본 `2027-02-28`)까지 기존 베타 사용자는 자동으로 Pro가 됩니다. 날짜를 바꾸거나 `''`로 두면 즉시 Free로 내려갑니다.
- 이 스위치는 **매출·체험 정책이 걸린 결정**이므로 사용자 확인 후에 켜는 것이 좋습니다.

---

## 남은 일 (결제를 연 뒤 개선할 것)

1. **이용권 코드 보관** — 지금은 결제 직후 화면과 그 기기 localStorage에만 남습니다. 이메일(또는 카카오 알림톡)로 코드를 보내려면 메일 발송 서비스가 하나 더 필요합니다. 결제 시 `customerEmail`을 받도록 바꾸면 토스가 결제 영수증을 보내 줍니다.
2. **환불·취소** — 환불규정(7일 전액 / 이후 일할)에 맞춘 취소 API(`POST /v1/payments/{paymentKey}/cancel`)와 코드 회수 절차가 아직 없습니다. 지금은 상점관리자에서 수동 취소.
3. **웹훅** — 결제 상태 변경(취소·부분취소)을 서버가 자동 반영하려면 토스 웹훅 등록.
4. **정기결제(자동 갱신)** — 지금은 1개월·1년 **단건 결제**입니다. 자동 갱신을 원하면 빌링키 발급 흐름을 따로 붙여야 합니다.
5. **악용 방지** — 서버에 요청 제한(rate limit)과 결제 로그 저장소를 두는 것이 좋습니다. 코드 서명 덕분에 코드 위조는 불가능하지만, 승인 요청 자체는 제한이 없습니다.
