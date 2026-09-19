ABIs of the FROZEN M2 interfaces (`src/interfaces/`), snapshotted so the agent and web can build against them while
the implementations are written. Regenerate after any interface change:

    forge build && for n in IDeskLane IDeskLaneFactory IPriceFence IDeskTypes; do jq .abi out/$n.sol/$n.json > abi/$n.json; done
