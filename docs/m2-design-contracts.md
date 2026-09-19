# M2 design: DeskLane contracts (Robinhood Chain 4663)

This is the build spec. It merges the contracts architect's design with the red-team review. The frozen interfaces in
`contracts/src/interfaces/` are the source of truth. If this document and the interfaces ever disagree, the interfaces
win. Raise any change you need to them explicitly.

The implementation adds items the frozen interfaces don't carry: custom errors (`LaneExists`, `ImplementationTimelocked`,
`NoPendingImplementation`, `ZeroAddress`, `BadCeilings`, `ReentrancyGuardReentrantCall`, `SafeERC20FailedOperation`,
the fence's `BadConfig`), the factory's listing and implementation-timelock surface (`listed`, `LaneListed`,
`pendingImplementation`, `applyImplementation`, `ImplementationProposed`, `IMPLEMENTATION_DELAY`, `laneArgs`,
`kindRegistered`), the lane's `lastRerangeAt` and `poolParams`, and the fence's status constants, `config` and
`isClosedWindow`. `contracts/scripts/abi-extras.py` generates them into `contracts/abi/extras.json` (keys `lane`,
`factory`, `fence`) after `forge build`; `--check` fails when the file is stale. The frozen `contracts/abi/I*.json` are
unchanged. *(updated after review, Sep 19)*

## Scope (M2)
- **Contracts:** `DeskLaneCore` (abstract), `DeskLaneV3` (Uniswap v3 via the NPM), `DeskLaneFactory` (clones) and
  `ChainlinkFence` (implements `IPriceFence`).
