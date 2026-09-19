# Uniswap developer feedback: DeltaDesk on Robinhood Chain (4663)

DeltaDesk is the open market-making desk for tokenized stocks. We built two things on Uniswap on Robinhood Chain:

- **The truth layer (read side).** Every swap and every LP position in NVDA/USDG (v3) and SPY/USDG, TSLA/USDG and
  QQQ/SPY (v4) since launch, rebuilt from logs: 3.34M swaps and 17,124 positions. Each position gets its fees, the
  value informed flow picked off (marked against Hyperliquid) and its IL. Attributed fees conserve pool fees exactly,
  and golden positions match on-chain collects within 0.0011 bp.
- **The desk (write side).** `DeskLaneV3`, a per-user lane contract. It holds Uniswap v3 NPM positions on the
  NVDA/USDG pool and is driven by a delegated agent: it places ranges from its own inventory behind an on-chain price
  fence and an execution-time tick guard.

Notes are ordered by how much time each one cost us. Every claim points to the code or data where we hit it.

## 1. The Robinhood Chain Universal Router in the docs is the superseded deployment

| Source (checked 2026-09-19) | Universal Router on 4663 |
|---|---|
| developers.uniswap.org → v4 deployments, v3 Robinhood Chain deployments, Swapping API supported chains | `0x8876789976decbfcbbbe364623c63652db8c0904` |
| `Uniswap/contracts` → `deployments/json/4663.json` (`latest.UniversalRouter`) | `0x06afBA43fd06227fA663b0dAeCF536F6eaA6BF99` (constructor `spokePool` `0xD29C85F15DF544bA632C9E25829fd29d767d7978`) |

- Both addresses have code on 4663 (24,546 bytes each).
- Uniswap/docs PR #1161, "docs: update Robinhood Chain Universal Router address", explains the difference. The
  redeploy of 2026-07-06 carries the production Across SpokePool. The old deployment has a placeholder, so Across
  commands revert on it.
- That PR was closed without merging on 2026-09-18, so the three docs pages still point integrators at the old router.
- Skills and agents copy addresses from the docs. Igor's `hood-stock-lp` pins `0x8876…0904`, for example.
- **Ask:**
  - Generate the per-chain docs tables from `deployments/json/<chainId>.json`, or link that file from every
    deployments page.
  - Mark superseded deployments explicitly instead of silently keeping them.

