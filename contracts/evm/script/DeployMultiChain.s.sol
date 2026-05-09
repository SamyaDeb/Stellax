// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/StellaXBridgeEVM.sol";

/**
 * Multi-chain deployment script for StellaXBridgeEVM on Arbitrum, Base, and
 * Optimism mainnets (Phase G).
 *
 * The EVM contract is chain-agnostic; only constructor parameters differ per
 * chain. This script reads the target chain from the `CHAIN` environment
 * variable and selects the appropriate Axelar gateway, gas service, and USDC
 * addresses.
 *
 * Usage:
 *   export PRIVATE_KEY=0x...
 *   export CHAIN=arbitrum   # or: base, optimism, avalanche
 *   forge script script/DeployMultiChain.s.sol:DeployMultiChain \
 *     --rpc-url $CHAIN \
 *     --broadcast \
 *     --private-key $PRIVATE_KEY \
 *     --verify
 *
 * After each deploy:
 *   1. Record the deployed address.
 *   2. Call on Stellar:
 *        stellar contract invoke --id <BRIDGE_CONTRACT_ID> --source-account stellax-deployer \
 *          --network mainnet -- update_trusted_source \
 *          --chain_name "<chain>" --address "<EVM_ADDRESS>"
 *   3. Append the entry to `EVM_BRIDGES` in
 *      packages/keeper/src/workers/bridge-keeper.ts.
 *   4. Append the chain option in
 *      packages/frontend/src/pages/BridgePage.tsx.
 */
contract DeployMultiChain is Script {
    struct ChainConfig {
        address gateway;
        address gasService;
        address usdc;
        string stellarBridge;
        string chainName;
    }

    // ── Stellar bridge (mainnet) — must be set once the Stellar bridge is
    //    promoted to mainnet (Phase K). Keep testnet value as a placeholder.
    string constant STELLAR_BRIDGE_ADDRESS =
        "CDTZX3CTVVHN67ONILVY7PHSQDGZHMKCP3EM4NHATYUYA5J5NYSDZMVL";

    // ── Axelar mainnet contract addresses ─────────────────────────────────────
    // Source: https://docs.axelar.dev/resources/contract-addresses/mainnet

    // Arbitrum One
    address constant ARB_GATEWAY     = 0xe432150cce91c13a887f7D836923d5597adD8E31;
    address constant ARB_GAS_SERVICE = 0x2d5d7d31F671F86C782533cc367F14109a082712;
    address constant ARB_USDC        = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831; // native USDC

    // Base Mainnet
    address constant BASE_GATEWAY     = 0xe432150cce91c13a887f7D836923d5597adD8E31;
    address constant BASE_GAS_SERVICE = 0x2d5d7d31F671F86C782533cc367F14109a082712;
    address constant BASE_USDC        = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913; // native USDC

    // Optimism Mainnet
    address constant OP_GATEWAY       = 0xe432150cce91c13a887f7D836923d5597adD8E31;
    address constant OP_GAS_SERVICE   = 0x2d5d7d31F671F86C782533cc367F14109a082712;
    address constant OP_USDC          = 0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85; // native USDC

    // Avalanche Fuji (testnet) — included for symmetry with the single-chain script
    address constant FUJI_GATEWAY     = 0xC249632c2D40b9001FE907806902f63038B737Ab;
    address constant FUJI_GAS_SERVICE = 0xBe406F0189A0b4cF3A05c286473d23791Dd44cC7;
    address constant FUJI_AUSDC       = 0x57F1c63497AEe0bE305B8852b354CEc793da43bB;

    function configFor(string memory chain) internal pure returns (ChainConfig memory) {
        bytes32 key = keccak256(bytes(chain));
        if (key == keccak256(bytes("arbitrum"))) {
            return ChainConfig({
                gateway:       ARB_GATEWAY,
                gasService:    ARB_GAS_SERVICE,
                usdc:          ARB_USDC,
                stellarBridge: STELLAR_BRIDGE_ADDRESS,
                chainName:     "arbitrum"
            });
        }
        if (key == keccak256(bytes("base"))) {
            return ChainConfig({
                gateway:       BASE_GATEWAY,
                gasService:    BASE_GAS_SERVICE,
                usdc:          BASE_USDC,
                stellarBridge: STELLAR_BRIDGE_ADDRESS,
                chainName:     "base"
            });
        }
        if (key == keccak256(bytes("optimism"))) {
            return ChainConfig({
                gateway:       OP_GATEWAY,
                gasService:    OP_GAS_SERVICE,
                usdc:          OP_USDC,
                stellarBridge: STELLAR_BRIDGE_ADDRESS,
                chainName:     "optimism"
            });
        }
        if (key == keccak256(bytes("avalanche"))) {
            return ChainConfig({
                gateway:       FUJI_GATEWAY,
                gasService:    FUJI_GAS_SERVICE,
                usdc:          FUJI_AUSDC,
                stellarBridge: STELLAR_BRIDGE_ADDRESS,
                chainName:     "Avalanche"
            });
        }
        revert("DeployMultiChain: unknown CHAIN (expected arbitrum|base|optimism|avalanche)");
    }

    function run() external {
        string memory chain = vm.envString("CHAIN");
        ChainConfig memory cfg = configFor(chain);

        uint256 deployer = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployer);

        StellaXBridgeEVM bridge = new StellaXBridgeEVM(
            cfg.gateway,
            cfg.gasService,
            cfg.usdc,
            cfg.stellarBridge
        );

        console.log("===================================================");
        console.log("StellaXBridgeEVM deployed on chain:");
        console.log(cfg.chainName);
        console.log("Address:");
        console.log(address(bridge));
        console.log("===================================================");
        console.log("Next steps:");
        console.log("1. update_trusted_source on Stellar bridge for this chain.");
        console.log("2. Append to EVM_BRIDGES in packages/keeper/src/workers/bridge-keeper.ts.");
        console.log("3. Append to chain selector in packages/frontend/src/pages/BridgePage.tsx.");
        console.log("===================================================");

        vm.stopBroadcast();
    }
}
