# Design decisions and invariants

## System invariants

1. A cart can produce at most one successfully completed order.
2. Inventory is decremented only after a checkout transaction commits.
3. A successful order stores an immutable snapshot of product name, SKU, quantity, unit price, and total at the moment of checkout.
4. A coupon is generated at most once per eligible milestone and redeemed at most once.
5. Gross revenue minus discounts equals net revenue for committed orders.
6. Reporting requests are read-only and derive from committed order snapshots.

## Decision: use integer minor units for all money

**Context:** The repository must avoid floating-point rounding errors and keep totals consistent under validation and discounts.

**Options considered:** Store Decimal in JavaScript floats, use cents in a Decimal library, or use integer minor units.

**Choice:** Store all prices and totals in integer minor units (e.g., cents or sub-cents for the chosen currency) and apply discounts with integer arithmetic.

**Why:** This avoids JavaScript floating-point drift and matches the challenge requirement to use integer arithmetic. The discount rule uses floor division on the subtotal and caps the discount at the subtotal to ensure totals never go negative.

**Consequences:** We must convert all API totals to integer values rather than decimals. The system is precise, but any downstream display layer must format currency carefully.

## Decision: revalidate the latest product state at checkout

**Context:** The cart may have been built before product prices or inventory materially changed.

**Options considered:** Check out with the original product snapshot only, or revalidate against the latest database state and snapshot the current values as the order history.

**Choice:** Revalidate price and inventory at checkout time and record the current price and product metadata in the order snapshot.

**Why:** This preserves explainability and catches price or inventory drift. It also ensures inventory is not oversold under race conditions while preserving historical accuracy.

**Consequences:** A cart can be valid earlier and fail later if conditions changed, which is more consistent with the business requirement than allowing stale cart data to create an invalid order.

## Decision: use a database-backed idempotency key and stored response payload

**Context:** Retries of the same checkout request must not create duplicate orders or deduct inventory twice.

**Options considered:** Use a client-generated UUID only, track duplicates in memory, or rely on the UI to avoid retries.

**Choice:** Persist the `Idempotency-Key` in `CheckoutRequest` and store the successful response payload while validating the hash of the request content.

**Why:** This ensures that repeated identical requests resolve to the same stored order even across process restarts. A material mismatch (same key, different cart or coupon) returns HTTP 409.

**Consequences:** The checkout endpoint is safe under retries but also requires the client to keep the same key for a retried request.

## Decision: enforce inventory and coupon redemption with transactions

**Context:** Concurrent checkouts or coupon redemptions can race and violate invariants unless the database serializes the relevant writes.

**Options considered:** Use optimistic locking, a distributed lock, or no lock and trust validation.

**Choice:** Use Prisma transactions and conditional inventory updates within a single database transaction; coupon redemption is guarded by a unique milestone and coupon availability state.

**Why:** SQLite is used in this environment because PostgreSQL was not available in the machine runtime, but the transaction boundaries still give us durable atomicity and consistent writes. In production, PostgreSQL or a stronger multi-instance database would be preferred for row-level locking and more robust concurrency behavior.

**Consequences:** The solution is correct for single-instance execution and is positioned to scale to a production database with stronger locking semantics.

## Decision: treat coupons as milestone-based and admin-generated

**Context:** The business requirement says every nth successful order makes a coupon milestone eligible, but generation is separate from ordering.

**Options considered:** Generate coupons automatically on every successful order or generate only when the admin calls the generate endpoint.

**Choice:** Count successful orders, mark eligible milestones, and create a coupon only when `POST /api/admin/coupons/generate` runs for a milestone that has not yet been generated.

**Why:** This matches the wording of the assignment and keeps coupon generation explicit and auditable.

**Consequences:** The service may accumulate eligible but not yet generated milestones; the admin endpoint resolves them deterministically in order.

## Decision: query reporting from committed order snapshots

**Context:** Product metadata can change over time, and reporting must reconcile with the committed system state.

**Options considered:** Aggregate from the live product table and cart state, or compute summary data from the stored orders.

**Choice:** Report totals using `Order` and `OrderItem` tables, which capture immutable snapshots at checkout.

**Why:** This prevents stale prices or later inventory changes from mutating historical report totals.

**Consequences:** Reporting is read-only and deterministic, but it depends on a well-populated order history.

## Ambiguities and chosen semantics

- Price changes before checkout: the checkout validates the current price and records it into the order snapshot; the cart is not retroactively modified.
- Inventory changes before checkout: checkout fails if the product falls below requested quantity; this avoids overselling.
- Coupon semantics: a coupon is valid only if it exists and is still `AVAILABLE`; once redeemed, it cannot be reused.
- Failed checkout: inventory, cart state, and coupon status remain unchanged because the transaction rolls back.
- Milestone generation: milestones are based on successful order count, not attempted or failed order count.

## Transaction, concurrency, and idempotency strategy

- All checkout writes occur within a single Prisma transaction.
- Inventory checks and decrements happen inside the same transaction that creates the order and marks the cart as checked out.
- Coupon redemption is also inside the same transaction and is guarded by the coupon state.
- The idempotency table stores the `Idempotency-Key`, request hash, cart ID, and the stored response payload for successful duplicates.
- A same key with different request content returns `409 Conflict`.

## Money and rounding rules

- All money is stored in integer minor units.
- Discounts use `floor(subtotal * percent / 100)`.
- A discount is capped at the subtotal to ensure the final total is never negative.
- The report ensures `gross - discounts = net` by aggregating the same committed order snapshots.

## Error model

The service returns structured payloads like:

```json
{ "error": { "code": "INSUFFICIENT_INVENTORY", "message": "Only 3 unit(s) are available." } }
```

This keeps client behavior deterministic while preserving a machine-readable problem code for retries or UI handling.

## What is implemented versus intentionally deferred

**Implemented:** product seeding, cart operations, checkout, order snapshots, coupon generation, summary reporting, validation, and integration tests.

**Deferred intentionally:** authentication and authorization, production deployment infrastructure, background workers, and a real multi-instance Postgres cluster. These were not necessary to satisfy the challenge within the timebox and are explicitly documented instead of being silently omitted.

## Production scaling notes

For multiple application instances, the same service should run behind a load balancer with a single shared database. The transaction and idempotency patterns should stay the same, and the app should move from SQLite to PostgreSQL for stronger locking semantics and more predictable concurrency. In production, use advisory locking or transactional isolation levels that support strict write serialization for concurrent inventory and coupon checks.

## Honest AI usage

AI was used during scaffold generation and to help structure the domain model, error handling, and integration test design. One material correction involved moving the system away from a naive in-memory approach and toward a transactional database-backed checkout flow with persisted idempotency. The original draft was rejected because it did not preserve order snapshots and race safety under concurrent inventory updates.

## What I would investigate next with another two hours

- Add stronger PostgreSQL row-locking tests using multiple worker processes and explicit transactional isolation.
- Expand the API contract with richer validation and more granular response fields.
- Add local Docker-based database orchestration so the repository runs identically across machines.
