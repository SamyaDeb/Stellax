// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/StellaXBridgeEVM.sol";

/**
 * Deployment script for StellaX EVM bridge on Avalanche Fuji.
 *
 * Prerequisites:
 *   1. Install Foundry: curl -L https://foundry.paradigm.xyz | bash
 *   2. Install deps: forge install foundry-rs/forge-std --no-git
 *   3. Fund a Fuji account with AVAX: https://faucet.avax.network
 *   4. Export private key: export PRIVATE_KEY=0x...
 *
 * Deploy:
 *   forge script script/Deploy.s.sol:Deploy \
 *     --rpc-url fuji \
 *     --broadcast \
 *     --private-key $PRIVATE_KEY
 *
 * After deploy, set the contract address in:
 *   - packages/frontend/src/wallet/evmWallet.ts  (EVM_BRIDGE constant)
 *   - packages/keeper/src/workers/bridge-keeper.ts (EVM_BRIDGE_ADDR constant)
 *
 * Then configure the Stellar bridge:
 *   scripts/init-bridge.sh <EVM_CONTRACT_ADDRESS>
 */
contract Deploy is Script {
    // ── Avalanche Fuji Axelar addresses ───────────────────────────────────────
    // Source: https://docs.axelar.dev/resources/contract-addresses/testnet
    address constant FUJI_GATEWAY     = 0xC249632c2D40b9001FE907806902f63038B737Ab;
    address constant FUJI_GAS_SERVICE = 0xbE406F0189A0B4cf3A05C286473D23791Dd44Cc6;

    // USDC on Avalanche Fuji (Circle testnet, native)
    // Mint at: https://faucet.circle.com (select "Avalanche Fuji")
    address constant FUJI_AUSDC       = 0x5425890298aed601595a70AB815c96711a31Bc65;

    // StellaX bridge C-address on Stellar testnet (deployed Phase 9)
    string constant STELLAR_BRIDGE_ADDRESS =
        "CDTZX3CTVVHN67ONILVY7PHSQDGZHMKCP3EM4NHATYUYA5J5NYSDZMVL";

    function run() external {
        uint256 deployer = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployer);

        StellaXBridgeEVM bridge = new StellaXBridgeEVM(
            FUJI_GATEWAY,
            FUJI_GAS_SERVICE,
            FUJI_AUSDC,
            STELLAR_BRIDGE_ADDRESS
        );

        console.log("===================================================");
        console.log("StellaXBridgeEVM deployed on Avalanche Fuji:");
        console.log(address(bridge));
        console.log("===================================================");
        console.log("Next steps:");
        console.log("1. Copy the address above.");
        console.log("2. Run: scripts/init-bridge.sh <ADDRESS>");
        console.log("3. Set EVM_BRIDGE in packages/frontend/src/wallet/evmWallet.ts");
        console.log("4. Set EVM_BRIDGE_ADDR in packages/keeper/src/workers/bridge-keeper.ts");
        console.log("===================================================");

        vm.stopBroadcast();
    }
}