- **Pool:** NVDA/USDG v3 only, `0xd4eb…14a3`. token0 is USDG (6 decimals), token1 is NVDA (18), fee 500, tickSpacing 10.
- **Not in M2:**
  - no swaps of any kind;
  - no signed-mark oracle (M3's `SignedMarkOracle` will implement `IPriceFence` behind a new implementation);
  - no v4 (M3 adds `DeskLaneV4` as a new implementation kind);
  - no weekend risk-adding.
- **Toolchain:** Foundry 1.8.3, solc 0.8.26, `evm_version = cancun`. OpenZeppelin v5.4.0 (`Clones` with immutable
  args, `ReentrancyGuardTransient`, `SafeERC20.forceApprove`). v4-core math: `TickMath`, `FullMath`, `SqrtPriceMath`,
  `FixedPoint96`.
- **Uniswap interfaces:** hand-write minimal 0.8 interfaces for the v3 pool, NPM and factory. Never import v3-core or
  v3-periphery sources, which are 0.7.
- **Local tests** deploy the real v3 artifacts with `deployCode`:
  - `node_modules/@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json`
  - `node_modules/@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json`
  - The NPM constructor takes `(factory, WETH9, tokenDescriptor)`; any address works for the descriptor in tests.

## Roles and custody
- **owner** is an immutable clone arg: the user's Vault wallet. It is never delegated, and it is the only recipient of value.
- **operator** is the agent's wallet: a separate Dynamic delegated embedded wallet, or a Dynamic server wallet as Plan B.
  `owner != operator` always holds (`OperatorIsOwner`). The operator can call `rerange`, `reduce`, `collect`, `exitAll`,
  `signal` and `pause`. The owner can call all of those too.
- **guardian** is optional: the watchdog key. It can call `pause`, `exitAll` and `reduce`, and can extend `closedUntil`.
  It can never add risk, move value or change config.
- **Timelocks (24 h):**
  - A new operator: `proposeOperator` → `applyOperator` after the ETA. `proposeOperator` rejects 0
    (`InvalidConfig(1)`) and the owner (`OperatorIsOwner`). `revokeOperator` is instant and also cancels a pending
    proposal, so after a revoke the lane has no operator until a new proposal applies 24 h later.
    *(updated after review, Sep 19)*
  - Looser caps: `setCaps(target)` takes the full desired Caps. Fields tighter than the current caps apply at once; if
    any field is looser, the **whole** `target` becomes the pending proposal (ETA now + 24 h), applied by `applyCaps`.
    Every `setCaps` call supersedes an earlier pending proposal, so a tighten-only call also cancels a pending
    loosening. `cancelCaps` is instant. `target` must be well formed (`maxRanges ≤ 2`, `minWidthTicks ≤ maxWidthTicks`,
    else `InvalidConfig(2)`) and within the implementation's `CEILINGS` (else `InvalidConfig(3)`). The caps applied at
    once may transiently have `minWidthTicks > maxWidthTicks`; that only blocks risk-adding.
    *(updated after review, Sep 19)*
  - Replacing a registered implementation kind in the factory is timelocked for 24 h too (see Factory).
    *(updated after review, Sep 19)*
- `setGuardian` is instant, because the guardian can only reduce risk.
- No ownership transfer, no generic `execute`, no `receive()`, no `onERC721Received` (so junk `safeTransferFrom` of
  NFTs reverts), no gas reimbursement.

## Clone layout
- Immutable args, read with `Clones.fetchCloneArgs` and cached in memory per call:
  `owner, laneId, pool, token0, token1, fee, tickSpacing, dec0, dec1`, packed with `abi.encodePacked` into 89 bytes
  (`owner 20 | laneId 1 | pool 20 | token0 20 | token1 20 | fee 3 | tickSpacing 3 | dec0 1 | dec1 1`, `CloneArgs`). On
  the implementation itself, and on any code whose args are not exactly 89 bytes, every function that needs the args
  reverts `NotAuthorized`. *(updated after review, Sep 19)*
- Implementation immutables, set in the constructor: `FACTORY`, `NPM`, `V3_FACTORY`, `FENCE`, and `CEILINGS`
  (the absolute Caps ceiling copied from the factory at deploy). `V3_FACTORY` is read from the factory, and the
  `DeskLaneV3` constructor requires `NPM.factory() == V3_FACTORY` (`InvalidConfig(5)`), so the NPM mints into pools of
  the same v3 factory the lane factory validates against. *(updated after review, Sep 19)*
- `initialize(operator, guardian, caps)` is callable only by `FACTORY`, and only once. The implementation's constructor
  locks it (`_initialized = true` on the implementation itself). It rejects a zero operator or owner (`InvalidConfig(1)`),
  `operator == owner` (`OperatorIsOwner`), token decimals above 36 (`InvalidConfig(4)`) and caps that are malformed or
  above `CEILINGS` (`InvalidConfig(2)` / `(3)`), and it starts the three buckets full. *(updated after review, Sep 19)*
- **Mutable storage:**
  - `operator`, `pendingOperator` + `eta`, `guardian`, `paused`, `closedUntil`
  - `caps`, `pendingCaps` + `eta` (each packed into three words, four 64-bit fields per word; `CapsLib`)
  - buckets: `turnover` (usd6, 24 h period), `rr1h` (1 h), `rr24h` (24 h). Each is `{levelWad, lastTs}` with linear
    refill: `level = min(cap, level + cap·Δt/period)`. Levels are WAD-scaled so frequent updates don't drop fractional
    refill (at most 1e-18 unit per update is lost, always against the spender). A cap change applies on the next read:
    the level is clamped to the new cap. *(updated after review, Sep 19)*
  - `lastRerangeAt`
  - `uint256[2] tokenIds` (slot 0 and 1; 0 means empty)
  - `mapping(bytes32 => uint64) decisionUsedAt`
- **Transient storage:** the reentrancy guard (OZ `ReentrancyGuardTransient`).

## Behaviour

### Every Meta-taking function
1. Auth. (`rerange` then checks `paused`, else `IsPaused`.) *(updated after review, Sep 19)*
2. `decisionId != 0`, else `ZeroDecision`. `decisionUsedAt[id] == 0`, else `DecisionUsed`. Then set it to
   `block.timestamp` **before** any external call.
3. `block.timestamp <= deadline`, else `Expired`. `deadline <= block.timestamp + caps.maxDeadlineAhead`, else
   `DeadlineTooFar`.
4. Emit `LaneAction` at the end.

A reverted call spends nothing, because the storage write is rolled back.

### rerange(m, ranges, expectedTick, maxTickDelta) (operator or owner, not paused)
1. Meta checks. `ranges.length <= caps.maxRanges`, else `TooManyRanges`.
2. If `ranges.length > 0`:
   - `closedUntil <= now`, else `ClosedUntilActive`.
   - `FENCE.usdPrice(token0)` and `FENCE.usdPrice(token1)` must both return code 0, else `MarketClosed(code)` with the
     first failing code. One read gives both the price and the code (the same code `status()` returns).
   - `now >= lastRerangeAt + minRerangeInterval`, else `TooSoon`.
   - Consume 1 from `rr1h` and 1 from `rr24h`, else `BucketEmpty(1, 1, have)` / `BucketEmpty(2, 1, have)`.

   *(updated after review, Sep 19)*
3. **Unwind** every live slot (`_remove`, strict):
   - read the NPM position; `decreaseLiquidity(all, mins 0, deadline now)` if it has liquidity;
   - collect everything owed to `this`. The collect never reverts: if the full collect fails (for example one token is
     paused or blocklisted), each token is collected on its own so the healthy one still comes out, `CollectFailed` is
     emitted and the slot is **kept**;
   - `burn` only if the full collect succeeded, then free the slot and emit `PositionClosed`.
   - A failed position read, `decreaseLiquidity` or `burn` reverts the rerange with the NPM's revert data (only
     `exitAll` tolerates them). A slot kept by a failed collect still occupies a slot, so a later mint can run out of
     free slots (`TooManyRanges`).
   - Unwinding never reads the fence.

   *(updated after review, Sep 19)*
