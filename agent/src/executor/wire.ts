/**
 * The 4663 executor assembled from config: one per lane (the lane address, from config or the
 * registered desks table, is the only `to` it can produce). Entry points and scripts use this;
 * tests assemble createRhExecutor from fakes directly.
 */

import type { AppConfig } from "../config.js";
import { createAttemptResolver } from "../reconcile/startup.js";
import type {
  Address,
  ChainClient,
  Clock,
  DeskDb,
  DeskLogger,
  Executor,
  Notifier,
  Sleep,
  TxSigner,
} from "../types.js";
import { createBroadcaster } from "./broadcaster.js";
import { createCalldataBuilder } from "./calldata.js";
import { createFeePolicy } from "./fees.js";
import { createNonceManager } from "./nonce.js";
import { createRhExecutor } from "./rh-executor.js";
import { createSimulator } from "./simulate.js";

export interface RhExecutorWiring {
  cfg: AppConfig;
  laneAddress: Address;
  db: DeskDb;
  chain: ChainClient;
  signer: TxSigner;
  clock: Clock;
  logger: DeskLogger;
  notifier?: Notifier | undefined;
  ethUsd?: (() => number | null) | undefined;
  sleep?: Sleep | undefined;
}

export function rhExecutorFromConfig(w: RhExecutorWiring): Executor {
  const broadcaster = createBroadcaster({
    chain: w.chain,
    clock: w.clock,
    ...(w.sleep === undefined ? {} : { sleep: w.sleep }),
  });
  return createRhExecutor({
    db: w.db,
    chain: w.chain,
    signer: w.signer,
    calldata: createCalldataBuilder(w.laneAddress),
    simulator: createSimulator({ chain: w.chain }),
    fees: createFeePolicy({
      floorWei: w.cfg.limits.feeFloorWei,
      capWei: w.cfg.limits.maxFeePerGasWei,
    }),
    nonces: createNonceManager({
      db: w.db,
      chain: w.chain,
      chainId: w.cfg.chainId,
      now: () => w.clock.now(),
    }),
    broadcaster,
    resolver: createAttemptResolver({
      db: w.db,
      chain: w.chain,
      broadcaster,
      clock: w.clock,
      logger: w.logger,
      notifier: w.notifier,
      ethUsd: w.ethUsd,
    }),
    clock: w.clock,
    logger: w.logger,
    notifier: w.notifier,
    chainId: w.cfg.chainId,
    timing: {
      signTimeoutMs: w.cfg.timing.signTimeoutMs,
      receiptPollMs: w.cfg.timing.receiptPollMs,
      receiptTimeoutMs: w.cfg.timing.receiptTimeoutMs,
    },
    maxGasCents: w.cfg.limits.maxGasCents,
    ethUsd: w.ethUsd,
  });
}
