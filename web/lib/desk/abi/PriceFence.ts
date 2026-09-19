// GENERATED from contracts/abi/IPriceFence.json (the FROZEN M2 interface snapshot) plus the "fence" errors, events and
// no views from contracts/abi/extras.json. Do not edit by hand.
// Regenerate: node web/lib/desk/abi/sync.mjs

export const priceFenceAbi = [
  {
    "type": "function",
    "name": "status",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "code",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "usdPrice",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "priceE18",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "updatedAt",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "code",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "error",
    "name": "BadConfig",
    "inputs": [
      {
        "name": "index",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  }
] as const;