4. If `ranges.length == 0`, stop: this is unwind-and-hold. Emit `LaneAction(RERANGE)` with empty ticks.
5. `maxTickDelta <= caps.maxTickDelta`, else `TickDeltaAboveCap`. `|slot0.tick − expectedTick| <= maxTickDelta`, else
   `PoolTickMoved`. A failed or short `slot0` read is `PoolTickMoved(0, expectedTick, maxTickDelta)`.
   *(updated after review, Sep 19)*
6. `refTick` comes from the fence:
   - p0 = `usdPrice(token0)` and p1 = `usdPrice(token1)` (USD per whole token, 1e18).
   - The pool's raw price, token1 per token0 in base units, is `P = (p0 / 10^dec0) / (p1 / 10^dec1)`.
   - `refTick = floor(log_{1.0001} P)`. Compute via `sqrtPriceX96 = sqrt(P)·2^96` using `FullMath` and a `Math.sqrt`
     of a Q192 value, then `TickMath.getTickAtSqrtPrice`.
   - An unusable price (0, at or above `2^128` in 1e18 units, token decimals above 36, or `P` outside the v3 price
     domain) reverts `MarketClosed(2)`. *(updated after review, Sep 19)*
   - `bandTicks = caps.placeBandBps` (1 bp ≈ 1 tick; round up).
7. **Per range i:**
   - Checks:
     - `tickLower < tickUpper`;
     - both are multiples of `tickSpacing` and inside `[MIN_TICK, MAX_TICK]`;
     - width is within `[minWidthTicks, maxWidthTicks]`;
     - `share0Bps` and `share1Bps` are not both 0;
     - the range doesn't duplicate another range in this call;

     otherwise `BadRange(i)`. The shares must sum to at most 10,000 per token, else `SharesExceed` (checked after
     every range has passed the fence). *(updated after review, Sep 19)*
   - **Placement fence** (`RangeRules.check`). Let `tc = slot0.tick`; the pool price `P` lies in
     `[1.0001^tc, 1.0001^(tc+1))`.
     - Token0 liquidity sits in `[max(tl, tc), tu)` (asks start at `P`). Whenever `tl <= tc`, token1 liquidity sits in
       `[tl, min(tu, tc + 1))` (bids reach `P`). v3 counts `tc == tl` as in range, so when `tl <= tc < tu` the current
       tick's bucket holds **both** tokens, `tl == tc` included.
     - If `tu > tc`, require `max(tl, tc) >= refTick − band`.
     - If `tl <= tc`, require `min(tu, tc) <= refTick + band`. (This check used to run only when `tl < tc`; skipping
       `tl == tc` let a pool pushed far above the band be bid at.)
     - Otherwise revert `RangeOutsideFence(i, tl, tu, refTick, band)`.
     - In words: never offer either token more than the band worse than the reference. A straddle (`tl <= tc < tu`)
       therefore needs `|tc − refTick| <= band`. The current bucket's token1 bids up to `P < 1.0001^(tc+1)`, a one-tick
       slack that the rounded-up band absorbs. Swapping the token order negates the ticks and exchanges the two
       conditions, so the rule is symmetric under token0/token1 orientation up to that slack.

     *(updated after review, Sep 19)*
