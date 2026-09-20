#!/bin/sh
# Reinstall the vendored Solidity dependencies at the pinned revisions (lib/ and node_modules/ are not committed).
# Run this once after a fresh clone, before `forge build` / `forge test`.
set -e
cd "$(dirname "$0")"
# node_modules first: the local suite reads @uniswap/v3-core and v3-periphery compiled artifacts through vm.getCode,
# so a failure later in this script must not leave them missing (9 tests fail with "no matching artifact found").
npm ci --silent   # @uniswap/v3-core@1.0.1, @uniswap/v3-periphery@1.4.4 (compiled artifacts for local tests)
rm -rf lib && mkdir lib
git clone -q --depth 1 --branch v1.16.2 https://github.com/foundry-rs/forge-std lib/forge-std
git clone -q --depth 1 --branch v5.4.0 https://github.com/OpenZeppelin/openzeppelin-contracts lib/openzeppelin-contracts
git clone -q --depth 1 --branch v4.0.0 https://github.com/Uniswap/v4-core lib/v4-core
