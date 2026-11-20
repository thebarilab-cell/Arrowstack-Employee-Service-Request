# Arrowstack Employee Service Request

A full-stack application with a React/Vite employee and staff workspace, an Express API, and a PostgreSQL data layer. It includes email/password authentication, JWT bearer sessions, employee service request tracking, and staff triage.

## Requirements

- Node.js 20 or newer and npm
- PostgreSQL 14 or newer, with `psql`, `createuser`, and `createdb` available in your terminal

The application does not start PostgreSQL or create a database automatically. The migration and seed commands connect only when run and use the `DATABASE_URL` environment variable.

## PostgreSQL setup (local development)

1. Install PostgreSQL 14 or newer and start its database service. On Windows, add the PostgreSQL `bin` directory to `PATH` if its command-line tools are not found.
2. Create a dedicated local application role. This command prompts for a password; choose one locally and do not put it in source control:

   ```sh
   createuser -U <postgres_admin_user> --pwprompt arrowstack_app
   ```

3. Create an empty development database owned by that role:

   ```sh
   createdb -U <postgres_admin_user> -O arrowstack_app arrowstack_employee_service
   ```

   Replace `<postgres_admin_user>` with a PostgreSQL role permitted to create users and databases. These commands use your local PostgreSQL installation; they do not presume a database is already present.

4. From the project root, create the local environment file:

   PowerShell:

   ```powershell
   Copy-Item .env.example .env
   ```

   macOS/Linux:

   ```sh
   cp .env.example .env
   ```

   Edit `.env` and set `DATABASE_URL` to your local connection, for example:

   ```dotenv
   DATABASE_URL=postgresql://arrowstack_app:<your-local-password>@localhost:5432/arrowstack_employee_service
   ```

   Replace the password placeholder locally. URL-encode reserved characters in the password. Keep `.env` private; it is ignored by Git.

   Authentication also requires a private `JWT_SECRET` of at least 32 bytes. Generate one locally without displaying it:

   ```sh
   npm run auth:secret
   ```

   The command stores the value in the ignored root `.env`, prints no secret, and leaves an existing valid secret unchanged. Do not commit or share this secret. `PORT` (default `3000`), `NODE_ENV`, and `VITE_API_URL` may also be set in `.env`.

5. Install project dependencies and create/update the schema:

   ```sh
   npm install
   npm run db:migrate
   ```

   To verify the local connection before migrating, run `npm run db:check`. It performs a read-only query and reports only the database name and PostgreSQL version; it never prints the connection string or credentials.

   After migrating and seeding, `npm run db:verify` checks the expected tables and the IT, HR, and Facilities categories using read-only queries.

6. Optionally insert the built-in IT, HR, and Facilities categories:

   ```sh
   npm run db:seed
   ```

   Seeding is repeatable and does not overwrite existing categories. It creates no users or credentials.

## Database behavior

- Migrations live in `server/migrations` and run in filename order. Applied migrations and SHA-256 checksums are stored in `public.schema_migrations`.
- Each migration runs in a transaction while holding a PostgreSQL advisory lock. Re-running the command is safe; editing an already-applied migration is rejected. Add a new numbered migration instead.
- Seed SQL lives in `server/seeds`. The seed command requires the schema migration to have run first.
- UUID primary keys use PostgreSQL's built-in `gen_random_uuid()`; no extension setup is required on PostgreSQL 14+.
- The connection pool reads `DATABASE_URL` only. The API health endpoint reports process health and does not test database connectivity.

## Production deployment preparation

### Hosting architecture

Use a same-origin HTTPS hostname with an edge reverse proxy or managed ingress:

```text
Browser -- HTTPS --> reverse proxy / ingress
                         ├── /       --> static client build (client/dist)
                         └── /api/*  --> private Express API service
                                              │
                                              └── private TLS connection --> PostgreSQL
```

Build the React client with `npm ci` and `npm run build`, then publish `client/dist` to a static host/CDN. Run the API with `npm ci` and `npm start` on a private service network. Route `/api/*` through the same public origin to the API; the client then uses relative API paths and `VITE_API_URL` can remain unset. Do not expose the API or database directly to the public internet. The reverse proxy should terminate TLS, redirect HTTP to HTTPS, set security headers, and forward only the required `/api` routes.

### Production environment

Set these through the hosting platform's encrypted runtime/build settings. The root `.env` is for local development; do not upload or copy it to production.