8. **Mint** each range:
   - `amount0 = bal0 · share0Bps / 1e4` and `amount1 = bal1 · share1Bps / 1e4`, from the idle balances after the
     unwind.
   - `forceApprove(NPM, exact)` for each token with a nonzero amount, then `NPM.mint({token0, token1, fee, tl, tu, a0,
     a1, mins 0, recipient: this, deadline: now})`, then `forceApprove(NPM, 0)` for the same tokens.
   - Mins of 0 are safe because steps 5–7 checked the price in the same transaction.
   - Store the tokenId in the first free slot (none free → `TooManyRanges`). Emit `PositionMinted`.

   *(updated after review, Sep 19)*
9. **Notional:**
   - `usd6 = a0used·p0/(10^dec0·1e12) + a1used·p1/(10^dec1·1e12)`, each token's term rounded up.
   - Require `usd6 <= caps.maxDeployUsd6`, else `DeployCapExceeded`.
   - Debit the turnover bucket by `usd6`, else `BucketEmpty(0, …)`.

   *(updated after review, Sep 19)*
10. Set `lastRerangeAt = now` and emit `LaneAction(RERANGE, ticks = [tl0, tu0, tl1, tu1], refPxE18, …)`.
    `refPxE18` is quote per base at 1e18 (USDG per NVDA for this pool).
11. Return `(tokenIds, liquidities, amount0Used, amount1Used)` so the agent's `eth_call` can see them.

### Risk-reducing functions (never read the fence; allowed while paused)
- **`reduce(m, slot, liquidity)`** (operator, owner or guardian): `decreaseLiquidity`, then collect as in the unwind
  (per-token fallback, `CollectFailed`). A `liquidity` above the position's is clamped to it. If the position's
  liquidity reaches 0 and the full collect succeeded, `burn` it and free the slot. 0 skips the decrease and only
  collects; if the position already has 0 liquidity (for example one an `exitAll` kept after a failed collect) and the
  collect succeeds, it is burned and the slot freed. An empty slot is `BadSlot`; a failed decrease or burn reverts.
  *(updated after review, Sep 19)*
- **`collect(m)`** (operator or owner): collect every slot, each on its own, with the same per-token fallback.
  *(updated after review, Sep 19)*
- **`exitAll(m)`** (operator, owner or guardian): unwind every slot with per-slot try/catch, so a failing slot is kept
  and emits `CollectFailed`. Unlike the rerange unwind, a failed position read, decrease or burn is tolerated too. It
  **must never revert because a token is paused or blocklisted.** It keeps the tokens idle in the lane and never
  transfers out. *(updated after review, Sep 19)*
- **`signal(m)`** (operator or owner): emits `LaneAction(SIGNAL)` only. It spends the decisionId like every other
  Meta call. *(updated after review, Sep 19)*
- **`pause()`** (operator, owner or guardian) and **`unpause()`** (owner).
- **`setClosedUntil(until)`** (owner or guardian): the owner may set any value; the guardian may only extend it
  (`until >= closedUntil`), else `NotAuthorized`. *(updated after review, Sep 19)*