The rest of the 4663 table matched the JSON and the chain. These are the addresses we pinned, each checked with
read-only `cast` calls ([`contracts/script/Addresses4663.sol:8-16`](contracts/script/Addresses4663.sol#L8-L16),
[`engine/positions/reconstruct.py:40-42`](engine/positions/reconstruct.py#L40-L42), [`engine/api/live.py:25`](engine/api/live.py#L25)):

| Contract | Address |
|---|---|
| v3 Factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` |
| NonfungiblePositionManager | `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3` |
| SwapRouter02 | `0xCaf681a66D020601342297493863E78C959E5cb2` |
| QuoterV2 | `0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7` |
| v4 PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |
| v4 PositionManager | `0x58daec3116aae6d93017baaea7749052e8a04fa7` |
| v4 StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` |
| NVDA/USDG v3 pool (fee 500, spacing 10) | `0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3` |

## 2. The v4 `Swap.fee` is the combined fee, and nothing on-chain says how much of it LPs get

- **The problem.** The v4 `Swap` event's `fee` is the total swap fee: `protocolFee + lpFee − protocolFee·lpFee/1e6`.
  To know what LPs earned, you have to invert that formula against the pool's `lpFee` from the PoolKey, including
  its rounding ([`engine/markout/pools.py:182-185`](engine/markout/pools.py#L182-L185)).
- **What we measured** in the `fee` field over each pool's full history:

  | Pool | lpFee | `Swap.fee` values seen | Implied protocolFee |
  |---|---|---|---|
  | SPY/USDG | 500 | 625 on all 249,312 swaps | 125 pips |
  | QQQ/SPY | 200 | 252 on all 2,689 swaps | 52 pips |
  | TSLA/USDG | 3000 | 3000 on 28,837 swaps, then 3499 on 135,089 | 0, then about 500 |

- The TSLA pool's protocol fee was switched on partway through its life.
- Without that inversion, a fee study silently credits LPs with the protocol's cut. In SPY/USDG that is 20% of every
  fee.
- v3 has the same trap in a different form. NVDA/USDG runs `feeProtocol = 68` (1/4 of each fee), so historical
  attribution needs every `SetFeeProtocol` event ([`pools.py:111-121`](engine/markout/pools.py#L111-L121)). There,
  `feeGrowthGlobal` already excludes the cut, and over a 345-swap live window our swap-derived LP fees reconciled to it
  within 0.27% on the USDG side and exactly on the NVDA side
  ([`engine/indexer/reconcile.py`](engine/indexer/reconcile.py)).
- **Ask:**
  - Emit `protocolFee`, or the LP fee, in the v4 `Swap` event.
  - Document the inversion, with its rounding, next to the event definition.

## 3. v4 fees have no event, so fee accounting cannot be reconciled from logs

- In v4, fees settle inside `modifyLiquidity`, and the `ModifyLiquidity` event carries no fee amount. `feesAccrued`
  is returned to the caller but never logged.
- **The consequence.** For v3 we reconcile every fully collected (NFT-burned) NPM position of $1k or more against its
  on-chain `Collect`: 1,938 positions, all under 1 bp. For v4 there is nothing to reconcile against. We attribute v4
  fees with our own `feeGrowth` sweep ([`engine/positions/attribute.py:146`](engine/positions/attribute.py#L146)) and
  can only check conservation at the pool level.
- The alternative is `StateView.getFeeGrowthInside` at every modify block. That needs an archive node, and the public
  4663 RPC serves roughly the last 5,000–20,000 blocks
  ([`contracts/reports/fork-public-2026-09-19.txt`](contracts/reports/fork-public-2026-09-19.txt)).
- **Ask:** add `feesAccrued` (two int128 values) to `ModifyLiquidity`, or emit a separate fees event. Position-level
  P&L then becomes an indexing problem instead of an archive-node problem.

## 4. Linking v3 NPM tokenIds to ticks takes a same-transaction join across two contracts

- **The problem.**
  - The pool's `Mint` has `owner = NPM` and no tokenId.
  - The NPM's `IncreaseLiquidity` has the tokenId and no ticks.
  - The only link is "the `IncreaseLiquidity` right after the pool `Mint` in the same transaction, with the same
    liquidity" ([`engine/positions/reconstruct.py:338-351`](engine/positions/reconstruct.py#L338-L351)).
  - A zero-liquidity pool `Burn` from the NPM is a fee poke by `NPM.collect()`, not an exit
    ([`reconstruct.py:323-328`](engine/positions/reconstruct.py#L323-L328)).
- **Our workaround.**
  - We pull every log of every transaction that touches a covered pool with a HyperSync `JOIN_ALL` query
    ([`engine/indexer/hs_backfill.py:79-81`](engine/indexer/hs_backfill.py#L79-L81)).
  - That linked 16,785 of 16,785 NPM mints on Robinhood Chain.
  - It also linked 60,936 of 60,936 on Aerodrome Slipstream, a v3 fork with the same event layout.
- **Ask:** document this recipe on the v3 NPM page. Better still, emit ticks and pool in `IncreaseLiquidity` in the
  next periphery version.

## 5. v4 PositionManager: salt = tokenId, and positions are not enumerable

- A POSM position shows up in `ModifyLiquidity` with `sender = POSM` and `salt = bytes32(tokenId)`
  ([`reconstruct.py:405-406`](engine/positions/reconstruct.py#L405-L406)). This is the key that joins pool events to
  NFTs. We found it by reading the POSM source, not the docs.
- POSM is not ERC721Enumerable. So a wallet's v4 positions can only be found by scanning `Transfer` logs to it,
  which is also how `hood-stock-lp` does it.
- **Ask:**
  - State the salt convention on the PositionManager page.
  - Consider a lens that lists positions by owner.

## 6. Swap amount signs differ between v3 and v4

- v3 `Swap` amounts are the pool's balance deltas. v4 `Swap` amounts are the swapper's deltas, the opposite sign
  ([`pools.py:13-14`](engine/markout/pools.py#L13-L14), [`:162-163`](engine/markout/pools.py#L162-L163)).
- Both are correct, and both are documented somewhere. A decoder written for one silently inverts every trade from
  the other.
- **Ask:** one table in the docs with the sign convention of every `Swap` and `ModifyLiquidity` field across v3 and
  v4.

## 7. Building a 0.8 contract on v3 (the desk lane)

- **Interfaces and math.** `DeskLaneV3` is solc 0.8.26. We used hand-written minimal 0.8 interfaces for the v3 pool,
  factory and NPM ([`contracts/src/interfaces/external/`](contracts/src/interfaces/external/)) and v4-core's 0.8
  `TickMath`/`FullMath` ([`contracts/src/libraries/PriceMath.sol:5-6`](contracts/src/libraries/PriceMath.sol#L5-L6)).
  A maintained 0.8 interface package for v3 periphery, with a 0.8 `LiquidityAmounts`, would remove that step.
- **Real Uniswap in tests.** Local tests deploy the real v3 factory and NPM from the npm artifacts (`v3-core 1.0.1`,
  `v3-periphery 1.4.4`) with `vm.getCode`. The pool init code hash matches the canonical one, so the NPM derives the
  right pool addresses ([`contracts/test/utils/V3Deployer.sol:6-21`](contracts/test/utils/V3Deployer.sol#L6-L21)).
  It worked first time. A documented "deploy real v3 in Foundry" helper would save others the search.
- **Pool validation.** The factory validates every lane's pool with `V3Factory.getPool(t0, t1, fee)`
  ([`contracts/src/DeskLaneFactory.sol:83`](contracts/src/DeskLaneFactory.sol#L83)). The lane checks that
  `NPM.factory()` is that same factory ([`DeskLaneV3.sol:45-47`](contracts/src/DeskLaneV3.sol#L45-L47)), so a
  look-alike NPM or pool is rejected at construction.
- **Minting.** The lane mints through the NPM with exact approvals, reset to 0 in the same call. It mints with
  `amount0Min = amount1Min = 0` because its own tick guard and placement fence check the price in the same
  transaction ([`DeskLaneV3.sol:232-255`](contracts/src/DeskLaneV3.sol#L232-L255)). A docs note on when zero mins
  are safe would help: only with an in-transaction price check.
- **Moving the price on a fork.** Fork tests move the pool with real swaps through SwapRouter02 with a price limit,
  which keeps tick crossings and fee growth consistent ([`agent/README.md`](agent/README.md), "Fork e2e notes").
  `SwapRouter02`'s `exactInputSingle` struct has no `deadline`, unlike the original `SwapRouter`. Examples that
  mix the two produce the wrong selector.

## 8. Robinhood Chain details that matter to anyone building LP agents on Uniswap there

- **RPC history.** The public RPC serves only recent state: `eth_call` about 5,000–20,000 blocks back, roughly
  30 minutes. Pinned forks and historical `feeGrowthInside` reads need an archive RPC.
- **`block.number`.** It is the L1 block estimate (Arbitrum Orbit), so time limits must use `block.timestamp`.
  [`contracts/scripts/check-no-block-number.sh`](contracts/scripts/check-no-block-number.sh) fails the test run on any
  `block.number` in `contracts/src`.
- **Weekend feeds.** Stock-token Chainlink feeds pause from Fri 20:00 to Sun 20:00 ET. Feed decimals changed from 18
  to 8 on 2026-06-23 ([`contracts/src/ChainlinkFence.sol:119`](contracts/src/ChainlinkFence.sol#L119)). The pools
  keep trading 24/7, so any oracle-bounded LP logic needs a closed-market mode.
- **Pausable stock tokens.** A paused stock token makes `collect`'s transfer revert. Exits must not assume
  `decreaseLiquidity` + `collect` + `burn` is atomic ([`DeskLaneV3.sol:120-132`](contracts/src/DeskLaneV3.sol#L120-L132)).

## What worked well

- `StateView.getSlot0(poolId)` for v4 pool mids, with the same code path as v3 `slot0()`
  ([`engine/api/live.py:90-95`](engine/api/live.py#L90-L95)).
- `poolId` as `topic1` of every v4 `Swap` and `ModifyLiquidity`, so one indexed filter selects a pool on the
  singleton.
- `feeGrowthGlobal` as a reconciliation target. It turned "we think fees are right" into a pass/fail check.
- Deterministic v3 pool addresses plus `getPool`: pool validation needs no allowlist of our own.
- `deployments/json/4663.json` in `Uniswap/contracts` as the single source of truth, once we found it.
