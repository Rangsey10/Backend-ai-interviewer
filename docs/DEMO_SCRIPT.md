# Demo script (≈ 8 minutes)

**Before you start (do this 15 min earlier):** all 3 services running, `/health` shows `aiService: reachable`,
Docker running. Register these accounts once so the demo is fast:
`candidate@demo.com` (Candidate), `recruiter@demo.com` (Recruiter), and have the admin account ready.
Do one full practice run — the AI is slow on the first call.

1. **Problem + architecture (1 min)** — slide with frontend → backend → AI service → Groq.
2. **Admin approves the recruiter (1 min)** — sign in as admin → *User accounts* → Approve `recruiter@demo.com`.
   Mention: recruiters can't sign in until approved; the recruiter gets a notification.
3. **Recruiter creates an interview (2 min)** — sign in as recruiter → *Create interview* → job title, candidate email
   `candidate@demo.com`, "Role & stack" → Generate (AI) → edit/add a custom question → Save.
   Mention: questions are saved on the interview and the candidate is notified.
4. **Candidate takes it (2 min)** — sign in as candidate (bell shows the invitation) → Start → answer one theory
   question (feedback + adaptive follow-up appear) → run the coding question (Docker judge + AI review) → Finish.
   Tip: keep answers short so the AI responds quickly.
5. **Report (1 min)** — candidate sees strengths/growth areas (no hiring recommendation). Sign in as recruiter →
   *Candidates* → View report (now with recommendation) → select two completed candidates to compare.
6. **Analytics + AI monitoring (1 min)** — recruiter *Reports* (score distribution, recommendations, coding results);
   admin *Overview* (users, AI success rate, latency per feature).
7. **Close (30 s)** — what's next: AI-authored test cases, email verification, resume upload.

**If the AI is slow or fails:** the UI shows a retry card; don't refresh. If Groq rate-limits you, wait ~10 s.
**Fallback:** show the already-completed interview from your practice run (report + dashboards are stored).
