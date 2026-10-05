# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`wallet-service` is a NestJS 12 + Mongoose double-entry ledger. It is meant to replace the single-entry, float-based wallet balances in the `back-end` service. Amounts are always `bigint` **minor units**: stored as `Decimal128` and sent over HTTP as integer strings (`"10500"`; decimals get a 400). The `docs/` folder holds design plans (`ledger-operations-plan.md`, `conversion-flow-plan.md`) and a step-by-step HTTP walkthrough of the refund flow with the expected balances (`refund-flow-http-testing.md`).

## Commands

```bash
npm run start:dev          # watch mode; needs MongoDB as a replica set (transactions), port from HTTP_PORT (default 3003)
npm run build              # nest build. The pre-push hook runs this as the type-check gate
npm run lint               # oxlint src/ test/
npm run format             # prettier

npm test                   # all specs (unit + e2e), serial, with an in-memory Mongo replica set
npm run test:unit          # unit specs only (test/unit/**); fully mocked, no Mongo, runs in parallel
npm run test:e2e           # e2e specs only (test/e2e/**)
npm run test:cov           # coverage. The global threshold is 95% for statements, branches, functions and lines

# single file / single test
npx jest --config ./jest.unit.config.js test/unit/payouts/payout-transitions.spec.ts
npx jest test/e2e/refunds.e2e-spec.ts -t "fee"
```

- The pre-commit hook (lint-staged) runs `jest --config ./jest.unit.config.js --findRelatedTests` on staged `.ts` files.
- Jest transforms with `@swc/jest`, including files under `node_modules`, because Nest 12 is ESM-only (`transformIgnorePatterns: []`). Keep this setting when you change the Jest config.
- E2E tests: `test/global-setup.ts` starts a `MongoMemoryReplSet` and exports `TEST_MONGO_PATH`. `test/utils/app.ts#createTestApp()` boots the full `AppModule` against a fresh random database with API key `test-key`, and accepts provider overrides.

Env vars (`src/config/index.ts`): `MONGO_PATH`, `DB_NAME`, `API_KEYS` (comma-separated), `DEFAULT_TENANT_ID`, `HTTP_PORT`, `SERVER_ENV`. Pushing to `dev` or `qa` builds the Docker image and pushes it to ECR (`.github/workflows/release.yml`).

## Architecture

### Request pipeline
- The global `ApiKeyGuard` checks the `x-api-key` header against `API_KEYS`. Mark an exception with `@Public()`.
- `@TenantId()` reads `x-tenant-id` and falls back to `DEFAULT_TENANT_ID`. Every query and posting is scoped to a tenant.
- `@IdempotencyKey()` reads the `idempotency-key` header, which every write requires.
- `ZodValidationPipe` validates request bodies against the zod schemas in each module's `dto.ts`. Use `amountString` from `common/amount-schema.validator.ts` for amount fields.
- `ResponseInterceptor` wraps successful responses as `{ success, message, data }`. Set the message with `@ResponseMessage()`.
- Errors: throw `AppError.<factory>()` from `common/errors.ts`. Each factory carries an `ErrorCode`, an HTTP status and a `retryable` flag. `AppExceptionsFilter` renders them. When you add a business rule, add both the `ErrorCode` and the factory.

### `LedgerService.post()` is the only write path
All balance changes go through `src/ledger/ledger.service.ts#post()`. One call runs a single Mongo transaction (snapshot read concern, majority write concern) that:
1. Checks idempotency. If the key was already used, it replays the stored result. The same key with a different payload gets `IDEMPOTENCY_KEY_REUSE`.
2. Calls the caller's `generateLedgerOps(ctx)` and gets back a `LedgerOperation`: `entries`, `guardNegative`, optional `reversalOf`, `buildResponse`, `buildEvent` and an optional `sideEffect`.
3. Checks that every `EntryI` balances (debits equal credits, one currency per entry, positive amounts).
4. Provisions any accounts that don't exist yet (`ensureUserWallet` / `ensureSystem`) and loads them.
5. Computes the new balances. Any account listed in `guardNegative` that would end below zero throws `INSUFFICIENT_FUNDS`.
6. Updates user accounts under OCC (`version` match; a conflict throws `OccConflict` and the whole call retries) and updates system accounts with a plain read-modify-write. Then it inserts `postings` and `entries`, writes the outbox events (`dedupeId = operationId:type:index`) and stores the idempotency record.

The sign convention is **balance = credits − debits**. Each entry nets to zero, so for each tenant and currency all account balances add up to zero.

### Accounts (`src/accounts/account.ts`)
- **User accounts** are keyed by `(tenantId, ownerId, currency, walletType ∈ {collection, payout}, accountType ∈ {available, held-inflow, held-outflow, refund-chargeback})`. A "wallet" is the set of these sub-accounts, and they are provisioned lazily. User accounts keep a gap-free `sequence`, and each user posting stores `balanceAfter`.
- **System accounts** (`System.*`: `external:collection`, `external:payout`, `external:refunds`, `external:opening-balance`, `fx:<CUR>`) have no sequence and no OCC.
- Build references with the `accountRef.*` helpers. `refKey()` is the in-memory map key only and is never persisted.

### Lifecycle flows are ledger-derived state machines
Payouts, conversions, settlements, refunds and refund fees have **no status document**. Each module has a `*-transitions.ts` file that maps each status to `{ operationType, eventType, plan(ctx, params) }`. A `plan` works out the current state by summing earlier postings filed under the flow's `reference`, using `ctx.referenceNetAmount(reference, accountRef, operationTypes?)` and `ctx.referenceEntryIds`. It then checks the preconditions (already initiated, already resolved, amount mismatch, and so on) and returns the entries to post. The `*.service.ts` file plugs the plan into `ledgerService.post()`.
- `src/payouts/payout-transitions.ts` is the reference implementation. The usual shape is: initiate moves `available → held-outflow`, success moves `held → external`, failed or reversed returns the money to `available`, and reverse-failed takes it back again.
- The `operationType` strings (e.g. `payout.initiate`, `refund.fee.reverse`) are part of posted history: the state machines read past postings through them. **Do not rename them without a data migration.**
- Unit tests for transitions run against an in-memory `FakeLedger` that implements `PrePostContext` (see `test/unit/payouts/payout-transitions.spec.ts`). Shared mocks are in `test/mocks/`.

### Other pieces
- `CurrencyRegistryService`: services call `currencies.require(code)` before posting. The registry stores each currency's minor-unit scale, and NGN is seeded at startup.
- `OutboxEventType` in `src/ledger/types.ts` lists every event type. Events are written to `outbox` with `published: false`. Nothing publishes them yet.
- Repositories and services create their collections and call `syncIndexes()` in `onModuleInit`.
