# M2 design: DeskLane contracts (Robinhood Chain 4663)

This is the build spec. It merges the contracts architect's design with the red-team review. The frozen interfaces in
`contracts/src/interfaces/` are the source of truth. If this document and the interfaces ever disagree, the interfaces
win. Raise any change you need to them explicitly.

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
  - A new operator: `proposeOperator` → `applyOperator` after the ETA. `revokeOperator` is instant.
  - Looser caps: `setCaps` applies tighter fields at once; any looser field goes pending for 24 h, then `applyCaps`.
    `cancelCaps` is instant.
- `setGuardian` is instant, because the guardian can only reduce risk.
- No ownership transfer, no generic `execute`, no `receive()`, no `onERC721Received` (so junk `safeTransferFrom` of
  NFTs reverts), no gas reimbursement.

## Clone layout
- Immutable args, read with `Clones.fetchCloneArgs` and cached in memory per call:
  `owner, laneId, pool, token0, token1, fee, tickSpacing, dec0, dec1`, packed with `abi.encodePacked`.
- Implementation immutables, set in the constructor: `FACTORY`, `NPM`, `V3_FACTORY`, `FENCE`, and `CEILINGS`
  (the absolute Caps ceiling copied from the factory at deploy).
- `initialize(operator, guardian, caps)` is callable only by `FACTORY`, and only once. The implementation's constructor
  locks it (`_initialized = true` on the implementation itself).
- **Mutable storage:**
  - `operator`, `pendingOperator` + `eta`, `guardian`, `paused`, `closedUntil`
  - `caps`, `pendingCaps` + `eta`
  - buckets: `turnover` (usd6, 24 h period), `rr1h` (1 h), `rr24h` (24 h). Each is `{level, lastTs}` with linear
    refill: `level = min(cap, level + cap·Δt/period)`
  - `lastRerangeAt`
  - `uint256[2] tokenIds` (slot 0 and 1; 0 means empty)
  - `mapping(bytes32 => uint64) decisionUsedAt`
- **Transient storage:** the reentrancy guard (OZ `ReentrancyGuardTransient`).

## Behaviour

### Every Meta-taking function
1. Auth.
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
   - `FENCE.status(token0) == 0 && FENCE.status(token1) == 0`, else `MarketClosed(code)`.
   - `now >= lastRerangeAt + minRerangeInterval`, else `TooSoon`.
   - Consume 1 from `rr1h` and 1 from `rr24h`, else `BucketEmpty`.
3. **Unwind** every live slot:
   - NPM `decreaseLiquidity(all, mins 0, deadline now)`, then `collect(max)` to `this` inside try/catch
     (on failure emit `CollectFailed`), then `burn` (only if the collect succeeded).
   - Emit `PositionClosed`.
   - Unwinding never reads the fence.
4. If `ranges.length == 0`, stop: this is unwind-and-hold. Emit `LaneAction(RERANGE)` with empty ticks.
5. `maxTickDelta <= caps.maxTickDelta`, else `TickDeltaAboveCap`. `|slot0.tick − expectedTick| <= maxTickDelta`, else
   `PoolTickMoved`.
6. `refTick` comes from the fence:
   - p0 = `usdPrice(token0)` and p1 = `usdPrice(token1)` (USD per whole token, 1e18).
   - The pool's raw price, token1 per token0 in base units, is `P = (p0 / 10^dec0) / (p1 / 10^dec1)`.
   - `refTick = floor(log_{1.0001} P)`. Compute via `sqrtPriceX96 = sqrt(P)·2^96` using `FullMath` and a `Math.sqrt`
     of a Q192 value, then `TickMath.getTickAtSqrtPrice`.
   - `bandTicks = caps.placeBandBps` (1 bp ≈ 1 tick; round up).
7. **Per range i:**
   - Checks:
     - `tickLower < tickUpper`;
     - both are multiples of `tickSpacing` and inside `[MIN_TICK, MAX_TICK]`;
     - width is within `[minWidthTicks, maxWidthTicks]`;
     - the range doesn't duplicate another range in this call;

     otherwise `BadRange(i)`. The shares must sum to at most 10,000 per token, else `SharesExceed`.
   - **Placement fence** (`RangeRules.check`). Let `tc = slot0.tick`.
     - Token0 liquidity sits in `[max(tl, tc), tu)` and token1 in `[tl, min(tu, tc))`.
     - If `tu > tc`, require `max(tl, tc) >= refTick − band`.
     - If `tl < tc`, require `min(tu, tc) <= refTick + band`.
     - Otherwise revert `RangeOutsideFence(i, tl, tu, refTick, band)`.
     - In words: never offer either token more than the band worse than the reference. The rule is symmetric under
       token0/token1 orientation.
8. **Mint** each range:
   - `amount0 = bal0 · share0Bps / 1e4` and `amount1 = bal1 · share1Bps / 1e4`, from the idle balances after the
     unwind.
   - `forceApprove(NPM, exact)` for each token, then `NPM.mint({token0, token1, fee, tl, tu, a0, a1, mins 0, recipient:
     this, deadline: now})`, then `forceApprove(NPM, 0)`.
   - Mins of 0 are safe because steps 5–7 checked the price in the same transaction.
   - Store the tokenId in the first free slot. Emit `PositionMinted`.
9. **Notional:**
   - `usd6 = a0used·p0/(10^dec0·1e12) + a1used·p1/(10^dec1·1e12)`, rounded up.
   - Require `usd6 <= caps.maxDeployUsd6`, else `DeployCapExceeded`.
   - Debit the turnover bucket by `usd6`, else `BucketEmpty(0, …)`.