- Every call without a Meta (`pause`, `unpause`, `setClosedUntil`, the owner's config calls and withdrawals) also emits
  `LaneAction` with `decisionId = 0` and the matching action (`PAUSE`, `UNPAUSE`, `SET_CLOSED_UNTIL`, `SET_OPERATOR`,
  `SET_CAPS`, `SET_GUARDIAN`, `WITHDRAW`, `WITHDRAW_POSITION`), so the LaneAction stream is a complete audit trail. The
  agent matches its own `pause()` by transaction hash. *(updated after review, Sep 19)*

### Owner-only value exits
- `withdraw(token, amount)`: `safeTransfer` to the owner. Any ERC-20 is allowed, so a donated token can't get stuck.
- `withdrawAll()`: transfers token0 and token1 to the owner. Each token's balance read and transfer are tried on their
  own (`trySafeTransfer`), so a paused or blocklisted token is skipped instead of reverting.
  *(updated after review, Sep 19)*
- `withdrawPosition(slot)`: the NPM `transferFrom(this, owner, tokenId)`; frees the slot. This is the escape hatch that
  works even when NVDA is paused.
- All of these work while paused, and none reads the fence.

### Views
As in `IDeskLane`. `budgets()` returns the refilled levels as of `now`; its `nextRerangeAt` is 0 before the first
risk-adding rerange. `riskAddingOpen()` returns 100 when paused, 101 when `closedUntil` is active, or the first fence
code. `refTick()` returns the code instead of reverting: for fence codes 3–6 the feeds are sound, so the tick is still
computed and returned with the code, and a price with no pool tick returns code 2. Implementation extras
(`extras.json`): `lastRerangeAt()`, `poolParams()` → `(fee, tickSpacing, dec0, dec1)`, `CEILINGS()`, and the
immutables `FACTORY`, `FENCE`, `NPM` and `V3_FACTORY`. *(updated after review, Sep 19)*

## ChainlinkFence (implements IPriceFence)
- The constructor takes `TokenConfig[] {token, feed, kind (STOCK | STABLE), maxAge}` and stores it immutably. There is
  no admin; a new config means a new fence. A zero token or feed, `kind` NONE, `maxAge` 0 or a duplicate token reverts
  `BadConfig(i)`. *(updated after review, Sep 19)*
- The M2 deployment configures USDG (STABLE, feed `0x61B7…9aD2`, maxAge 26 h) and NVDA (STOCK, `0x379E…9F15`, 26 h).
  Also add SPY, QQQ and TSLA (STOCK) so M3 can reuse it.
- **`usdPrice(token)`:**
  - Every external read is a low-level `staticcall` with a return-length check, so a reverting, missing or malformed
    feed or token gives a code, never a revert.
  - `latestRoundData()` reverts or returns fewer than 5 words → 7. `decimals()` reverts or is short → 7.
  - `answer <= 0` or `updatedAt > now` or `now − updatedAt > maxAge` gives code 2. So do feed decimals above 36, an
    answer at or above `2^128`, and a scaled price of 0.
  - Otherwise `price = answer · 1e18 / 10^decimals()`, reading `decimals()` live (feeds changed from 18 to 8 on Jun 23).
  - Codes 1, 2 and 7 return `(0, 0, code)`. For codes 3–6 the feed itself is sound, so the price comes back alongside
    the code (useful for valuation); callers still must not add risk unless the code is 0.
  - Status checks run in priority order, and the first failure is returned:
    1. unknown token → 1
    2. feed checks → 2 or 7
    3. **STOCK only:**
       - `oraclePaused()`: true gives 3, and so does a token that doesn't answer (fail closed);
       - `effectiveAt()` (only this; `newUIMultiplier()` is not read): if `effectiveAt != 0` and
         `|now − effectiveAt| < 2 h`, give 4. A token that doesn't answer also gives 4;
       - the closed window gives 5.
    4. **STABLE only:** `|price − 1e18| > 50 bp` gives 6.

  *(updated after review, Sep 19)*
- **Closed window** (STOCK, in UTC, conservative under both US DST states):
  - `dow = ((now / 86400) + 4) % 7`, where 0 is Sunday (unix epoch day 0 was a Thursday).
  - Closed from Saturday 00:00 UTC to Monday 01:00 UTC: `dow == 6`, or `dow == 0`, or (`dow == 1` and
    `secondOfDay < 3600`).
  - This matches the 24/5 feed schedule (Fri 20:00 → Sun 20:00 ET) with a margin.
- **`status(token)`** returns the same code as `usdPrice`. It never reverts. Extras (`extras.json`): `config(token)`,
  `tokens()`, `isClosedWindow(ts)` and the constants (`OK` … `FEED_REVERTED`, `CORP_ACTION_GUARD` = 2 h,
  `DEPEG_TOLERANCE_E18` = 5e15, `MAX_FEED_DECIMALS` = 36). *(updated after review, Sep 19)*

## Factory
- **Constructor:** `(admin, V3_FACTORY, Caps ceilings)`. A zero admin or v3 factory reverts `ZeroAddress`.
  *(updated after review, Sep 19)*
- **Admin:** set implementations, allow pools and set ceilings; all of these affect NEW clones only. Admin handover is
  two-step (`proposeAdmin`, `acceptAdmin`). `setPoolAllowed` and `setCeilings` apply at once; replacing an
  implementation is timelocked (below). *(updated after review, Sep 19)*
- **`setImplementation(kind, impl)`** applies at once only when it cannot put new code behind an address `predictLane`
  already returned:
  - the kind's **first registration** (`kindRegistered(kind)` is false);
  - **disabling** the kind (`impl = 0`), which also drops a pending replacement;
  - **re-affirming** the current implementation, which cancels a pending replacement.

  Any other change, including re-enabling a disabled kind, becomes pending for `IMPLEMENTATION_DELAY` = 24 h: it emits
  `ImplementationProposed(kind, impl, eta)` and is readable as `pendingImplementation(kind)` → `(implementation, eta)`.
  After the ETA the admin calls `applyImplementation(kind)` (`NoPendingImplementation` without one,
  `ImplementationTimelocked(kind, eta)` before the ETA). A new proposal supersedes the pending one and restarts the
  delay. A nonzero `impl` without code reverts `ZeroAddress`. *(updated after review, Sep 19)*
- **`createLane(p)`** is permissionless. It requires:
  - `implementations[p.kind] != 0` (`UnknownKind`)
  - `poolAllowed[p.pool][p.kind]` (`PoolNotAllowed`)
  - `IUniswapV3Factory(V3_FACTORY).getPool(token0, token1, fee) == p.pool`, reading the tokens and fee from the pool
    (`PoolMismatch`)
  - `p.owner != 0 && p.operator != 0 && p.operator != p.owner` (`OperatorInvalid`)
  - every Caps field within the ceilings (`CapsAboveCeiling(field)`)

  Then:
  - `salt = keccak256(abi.encode(p))`; the salt commits to every parameter (including the user-chosen `p.salt`
    nonce). The lane address is `predictDeterministicAddressWithImmutableArgs(impl, args, salt)`.
  - If no lane exists at that address: `Clones.cloneDeterministicWithImmutableArgs(impl, args, salt)`, then
    `initialize(operator, guardian, caps)`, record `isLane`, emit `LaneCreated`.
  - **Listing.** `lanesOf(owner)` lists only lanes whose `createLane` was sent **by the owner**. When `msg.sender ==
    p.owner`, the call also sets `listed(lane)`, appends the lane to `lanesOf(owner)` and emits
    `LaneListed(owner, lane)`. Sent by anyone else, the lane is deployed but not listed.
  - **Repeats.** If someone else already deployed the owner's exact params (a helper, or a front-runner, who can only
    deploy exactly what the owner asked for), the owner's own `createLane` returns that existing lane and lists it
    instead of reverting. Any other repeat (a non-owner sender, or an owner whose lane is already listed) reverts
    `LaneExists(lane)`.

  *(updated after review, Sep 19)*
