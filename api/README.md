# Posnic API

The Express and MongoDB API used by the Posnic desktop app and by the optional
self-hosted server.

The desktop build normally runs this API in-process. Use this guide when you
want to run the API by itself for development, tests or a self-hosted install.

## Requirements

- Node.js 22.12 or newer
- MongoDB 7 or newer
- npm

## Run locally

```bash
npm install
cp .env.example .env
```

Fill in the required values in `.env`. There are no shipped defaults for the
secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Use a different value for `JWT_SECRET` and `SESSION_SECRET`. `ENCRYPTION_KEY`
must be exactly 32 characters and `ENCRYPTION_IV` exactly 16. Set
`MONGODB_URI` to your database.

```bash
npm run dev      # nodemon, reloads on change
npm start        # normal process
```

The API listens on `PORT` (5000 by default) and serves routes under `/api`.

## Tests and checks

```bash
npm run test:unit
npm run test:all
npm run lint
npm run format:check
npm run docs:check
```

Some integration tests need a local MongoDB or use `mongodb-memory-server`.
Run `npm run test:local` for the local test runner.

## Layout

| Path | Purpose |
|---|---|
| `app.js` | Express app and middleware |
| `server.js` | Process entry point |
| `src/routes/` | HTTP routes |
| `src/controllers/` | Request handlers |
| `src/services/` | Business logic |
| `src/repositories/` | Database access |
| `src/models/` | Mongoose models |
| `src/middleware/` | Authentication, validation and security |
| `src/sync/` | Collection and sync declarations |
| `tests/` | Jest and real-Mongo tests |

## Configuration

Copy `.env.example` and read the comments there. The main groups are:

- server: `PORT`, `NODE_ENV`, `CORS_ORIGIN`, `PUBLIC_SERVER_URL`
- database: `MONGODB_URI`
- authentication: `JWT_SECRET`, `SESSION_SECRET`, expiry values
- field encryption: `ENCRYPTION_KEY`, `ENCRYPTION_IV`
- optional storage and email: S3 and Brevo values
- device print queue: `PRINT_DEVICE_API_KEY`

Never commit `.env` or a generated credential file. The desktop app generates a
separate secret set for each installation.

## Related documentation

- [Architecture](../docs/ARCHITECTURE.md)
- [API reference](../docs/API.md)
- [Development guide](../docs/DEVELOPMENT.md)
- [Self-hosting](../docs/SELF_HOSTING.md)