10. Set `lastRerangeAt = now` and emit `LaneAction(RERANGE, ticks = [tl0, tu0, tl1, tu1], refPxE18, …)`.
    `refPxE18` is quote per base at 1e18 (USDG per NVDA for this pool).
11. Return `(tokenIds, liquidities, amount0Used, amount1Used)` so the agent's `eth_call` can see them.

### Risk-reducing functions (never read the fence; allowed while paused)
- **`reduce(m, slot, liquidity)`** (operator, owner or guardian): `decreaseLiquidity`, then `collect` in try/catch.
  If the position's liquidity reaches 0 and the collect succeeded, `burn` it and free the slot.
- **`collect(m)`**: collect every slot, each in its own try/catch.
- **`exitAll(m)`** (operator, owner or guardian): unwind every slot with per-slot try/catch, so a failing slot is kept
  and emits `CollectFailed`. It **must never revert because a token is paused or blocklisted.** It keeps the tokens idle
  in the lane and never transfers out.
- **`signal(m)`**: emits `LaneAction(SIGNAL)` only.
- **`pause()`** (operator, owner or guardian) and **`unpause()`** (owner).

### Owner-only value exits
- `withdraw(token, amount)`: `safeTransfer` to the owner. Any ERC-20 is allowed, so a donated token can't get stuck.
- `withdrawAll()`: transfers token0 and token1 to the owner, each in its own try/catch.
- `withdrawPosition(slot)`: the NPM `transferFrom(this, owner, tokenId)`; frees the slot. This is the escape hatch that
  works even when NVDA is paused.
- All of these work while paused, and none reads the fence.

### Views
As in `IDeskLane`. `budgets()` returns the refilled levels as of `now`. `riskAddingOpen()` returns 100 when paused,
101 when `closedUntil` is active, or the first fence code. `refTick()` returns the code instead of reverting.

## ChainlinkFence (implements IPriceFence)
- The constructor takes `TokenConfig[] {token, feed, kind (STOCK | STABLE), maxAge}` and stores it immutably. There is
  no admin; a new config means a new fence.
- The M2 deployment configures USDG (STABLE, feed `0x61B7…9aD2`, maxAge 26 h) and NVDA (STOCK, `0x379E…9F15`, 26 h).
  Also add SPY, QQQ and TSLA (STOCK) so M3 can reuse it.
- **`usdPrice(token)`:**
  - `try latestRoundData()`; a revert gives code 7.
  - `answer <= 0` or `updatedAt > now` or `now − updatedAt > maxAge` gives code 2.
  - Otherwise `price = answer · 1e18 / 10^decimals()`, reading `decimals()` live (feeds changed from 18 to 8 on Jun 23).
  - Status checks run in priority order, and the first failure is returned:
    1. unknown token → 1
    2. feed checks → 2 or 7
    3. **STOCK only:**
       - `try IERC8056(token).oraclePaused()`: true gives 3;
       - `try newUIMultiplier()/effectiveAt()`: if `effectiveAt != 0` and `|now − effectiveAt| < 2 h`, give 4;
       - the closed window gives 5.
    4. **STABLE only:** `|price − 1e18| > 50 bp` gives 6.
- **Closed window** (STOCK, in UTC, conservative under both US DST states):
  - `dow = ((now / 86400) + 4) % 7`, where 0 is Sunday (unix epoch day 0 was a Thursday).
  - Closed from Saturday 00:00 UTC to Monday 01:00 UTC: `dow == 6`, or `dow == 0`, or (`dow == 1` and
    `secondOfDay < 3600`).
  - This matches the 24/5 feed schedule (Fri 20:00 → Sun 20:00 ET) with a margin.
- **`status(token)`** returns the same code as `usdPrice`. It never reverts.

## Factory
- **Constructor:** `(admin, V3_FACTORY, Caps ceilings)`.
- **Admin:** set implementations, allow pools and set ceilings; all of these affect NEW clones only. Admin changes use a
  two-step propose/accept.
- **`createLane(p)`** is permissionless. It requires:
  - `implementations[p.kind] != 0`
  - `poolAllowed[p.pool][p.kind]`
  - `IUniswapV3Factory(V3_FACTORY).getPool(token0, token1, fee) == p.pool`, reading the tokens and fee from the pool
  - `p.operator != 0 && p.operator != p.owner`
  - every Caps field within the ceilings (`CapsAboveCeiling(field)`)

  Then:
  - `salt = keccak256(abi.encode(p))`; the salt commits to every parameter.
  - `Clones.cloneDeterministicWithImmutableArgs(impl, args, salt)`, then `initialize(operator, guardian, caps)`.
  - Record `isLane`, append to `lanesOf[owner]`, emit `LaneCreated`.
- `predictLane(p)` returns the address before deployment, so the web can pre-set the Dynamic policy allowlist.

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
`minWidthTicks` the ceiling is a lower bound. Document which is which in `setCeilings`.

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
Profile: 1,000 runs × depth 100, `fail_on_revert = false`.

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
- `Deploy.s.sol`: fence, then factory, then `DeskLaneV3` implementation, then `setImplementation(1)`, then
  `setPoolAllowed(NVDA pool, 1)`. Writes `deployments/4663.json`.
- `CreateLane.s.sol`: `predictLane`, then `createLane`.
- `CheckDeployment.s.sol`: reads everything back and asserts it.
- The same deploy script is used on anvil forks by the agent's e2e tests.

## Gas (for reference)
- NPM mint ≈ 433k; full rerange (unwind + 1–2 mints) ≈ 0.7–1.2M.
- Gas price ≈ 0.07–0.3 gwei and ETH ≈ $2,630, so a full rerange costs about $0.1–0.9.