| Variable | Where | Production value |
| --- | --- | --- |
| `NODE_ENV` | API runtime | `production`; the API refuses to start if production configuration is invalid |
| `PORT` | API runtime | Hosting-assigned port, or `3000`; must be an integer from 1 to 65535 |
| `DATABASE_URL` | API runtime and one-off migration job | PostgreSQL URL to the private database, using a least-privileged runtime role for the API and a separately controlled migration-capable role for the migration job. Require TLS with certificate verification, for example `?sslmode=verify-full`; URL-encode reserved characters. Store the complete URL only in the secret manager. |
| `JWT_SECRET` | API runtime | Random private value of at least 32 bytes, stored in the secret manager and kept stable across API instances and restarts. Never use the placeholder from `.env.example`. |
| `VITE_API_URL` | Client build only | Leave unset for the same-origin `/api` setup. If set, it is public and compiled into browser assets; never put secrets or credentials in any `VITE_*` variable. |

The API checks production `DATABASE_URL` and `JWT_SECRET` at startup without printing their values. `/api/health` reports that the process is alive. Configure the platform's readiness probe to use `GET /api/ready`, which returns `200` only when PostgreSQL is reachable and the expected migration ledger and application tables exist; it returns a generic `503` otherwise. It does not reveal connection details.

### Provisioning and release order

1. Provision PostgreSQL on a private network, enable TLS with certificate verification, create the database, and create separate roles for migrations and API runtime. Grant the API role only the table/sequence/function permissions it needs; keep schema ownership and DDL privileges with the migration role.
2. Add production `DATABASE_URL` and `JWT_SECRET` to the hosting secret manager. Set `NODE_ENV=production` and the platform `PORT` for the API service. Keep the client build environment free of server secrets.
3. Install locked dependencies with `npm ci`, run `npm test`, and build with `npm run build`. Publish the resulting `client/dist` artifact.
4. As a one-off release job with the migration-capable `DATABASE_URL`, run `npm run db:migrate`. Migrations are serialized with a PostgreSQL advisory lock and each migration is transactional. Then run `npm run db:verify`; run `npm run db:seed` only if the built-in categories are not already present (the seed is repeatable and creates categories only).
5. Start or roll out the API with its runtime credentials, publish the matching client, configure the HTTPS reverse proxy, and wait for `/api/ready` to return `200` before sending traffic. Check `/api/health` and a small set of non-destructive API requests after rollout.

The local `auth:provision-staff` command is deliberately restricted to the local development database. A separate approved production staff-account provisioning procedure is still required before staff access can be enabled in production; do not use the local CLI against production.

### PostgreSQL backups and restore

Use the database provider's encrypted automated backups or point-in-time recovery where available. Also keep scheduled encrypted logical backups with retention, restricted access, and copies stored outside the application host and repository. Test restores regularly into a separate recovery database. The following commands prompt for the PostgreSQL password; do not put passwords in command arguments or shell history. Replace placeholders locally, and store backup files in an access-controlled encrypted location:

```sh
pg_dump --host=<db-host> --port=5432 --username=<backup-role> --dbname=<database-name> --format=custom --no-owner --file=<secure-backup-path>/arrowstack.dump --password
```

For a restore test, create a new empty recovery database and restore there; do not restore over the live database:

```sh
createdb --host=<db-host> --port=5432 --username=<restore-role> --password <new-empty-recovery-database>
pg_restore --host=<db-host> --port=5432 --username=<restore-role> --password --dbname=<new-empty-recovery-database> --no-owner <secure-backup-path>/arrowstack.dump
```

Verify the restored schema with `npm run db:verify` pointed at the recovery database, then perform a controlled application smoke check against that recovery target. Confirm backup encryption, retention, recovery point, and access permissions as part of the operational runbook.

### Deployment checklist and rollback

- [ ] Production secret manager contains valid `DATABASE_URL` and `JWT_SECRET`; no `.env` file or secret is included in artifacts or client build variables.
- [ ] PostgreSQL is private, TLS certificate verification is enabled, runtime and migration roles are separated, and a backup/restore test is current.
- [ ] CI or release checks pass `npm test` and `npm run build` on the exact revision being deployed.
- [ ] Pending migrations are reviewed and applied by the one-off migration job before the new API/client version receives traffic.
- [ ] Category seed and `npm run db:verify` complete as required; `/api/ready` reports ready.
- [ ] HTTPS routing serves the static client and forwards `/api/*` to the private API. Staff provisioning has an approved production process.
- [ ] Release artifacts, migration list, backup identifier, and prior known-good application version are recorded.

