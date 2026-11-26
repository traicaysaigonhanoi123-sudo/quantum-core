# QUANTUM CORE // Hoppscotch-Ready Zero-Trust API Contract

Base URL (Local Zero-Trust Server): `http://127.0.0.1:8787`

## 1. Health Check
- **Endpoint:** `GET /api/v1/health`
- **Public DTO:** `{ ok: boolean, service: string, requestId: UUIDv4, timestamp: ISO8601 }`
```bash
curl -s http://127.0.0.1:8787/api/v1/health
```

## 2. Request 2FA OTP Challenge (HMAC-SHA256, 60s Cooldown, 10m TTL)
- **Endpoint:** `POST /api/v1/auth/otp/request`
- **Body DTO:** `{ "email": "trader@quantum.io" }`
```bash
curl -s -X POST http://127.0.0.1:8787/api/v1/auth/otp/request \
  -H "Content-Type: application/json" \
  -d '{"email":"trader@quantum.io"}'
```

## 3. Verify 2FA OTP & Issue `HttpOnly; SameSite=Strict` Session Cookie
- **Endpoint:** `POST /api/v1/auth/otp/verify`
- **Body DTO:** `{ "challengeId": "<UUIDv4>", "otp": "123456" }`
```bash
curl -i -s -c cookies.txt -X POST http://127.0.0.1:8787/api/v1/auth/otp/verify \
  -H "Content-Type: application/json" \
  -d '{"challengeId":"<UUIDv4>","otp":"123456"}'
```

## 4. Validate Current Session (RBAC + IP-Bound)
- **Endpoint:** `GET /api/v1/auth/session`
```bash
curl -s -b cookies.txt http://127.0.0.1:8787/api/v1/auth/session
```

## 5. Global Session Revocation (All Devices)
- **Endpoint:** `POST /api/v1/auth/sessions/revoke`
```bash
curl -i -s -b cookies.txt -X POST http://127.0.0.1:8787/api/v1/auth/sessions/revoke
```