- `isLane(lane)` marks every clone this factory deployed. It says nothing about who asked for the lane: anyone may
  deploy a lane naming any owner, with any operator, but only the owner can put it in its own list. Consumers that list
  a user's lanes read `lanesOf` (or `LaneListed`), not `LaneCreated`. *(updated after review, Sep 19)*
- `predictLane(p)` returns the address before deployment, so the web can pre-set the Dynamic policy allowlist. The
  prediction holds only while `implementations[p.kind]` is unchanged, so a caller also checks
  `pendingImplementation(p.kind)`: a replacement can apply once its ETA has passed. `laneArgs(p)` returns the clone's
  immutable args. *(updated after review, Sep 19)*

## Default M2 caps (lane A, first live mint ~$50)
- `maxDeployUsd6` = 60e6, `turnoverUsd6PerDay` = 150e6
- `placeBandBps` = 100, `maxTickDelta` = 10
- `minWidthTicks` = 20, `maxWidthTicks` = 2000
- `reranges1h` = 4, `reranges24h` = 24, `minRerangeInterval` = 300
- `maxDeadlineAhead` = 120, `maxRanges` = 2

**Factory ceilings:**
- `maxDeployUsd6` = 5,000e6, `turnoverUsd6PerDay` = 20,000e6
- `placeBandBps` = 300, `maxTickDelta` = 60
- `minWidthTicks` ≥ 2 (the tightest allowed), `maxWidthTicks` ≤ 20,000
- `reranges1h` ≤ 12, `reranges24h` ≤ 96, `minRerangeInterval` ≥ 60
- `maxDeadlineAhead` ≤ 300, `maxRanges` ≤ 2