For an application-only regression, stop or shift traffic from the new release and redeploy the previous API and client artifacts. Migrations are forward-only; do not edit an applied migration or assume an older application can run against a changed schema. Keep migrations backward-compatible across the rollout where possible. If a schema change prevents rollback, pause writes and restore or recover into a separate database from a verified backup/point-in-time recovery, validate it, then deliberately switch the service connection and proxy traffic. Never run a destructive restore over the live database as an automatic rollback.

## Authentication API

Run `npm run db:migrate` after installing this version to add the nullable `users.password_hash` column, case-insensitive email uniqueness, and the `auth_sessions` table. Existing users are not assigned passwords. Registration creates employee accounts only; callers cannot choose a role. Passwords must be 12–72 UTF-8 bytes and are hashed asynchronously with bcrypt. JWTs are signed with HS256, expire after one hour, and are checked against the session table so logout revokes the token immediately.

All endpoints use JSON. Errors have the shape `{ "error": { "code": "...", "message": "..." } }`.

| Method | Path | Request body / header | Result |
| --- | --- | --- | --- |
| `POST` | `/api/auth/register` | `{ "email": "<email>", "password": "<password>", "displayName": "<name>" }` | `201` with a bearer token and safe user profile |
| `POST` | `/api/auth/login` | `{ "email": "<email>", "password": "<password>" }` | `200` with a bearer token and safe user profile |
| `GET` | `/api/auth/me` | `Authorization: Bearer <token>` | Current safe user profile |
| `POST` | `/api/auth/logout` | `Authorization: Bearer <token>` | `204`; revokes this session |

Registration trims and lowercases email addresses. Duplicate emails return `409`; invalid credentials return the same `401` response whether the email is unknown or the password is wrong. Password hashes and the JWT signing secret are never included in API responses. Clients should discard their bearer token after logout.

## Employee service requests

The request endpoints require `Authorization: Bearer <token>`. The API derives the requester from the authenticated session and never accepts a caller-supplied owner. Employees can access only their own requests; a request owned by another employee returns the same `404` as a missing request.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/requests/categories` | List active IT, HR, and Facilities categories |
| `POST` | `/api/requests` | Create a request with `title`, `description`, and `categorySlug` (`it`, `hr`, or `facilities`) |
| `GET` | `/api/requests?page=1&pageSize=10&status=submitted` | List the signed-in employee’s requests with optional status filter and pagination |
| `GET` | `/api/requests/<uuid>` | View one of the signed-in employee’s requests |

Titles are trimmed and limited to 160 characters; descriptions are trimmed and limited to 10,000 characters. New requests use the database defaults (`submitted` status and `medium` priority). Creation and its `request_created` activity log are written in a single transaction. API validation errors use the shared `{ "error": { "code": "...", "message": "..." } }` shape.

### Request comments and activity history

Employees can read and add comments and view activity only for their own requests. Staff can read and add comments and view activity for requests through staff-only routes. Employees never receive internal comments; staff can see internal comments already present in the schema. The current API creates comments as public comments only. Comment text is trimmed, required, and limited to 5,000 characters; extra request fields are rejected. Comment insertion and its `comment_added` activity entry are committed in one transaction.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/requests/<uuid>/comments` | List comments visible to the signed-in employee |
| `POST` | `/api/requests/<uuid>/comments` | Add `{ "body": "<comment>" }` to an owned request |
| `GET` | `/api/requests/<uuid>/activity` | Read activity history for an owned request |
| `GET` | `/api/staff/requests/<uuid>/comments` | Staff list of request comments, including internal comments |
| `POST` | `/api/staff/requests/<uuid>/comments` | Staff add `{ "body": "<comment>" }` |
| `GET` | `/api/staff/requests/<uuid>/activity` | Staff read request activity history |

The request detail views display comments and activity history. These endpoints use the existing `request_comments` and `request_activity_logs` tables; no migration is needed.

The Vite development server proxies `/api` to `http://localhost:3000`, so the local client can call the API without cross-origin browser requests. The client offers employee sign-in/registration and stores the bearer token in tab-scoped session storage. For deployment, route `/api` through a same-origin reverse proxy to the API.

