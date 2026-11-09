# Karm Karo

Karm Karo (Hindi for “do the work”) is a team task desk. Managers assign work, employees finish it, and a built-in assistant turns a Hindi, Hinglish, or English sentence into a task you confirm before it is saved.

The interface is original. It is not a copy of any other task product.

## Demo workspace

Every demo account uses the password `KarmKaro#2026`.

| Person | Email | Role |
| --- | --- | --- |
| Aanya Sharma | aanya.sharma@karmkaro.dev | Super admin |
| Arjun Mehta | arjun.mehta@karmkaro.dev | Admin |
| Rahul Verma | rahul.verma@karmkaro.dev | Employee |
| Priya Nair | priya.nair@karmkaro.dev | Employee |
| Ananya Das | ananya.das@karmkaro.dev | Employee |
| Vikram Singh | vikram.singh@karmkaro.dev | Employee |
| Meera Iyer | meera.iyer@karmkaro.dev | Employee |

**Vercel preview without a database:** if `DATABASE_URL` is missing, the first three accounts above still sign in (password `KarmKaro#2026`) and load fixture tasks so you can check the frontend. Writes are soft-acked until Postgres is connected. Set `DEMO_MODE=0` to disable that fallback.

With a seeded database, Aanya still has the first-hour checklist. With no email provider configured, invite, verification, and reset links are returned in the API response and stored in `EmailOutbox`.

## Run locally

Requirements: Node.js 22, PostgreSQL 16, and Redis 7 (Redis is optional; without it the app uses an in-process timer).

```bash
cp .env.example .env
# Create the database, for example:
# createuser karm && createdb -O karm karmkaro
npm install
npx prisma migrate deploy
npm run db:seed
npm run dev
```

Open [http://127.0.0.1:43123](http://127.0.0.1:43123).

Docker Compose starts Postgres, Redis, and the app. Set `SEED_ON_BOOT=1` the first time you want the demo accounts.

```bash
cp .env.example .env
docker compose up --build
```

## What you can do

- Inbox, Today, Upcoming, Overdue, Completed, and My assigned
- Projects, sections, nested subtasks, list, board, calendar, and timeline
- Priorities, labels, checklist, comments with @mentions, files, reminders, and recurrence
- Admin desk: give work, people, pay, workload, reports (CSV and PDF), audit log, workspace settings
- Salary packages in INR, monthly payslips, and email delivery (or EmailOutbox when no mail provider is set)
- About one year of slips stay online for employees and managers, with PDF download
- Admins get a payroll-day notification (and email) when salary time arrives — set the day under Settings
- Employees open **My pay** for their own slips; managers use **Payrolls**
- Assistant quick add with a preview card, task breakdown, smart assign, and a chat that asks before it deletes anything
- English and Hindi chrome, light and dark, installable PWA

Leave `ANTHROPIC_API_KEY` empty to use the built-in parser. Set it to let Claude draft tasks and answer the chat. Output is validated before anything is saved, and employees can assign only themselves.

## Scripts

```bash
npm run lint
npm test
npm run test:e2e
npm run build
npm run db:seed
```

## Deploy

See [docs/DEPLOY.md](docs/DEPLOY.md) for a Vercel path and a VPS path, including DNS, HTTPS, migrations, health checks, and backups. Product notes from the public task-app research are in [docs/research.md](docs/research.md).
