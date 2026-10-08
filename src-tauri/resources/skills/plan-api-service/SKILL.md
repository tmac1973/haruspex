---
name: plan-api-service
description: Questions and requirements for planning a backend API or service, covering clients, API style, auth, data and migrations, validation, errors, background work, limits, observability, deployment and testing. Use when the project is a server that other programs call.
metadata:
  haruspex-job: guided-planning
---

# Planning an API service

An API is a contract with its clients, and its shape, auth, errors and
data model are hard to change once anything calls it. Settle them first.

Settle each topic below that the description hasn't already settled. Offer
the options given, recommended first. Skip topics that clearly don't
apply.

## Questions

### Clients
Who calls it: the user's own frontend, other services, the public, or
scripts. This drives auth, versioning and limits.

### Language and framework
- Python: FastAPI or Flask.
- Node: Express or Fastify.
- Go: the standard library or a small router.
- Rust: axum.
- Whatever the project already uses.

### API style
- REST with JSON.
- GraphQL.
- RPC (gRPC, JSON-RPC).

Also ask whether there's an OpenAPI or schema document, and how versions
are handled (`/v1/` in the path, or none yet). Default: REST and JSON with
an OpenAPI document, served under `/v1/`.

### Resources and endpoints
Ask for the main resources and what clients do with them. This becomes the
phase order.

### Auth
- None (internal only).
- API keys.
- Sessions with cookies (for its own frontend).
- Tokens (JWT, or OAuth from a provider).

Also ask about roles: who may do what. Default: API keys for
service-to-service, sessions for its own frontend.

### Data
- Database: SQLite, PostgreSQL, or another the user names.
- Migrations: which tool, and whether they run on start.
- Rough data size and growth.

Default: SQLite for small or local, PostgreSQL for shared or growing.

### Validation
Validate every request body and parameter against a schema, and say how
invalid requests are reported.

### Errors
One error format for every endpoint (status code, a machine-readable code,
a message), and what is never shown to clients (stack traces, SQL).

### Lists
Pagination (cursor or offset), filtering and sorting for every endpoint
that returns a list.

### Background work
Whether anything runs outside a request: scheduled jobs, queues,
webhooks, emails. If so, which tool runs them.

### Limits
Rate limits per client, request size limits, and timeouts.

### Observability
- Logs: structured or plain, and where they go.
- A health check endpoint.
- Metrics or tracing.

Default: structured logs to stdout, and `/healthz`.

### Configuration and secrets
Where config comes from (environment variables, a file) and how secrets
are supplied. Nothing secret goes in the repo.

### Deployment
- Run locally.
- A container (Docker).
- A platform host.

Also ask about environments (development, production).

### Testing
- Unit tests for logic.
- Tests that call the endpoints against a test database.
- Both.

Default: both, with a fresh database per test run.

## Plan requirements

- The first phase starts the server with a health check endpoint, and the
  verification command checks it.
- Every endpoint validates its input, and returns errors in the one agreed
  format with the right status code.
- Every endpoint that needs auth refuses requests without it, and a test
  proves that for each.
- Every list endpoint is paginated.
- The schema is created and changed only by migrations, and a fresh
  database can be built from them.
- No secret is committed. Config comes from the environment, with a
  committed example listing every variable.
- The verification command runs every test against a throwaway database,
  with no outside network.
- If an API document is agreed, it matches the endpoints, and a test or
  generator keeps them in step.