**Direction of each field.** For "max"-type fields, the ceiling is an upper bound. For `minRerangeInterval` and
`minWidthTicks` the ceiling is a lower bound. `setCeilings` documents this in its NatSpec (and `DeskDefaults.ceilings()`
repeats it); it reverts `BadCeilings` when `minWidthTicks > maxWidthTicks` or `maxRanges == 0`. The factory's ceilings
bound `createLane` at once, but each implementation copied them at its own deployment (`CEILINGS`, enforced by
`initialize` and `setCaps`), so loosening them for new lanes also needs a new implementation, which is itself
timelocked. *(updated after review, Sep 19)*

## Tests (the M2 acceptance evidence)

### Unit tests (`test/unit`)
- `PriceMath`: refTick round-trip in both token orders; a 6/18 decimals case matching the live NVDA pool
  (price ~222 → tick ~222 27x). Use `cast` values as fixtures.
- `RangeRules`: fuzz against a brute-force per-tick holdings model.
- `TokenBucket`: huge Δt; rounding.
- `ChainlinkFence`: every code; decimals 18 vs 8; the closed window at the UTC boundaries (Fri 23:59:59, Sat 00:00,
  Mon 00:59:59, Mon 01:00); the effectiveAt window; depeg.
- Role × function matrix for owner, operator, guardian and stranger.
- Timelocks; initialize-once; implementation locked.

### Local integration (`test/local`)
Real v3 factory and NPM artifacts, mock tokens (6 and 18 decimals, with pause and blocklist toggles), and
`MockAggregator` feeds.

### Invariant suite (`test/invariant`)
Profile: 1,000 runs × depth 100, `fail_on_revert = false`. `FOUNDRY_PROFILE=quick` (64 × 50) is for local iteration
only. *(updated after review, Sep 19)*

`DeskHandler` actors:
- **honest operator:** valid reranges around the pool, exits, collects;
- **evilOperator:** random calldata over every selector, plus crafted off-market ranges;
- **attacker:**
  - swaps in the pool right after each operator action;
  - calls every function;
  - donates tokens;
  - sends NFTs with `safeTransferFrom`;
  - calls the NPM directly;
- **owner:** withdraw, withdrawPosition, pause/unpause, tighten caps, propose loosening;
- **guardian.**

Environment actions:
- `warp`: forward only, 1 s to 3 days, crossing the closed window;
- `movePrice` via a `PoolMover` helper;
- set the mock Chainlink price, age and decimals;
- `oraclePaused` toggle;
- `effectiveAt` set;
- token pause toggle;
- fence revert.

**Log auditor:** wrap every handler call in `vm.recordLogs` and classify every ERC-20 `Transfer` from the lane and
every ERC-721 `Transfer` of a lane-owned NFT.

Invariants I1–I14:
- **I1. Outflows.** Every ERC-20 transfer from the lane goes to the owner or to the lane pool inside an NPM mint for a
  tokenId the lane then owns. Every ERC-721 transfer out goes to the owner or burns to 0.
- **I2. Exits never need the oracle.** `afterInvariant` runs `ownerCanAlwaysExit`: snapshot, break the fence and pause
  a token, then check `exitAll` + `withdrawAll` + `withdrawPosition` still recover everything recoverable, and revert.
- **I3.** A decisionId is spent at most once. A reverted call spends nothing.
- **I4.** Buckets and interval match an independent reference model.
- **I5.** Every allowance from the lane is 0 after every call.
- **I6.** Only the lane pool is ever used for NPM positions.
- **I7. Bounded loss.** With an evilOperator and an attacker swapping against us, fence-valued NAV ≥ initial −
  band × turnover used − (fees + rounding). This is the key property.
- **I8.** The operator can never change owner, operator, caps, guardian or unpause, and can never withdraw.
- **I9. Exit liveness.** From any reachable state `exitAll` succeeds using under 3M gas.
- **I10.** The placement fence holds for every minted range at mint time.
- **I11.** No liquidity increase happens while paused, while `closedUntil` is active, or while the fence code is ≠ 0.
- **I12.** NFT bookkeeping: tracked slots equal the lane-owned NPM positions, and the count is ≤ 2.
- **I13.** The deadline window holds; limits use timestamps only (a CI grep enforces this).
- **I14.** A `uiMultiplier`/Chainlink price step moves refTick exactly once, with no double application.

