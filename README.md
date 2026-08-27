# Multi-Platform Integration Dashboard

Sign in with Google, Microsoft 365, or GitHub — connect Atlassian, Linear, and
Notion — turn a requirement into editable user stories and tasks, then push them
as real issues and pages.

This repository currently contains the **auth foundation**: the Next.js app
scaffold, the Postgres/Prisma schema for Better Auth, social sign-in for the
three login providers, and an authenticated dashboard shell. Integrations,
generation, and push land in later slices — see the project spec.

## Stack

| Concern | Choice |
| --- | --- |
| App | Next.js 15 (App Router) + TypeScript |
| Styling | Tailwind CSS v4 |
| Database | PostgreSQL via Prisma 7 |
| Auth | Better Auth — Google, Microsoft Entra ID, GitHub; sessions in Postgres |
| Tests | Vitest |

## Getting started

```bash
npm install                 # also runs `prisma generate`
cp .env.example .env        # fill in DATABASE_URL + BETTER_AUTH_SECRET
npm run db:migrate          # create the auth tables
npm run dev
```

Every value in `.env.example` is a secret and belongs in the environment, never
in the repository. Social sign-in buttons render for all three providers; a
provider whose `AUTH_*` variables are unset renders as unavailable rather than
failing mid-redirect.

### OAuth redirect URIs

Each provider needs `${BETTER_AUTH_URL}/api/auth/callback/<provider>` registered,
where `<provider>` is `google`, `microsoft`, or `github`.

## Checks

```bash
npm run lint        # ESLint
npm run typecheck   # tsc --noEmit
npm test            # Vitest
npm run build       # next build
```

CI runs all five on every pull request (`.github/workflows/ci.yml`).
