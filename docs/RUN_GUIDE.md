# AI Interviewer — run guide

Three services talk to each other: **frontend (5173) → backend (5000) → ai-service (3000) → Groq**.
The frontend never calls the AI service directly: the backend adds login, access control, rate limiting,
saving of answers/results, notifications and AI call monitoring.

## 1. AI service (`ai-service/`)

```bash
cd ai-service
cp .env.example .env        # set GROQ_API_KEY (and PORT=3000 if you changed it)
npm install
npm start                   # http://localhost:3000   (Swagger: /api-docs)
```
Coding questions are judged in Docker — keep Docker Desktop running.

## 2. Backend (this repo)

```bash
cp .env.example .env
# set: JWT_SECRET (>= 32 chars), CORS_ORIGIN=http://localhost:5173, AI_SERVICE_URL=http://localhost:3000
npm install
```

**Option A – PostgreSQL (recommended, data is kept)**
```bash
# DATABASE_URL="postgresql://user:pass@localhost:5432/interviewai?schema=public"
npm run prisma:migrate -- --name ai_integration     # creates the new columns/tables
npm run create-admin -- admin@example.com "StrongPass123" "Administrator"
```

**Option B – no database (demo only, everything is lost on restart)**
Leave `DATABASE_URL` unset and set `DEV_ADMIN_EMAIL` / `DEV_ADMIN_PASSWORD` in `.env`.

```bash
npm run build               # must finish with no errors
npm run dev                 # http://localhost:5000
curl http://localhost:5000/health    # "aiService": "reachable" when ai-service is up
npm run test:unit           # 34 unit tests (no database / network needed)
```

## 3. Frontend

```bash
cd frontend
cp .env.example .env        # VITE_API_BASE_URL=http://localhost:5000
npm install
npm run dev                 # http://localhost:5173
```

## API added in this integration

| Area | Endpoints |
|---|---|
| AI gateway (same paths as ai-service) | `POST /api/ai/questions`, `/resume-questions`, `/job-description-questions`, `/follow-up-questions`, `/feedback`, `/final-report`; `POST /api/submissions/execute` |
| Interviews | `GET /api/sessions`, `POST /api/sessions/create` (`candidateEmail`), `PUT /api/sessions/:id/questions`, `GET /api/sessions/:id/questions`, `GET /api/sessions/:id/report` |
| Dashboards / analytics | `GET /api/dashboard/candidate\|recruiter\|admin`, `POST /api/analytics/compare`, `GET /api/analytics/ai` (admin) |
| Notifications | `GET /api/notifications`, `POST /api/notifications/read-all`, `POST /api/notifications/:id/read` |
| Admin | `GET /api/admin/users`, `PATCH /api/admin/users/:id` (approve / reject / suspend) |
| Account | `PATCH /api/auth/me`, `POST /api/auth/change-password` |

Pass `sessionId` (+ `questionId`) in the body of an AI call and the result is saved on that interview;
without them the call is a plain pass-through.

## Behaviour worth knowing

- Recruiters register as **pending** and cannot sign in until an admin approves them.
- A suspended account loses access within ~15 s (account status is checked on every request).
- Candidates never receive the hiring recommendation in their report; recruiters/admins do.
- AI calls are limited per user (`AI_RATE_LIMIT_PER_MINUTE`, default 30). The AI service itself spaces model calls ≥ 8 s apart, so a feedback + follow-up pair takes ~10–20 s.
- Error codes from the AI side: 503 = ai-service not running, 504 = timed out, 502 = AI error, 429 = our rate limit.

## Known limitations

- Coding test cases are still fixed in the frontend (`InterviewSession.tsx`, "first non-repeating character"); the AI does not author test cases yet.
- No email delivery (verification, password reset) and no resume file upload; resumes are pasted as text.
- Live-session sockets do not re-check suspension (the token expiry still applies).
- Real Groq calls and Docker judging need your own `GROQ_API_KEY` and Docker; they could not be run in the build environment.