### Negative tests (`test/local/Attacks.t.sol`)
- **N1.** Unit bugs: an inverted tick, a 1e12 decimals slip. The fence must revert.
- **N2.** Attacker moves the pool, operator reranges, attacker swaps back. Expect a revert or a loss ≤ band.
- **N3.** The operator calls owner-only functions.
- **N4.** A fake pool with the same tokens and another fee; a look-alike NPM.
- **N5.** Foreign NFTs.
- **N6.** NVDA paused during `exitAll`: USDG still comes out and the NFT escape hatch works.
- **N7.** The oracle reverts, or returns 0, a negative value or a future timestamp: exits work, adds revert.
- **N8.** decisionId replay; an expired deadline; a deadline 1 day ahead.
- **N9.** Rerange spam at the rate-limit edges.
- **N10.** 50-cycle round-trip leakage stays within a few wei per token per cycle.
- **N11.** Reentrancy through a hook token.

### Fork tests (`test/fork`, `FOUNDRY_PROFILE=fork`, needs `RH_ARCHIVE_RPC` on Alchemy)
Pin one weekday block and one Saturday block.
- **ForkSanity:** addresses and code; `deal` USDG and NVDA (fall back to `vm.store`: USDG balances at slot 1; NVDA uses
  ERC-7201 storage at `0x52c6…ce00`); a fresh contract can hold and send NVDA.
- **ForkLifecycle:** create a lane, fund, first mint, whale swaps for fees, collect, reduce, rerange, exitAll, withdraw.
- **ForkAdversarial.**
- **ForkFiftyReranges:** ≥ 50 successful reranges with price moves and warps between them; every assertion after each.
- **ForkInvariants campaign:** profile `fork`, 50 runs × depth 20.

These tests **must skip cleanly** when `RH_ARCHIVE_RPC` is unset.

## Scripts
- `Deploy.s.sol`: preflight (the v3 factory and NPM have code, and `getPool(USDG, NVDA, 500)` is the NVDA pool), then
  fence, then factory, then `DeskLaneV3` implementation, then `setImplementation(1)` (instant: the kind's first
  registration), then `setPoolAllowed(NVDA pool, 1)`, then optionally `proposeAdmin(DESK_ADMIN)` (the new admin must
  `acceptAdmin`). It writes `deployments/<chainid>.json` on `--broadcast` runs, or on any run when `DEPLOYMENTS_FILE`
  is set (fork runs use e.g. `deployments/4663-fork.json`, so the live record is never overwritten).
  *(updated after review, Sep 19)*
- `CreateLane.s.sol`: `predictLane`, then `createLane`, then asserts the address equals the prediction and prints
  `listed(lane)`. Env: `LANE_OPERATOR` (required), `LANE_OWNER` (default: the broadcaster), `LANE_GUARDIAN`,
  `LANE_ID`, `LANE_SALT`, `DESK_FACTORY`. Only a run broadcast **by the owner** lists the lane; sent by anyone else the
  lane is deployed but unlisted until the owner sends the same params. *(updated after review, Sep 19)*
- `CheckDeployment.s.sol`: read-only. Reads the deployment record back and asserts every link and setting (factory
  implementation, pool allowlist, ceilings, implementation immutables and `CEILINGS`, locked `initialize`, pool
  tokens/fee/spacing, the fence table). It warns when a kind-1 implementation replacement is pending. With
  `LANE=<address>` it also checks one lane: `isLane`, its EIP-1167 code delegates to the recorded implementation, pool,
  tokens, `operator != owner`, and prints `listed`, roles, `riskAddingOpen`, `refTick` and budgets.
  *(updated after review, Sep 19)*
- The same deploy script is used on anvil forks by the agent's e2e tests.

## Gas (for reference)
- NPM mint ≈ 433k; full rerange (unwind + 1–2 mints) ≈ 0.7–1.2M.
- Gas price ≈ 0.07–0.3 gwei and ETH ≈ $2,630, so a full rerange costs about $0.1–0.9.
