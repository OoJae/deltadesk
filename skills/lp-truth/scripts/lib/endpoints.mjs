// DeltaDesk x402 base URL (set to the deploying Bankr wallet after `bankr x402 deploy`).
export const DELTADESK_WALLET = "0x0000000000000000000000000000000000000000";
export const BASE = `https://x402.bankr.bot/${DELTADESK_WALLET}/`;
export const POOLS = ["NVDA", "SPY", "TSLA", "QQQ-SPY"];
export const url = (service, params = {}) => `${BASE}${service}?${new URLSearchParams(params)}`;