## Staff request triage

Staff routes require an authenticated account whose database role is `staff`. The role check is enforced by the API. Employee registration always creates the `employee` role. Use the local operator CLI below to create a new staff account; the CLI never promotes or changes an existing account.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/staff/requests?page=1&pageSize=10&status=submitted&assignment=unassigned` | Paginated request queue; `status` is optional and `assignment` is `all`, `unassigned`, or `mine` (default `all`) |
| `GET` | `/api/staff/requests/<uuid>` | View a request and its requester/assignee summary |
| `PATCH` | `/api/staff/requests/<uuid>` | Update one or more of `assignedTo` (active staff UUID or `null`), `status`, and `priority` |
| `GET` | `/api/staff/users` | List active staff accounts available for assignment |

Queue page size is limited to 50. Valid statuses are `submitted`, `in_progress`, `waiting_on_employee`, `resolved`, and `closed`; valid priorities are `low`, `medium`, `high`, and `urgent`. Only active staff accounts can be assigned. Invalid assignees, statuses, priorities, extra fields, or pagination values return safe validation errors. Each changed assignment, status, or priority is recorded in `request_activity_logs` in the same transaction as the update; unchanged values do not create duplicate activity entries. Staff can review all requests, while employee request endpoints remain scoped to the authenticated requester.

## Application commands

- `npm run dev` — run the API and Vite client together; open `http://localhost:5173`
- `npm run build` — create the production client bundle in `client/dist`
- `npm start` — start the API
- `npm test` — run client, API, and migration/schema checks
- `npm run db:check` — verify the configured database connection with a read-only query
- `npm run db:migrate` — apply pending schema migrations
- `npm run db:seed` — insert the development service categories
- `npm run db:verify` — verify the expected schema tables and seeded categories
- `npm run auth:secret` — generate a JWT signing secret in the root `.env` without displaying it
- `npm run auth:reset-employee --workspace server` — interactively reset an existing active employee password locally
- `npm run auth:provision-staff` — interactively create a new local staff account

### Staff account operator procedure

Only an authorized local operator with access to the project environment may run `npm run auth:provision-staff` from the project root. The command requires the root `.env`, an interactive terminal, `NODE_ENV` other than `production`, and a `DATABASE_URL` targeting `arrowstack_employee_service` on localhost/loopback at PostgreSQL port 5432. It asks the operator to type the expected database name and then checks the connected PostgreSQL database name and loopback server address before collecting account details.

The operator enters a display name and email, then enters the new password twice with terminal input hidden. Email is trimmed and lowercased; passwords must be 12–72 UTF-8 bytes and are hashed with bcrypt cost 12. The command creates a **new** `staff` account in a parameterized, transactional insert. If any account already uses that email, the command stops; it does not promote employees, change roles, or revoke sessions. Passwords, hashes, and connection credentials are never printed. Do not run this command against production or share the local `.env`.

The local employee password reset command first requires a non-production environment, a connection URL targeting `arrowstack_employee_service` on loopback at port 5432, and typed confirmation of the database name. After connecting, it also verifies PostgreSQL reports the expected database and loopback server address. It prompts for the account email and asks for the new password twice without echoing password input. It applies the existing 12–72 UTF-8 byte policy and bcrypt cost, updates only one matching active employee account, and revokes that account's active sessions in the same transaction. It does not create accounts or change roles. The command requires the project root `.env` and an interactive terminal; it prints only a safe completion or error message, never the password hash or connection details. Run it only when you intend to update that local database account.

## Test database coverage

The request API tests use an isolated in-memory PostgreSQL pool mock and do not connect to `DATABASE_URL`. This safely covers route validation, ownership, pagination, activity logging, rollback behavior, and staff triage without writing to the development database. The repository does not currently configure a separate PostgreSQL integration-test database or automatic fixture cleanup, so database-backed request integration tests are not run by `npm test`. Add integration tests only after providing a dedicated disposable test database separate from the local development database.

## Project layout

```text
client/                 React application and Vite configuration
server/src/              Express API, PostgreSQL config, migration and seed commands
server/migrations/       Versioned SQL schema migrations
server/seeds/            Development seed SQL
```

After setting up the database and environment, start the application with `npm run dev`. The API runs at `http://localhost:3000`; process health is available at `/api/health`, and local database/schema readiness is available at `/api/ready`.
