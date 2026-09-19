#!/bin/sh
# Reinstall the vendored Solidity dependencies at the pinned revisions (lib/ and node_modules/ are not committed).
set -e
cd "$(dirname "$0")"
rm -rf lib && mkdir lib
git clone -q --depth 1 --branch v1.16.2 https://github.com/foundry-rs/forge-std lib/forge-std
git clone -q --depth 1 --branch v5.4.0 https://github.com/OpenZeppelin/openzeppelin-contracts lib/openzeppelin-contracts
git clone -q https://github.com/Uniswap/v4-core lib/v4-core && git -C lib/v4-core checkout -q cd98eff28324bfac652e63a239a60632a761790b
npm ci --silent   # @uniswap/v3-core@1.0.1, @uniswap/v3-periphery@1.4.4 (compiled artifacts for local tests)
