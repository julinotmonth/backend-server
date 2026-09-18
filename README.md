# Reethau Inventory — Backend API

Node.js + Express + PostgreSQL REST API for the Reethau Inventory Admin Portal. Replaces the old per-browser `localStorage` persistence with a real, shared, server-side database — multiple users on different computers now see the same data.

## Stack

- **Node.js** (v18+) with native ESM
- **Express** for routing
- **PostgreSQL** (via the `pg` driver — plain SQL, no ORM, so `src/schema.sql` is the single source of truth for the data model)
- **JWT** (`jsonwebtoken`) for login sessions
- **bcryptjs** for password hashing

## 1. Install PostgreSQL

**Ubuntu/Debian:**
```bash
sudo apt-get update
sudo apt-get install -y postgresql postgresql-contrib
sudo service postgresql start
```

**macOS (Homebrew):**
```bash
brew install postgresql@16
brew services start postgresql@16
```

**Or use Docker** (skip local install entirely):
```bash
docker run --name reethau-postgres -e POSTGRES_PASSWORD=reethau_dev_pw \
  -e POSTGRES_USER=reethau -e POSTGRES_DB=reethau_inventory \
  -p 5432:5432 -d postgres:16
```

## 2. Create the database (skip if you used the Docker command above)

```bash
sudo -u postgres psql -c "CREATE USER reethau WITH PASSWORD 'reethau_dev_pw';"
sudo -u postgres psql -c "CREATE DATABASE reethau_inventory OWNER reethau;"
```

## 3. Configure environment variables

```bash
cd server
cp .env.example .env
```

Edit `.env` if your database credentials differ from the defaults:

```
DATABASE_URL=postgres://reethau:reethau_dev_pw@localhost:5432/reethau_inventory
PORT=4000
JWT_SECRET=reethau-dev-secret-change-me   # generate a real random value for anything beyond local dev
```

## 4. Install dependencies & run

```bash
npm install
npm run migrate   # creates all tables and seeds default data (safe to re-run — no-ops if already seeded)
npm run dev       # starts the API on http://localhost:4000 with auto-restart on file changes
```

`npm start` runs the same thing without file-watching, for production.

The server also runs the migration automatically on every boot (`src/index.js` calls `migrate()` before listening), so `npm run migrate` is mainly useful for inspecting the seeding output on its own or re-running it manually.

## Default accounts (seeded automatically)

All seed accounts share the password **`reethau123`**:

| Email | Role | Site |
|---|---|---|
| `admin@reethau.com` | Super Admin | Semua Site |
| `hendra.gunawan@reethau.com` | Site Manager | Bekasi |
| `budi.santoso@reethau.com` | Maintenance Engineer | Blora |

## API overview

All routes are prefixed with `/api` and (except `/auth/login` and `/health`) require an `Authorization: Bearer <token>` header, obtained from `POST /api/auth/login`.

| Method & Path | Description | Access |
|---|---|---|
| `GET /api/health` | Health check | Public |
| `POST /api/auth/login` | Log in, returns `{ token, user }` | Public |
| `GET /api/auth/me` | Current session's user | Any logged-in user |
| `GET /api/users` | List all accounts | Super Admin |
| `POST /api/users` | Create an account | Super Admin |
| `PATCH /api/users/:id` | Update an account (self can edit name/photo/position; Super Admin can edit anything) | Self or Super Admin |
| `DELETE /api/users/:id` | Delete an account (can't delete yourself or the last Super Admin) | Super Admin |
| `GET /api/sites` | List operational sites | Any logged-in user |
| `POST /api/sites` | Add a new site | Any logged-in user |
| `PATCH /api/sites/:key` | Update a site | Any logged-in user |
| `DELETE /api/sites/:key` | Delete a site (blocked for the 4 default sites, or if spare parts still reference it) | Any logged-in user |
| `GET /api/categories` | `{ sparePart: string[], productEnergy: string[] }` | Any logged-in user |
| `POST /api/categories/spare-part` | Add a spare part category | Any logged-in user |
| `POST /api/categories/product-energy` | Add a product energy line | Any logged-in user |
| `GET /api/spare-parts` | List all spare parts | Any logged-in user |
| `POST /api/spare-parts` | Add a spare part | Any logged-in user |
| `PATCH /api/spare-parts/:id` | Update a spare part | Any logged-in user |
| `DELETE /api/spare-parts/:id` | Delete a spare part | Any logged-in user |
| `POST /api/spare-parts/:id/transfer` | Move stock to another site (atomic: decrements source, creates/increments target, writes the log entry — all in one DB transaction) | Any logged-in user |
| `GET /api/logs` | Activity log, newest first | Any logged-in user |
| `POST /api/logs` | Write a log entry | Any logged-in user |
| `GET /api/gallery` | List gallery photos | Any logged-in user |
| `POST /api/gallery` | Add a photo (`src` is a base64 data URL) | Any logged-in user |
| `DELETE /api/gallery/:id` | Delete a photo (blocked for the seeded Site Setu documentation photos) | Any logged-in user |

## Project structure

```
server/
├── package.json
├── .env.example
└── src/
    ├── index.js      # Express app + every route
    ├── db.js         # PostgreSQL connection pool
    ├── schema.sql     # Table definitions (run automatically)
    ├── migrate.js     # Runs schema.sql + seeds default data if empty
    ├── repo.js        # SQL queries + row → camelCase JS mapping, one module per table
    └── auth.js        # JWT signing/verification + Express auth middleware
```

## Notes / things to harden before a real production deployment

- **JWT_SECRET** must be a real random secret outside of local development — don't ship the default.
- **Uploaded images** (spare part photos, avatars, gallery photos) are stored as base64 text directly in Postgres columns for simplicity. Fine for a demo/small deployment; for heavier use, move these to object storage (S3-compatible) and store just the URL.
- **New user passwords**: accounts created via `POST /api/users` get the same default password as the seed accounts. A real deployment should email an invite/reset link instead.
- **Rate limiting / brute-force protection** on `/api/auth/login` isn't implemented — add something like `express-rate-limit` before exposing this publicly.
