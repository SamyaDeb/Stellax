// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title StellaXBridgeEVM
 * @notice EVM-side endpoint for the StellaX cross-chain bridge.
 *
 * Inbound flow (EVM → Stellar):
 *   1. User calls depositToStellar(amount, stellarRecipient)
 *   2. Contract escrows aUSDC and sends an Axelar GMP message.
 *   3. Axelar relayer delivers the message to the Stellar bridge contract.
 *   4. Keeper on Stellar calls bridge_collateral_in() to credit the vault.
 *
 * Outbound flow (Stellar → EVM):
 *   1. User calls bridge_collateral_out() on the Stellar bridge.
 *   2. Stellar bridge sends a GMP message via Axelar Gateway.
 *   3. Axelar relayer calls execute() here once threshold is met.
 *   4. Contract releases escrowed aUSDC to the EVM recipient.
 *
 * Deployed on: Avalanche Fuji (testnet)
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

interface IAxelarGateway {
    function callContract(
        string calldata destinationChain,
        string calldata destinationContractAddress,
        bytes calldata payload
    ) external;

    function validateContractCall(
        bytes32 commandId,
        string calldata sourceChain,
        string calldata sourceAddress,
        bytes32 payloadHash
    ) external returns (bool);
}

interface IAxelarGasService {
    function payNativeGasForContractCall(
        address sender,
        string calldata destinationChain,
        string calldata destinationContractAddress,
        bytes calldata payload,
        address refundAddress
    ) external payable;
}

contract StellaXBridgeEVM {
    // ── Axelar integration ────────────────────────────────────────────────────

    IAxelarGateway    public immutable gateway;
    IAxelarGasService public immutable gasService;

    // ── Collateral token ─────────────────────────────────────────────────────

    /// aUSDC on Avalanche Fuji (Circle testnet token)
    IERC20 public immutable usdc;

    // ── Chain identifiers ─────────────────────────────────────────────────────

    /// Axelar chain identifier for Stellar testnet (quarterly versioned by Axelar).
    string public constant STELLAR_CHAIN = "stellar-2026-q1-2";

    // ── Action codes (must match Rust contract constants) ────────────────────

    uint32 public constant ACTION_DEPOSIT  = 1;
    uint32 public constant ACTION_WITHDRAW = 2;

    // ── State ─────────────────────────────────────────────────────────────────

    address public admin;
    /// Stellar bridge contract address (C-address, 56 chars).
    string  public stellarBridgeAddress;
    bool    public paused;

    // ── Events ────────────────────────────────────────────────────────────────

    event Deposited(
        address indexed sender,
        string  stellarRecipient,
        uint256 amount,
        bytes32 payloadHash
    );

    event Released(
        address indexed recipient,
        uint256 amount,
        bytes32 commandId
    );

    event BridgeAddressUpdated(string newAddress);
    event Paused();
    event Unpaused();

    // ── Errors ────────────────────────────────────────────────────────────────

    error NotAdmin();
    error ContractPaused();
    error ZeroAmount();
    error InvalidStellarAddress();
    error InvalidEVMAddress();
    error TransferFailed();
    error NotApprovedByGateway();
    error UntrustedSource();
    error UnknownAction();
    error InsufficientReserve();

    // ── Modifiers ─────────────────────────────────────────────────────────────

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    // ── Constructor ───────────────────────────────────────────────────────────

    /**
     * @param _gateway              Axelar Gateway on Avalanche Fuji
     * @param _gasService           Axelar Gas Service on Avalanche Fuji
     * @param _usdc                 aUSDC token address on Fuji
     * @param _stellarBridgeAddress Deployed StellaX bridge C-address on Stellar testnet
     */
    constructor(
        address _gateway,
        address _gasService,
        address _usdc,
        string memory _stellarBridgeAddress
    ) {
        gateway              = IAxelarGateway(_gateway);
        gasService           = IAxelarGasService(_gasService);
        usdc                 = IERC20(_usdc);
        stellarBridgeAddress = _stellarBridgeAddress;
        admin                = msg.sender;
    }

    // ── Inbound: EVM → Stellar ────────────────────────────────────────────────

    /**
     * @notice Deposit aUSDC and trigger a cross-chain credit on Stellar.
     *
     * @param amount           aUSDC amount (6-decimal).
     * @param stellarRecipient User's Stellar G-address (56 ASCII chars).
     *
     * @dev msg.value must cover Axelar relayer gas. Minimum 0.05 AVAX testnet.
     *      Excess is refunded by the gas service to msg.sender.
     */
    function depositToStellar(
        uint256 amount,
        string calldata stellarRecipient
    ) external payable whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        bytes memory addrBytes = bytes(stellarRecipient);
        if (addrBytes.length != 56) revert InvalidStellarAddress();

        // Pull aUSDC from sender into this contract.
        if (!usdc.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();

        // Build the cross-chain payload.
        // Layout matches Rust bridge:
        //   [0..4]    action_type  : u32 big-endian
        //   [4..36]   field_1      : 32 bytes — Stellar address UTF-8, left-padded to 32
        //   [36..68]  field_2      : 32 bytes — zeroed (token field, resolved on Stellar side)
        //   [68..100] field_3      : 32 bytes — amount (big-endian, lower 16 bytes are i128)
        bytes memory payload = _encodeDepositPayload(amount, stellarRecipient);
        bytes32 payloadHash  = keccak256(payload);

        // Pay relayer gas in native AVAX (msg.value). Refund excess to msg.sender.
        if (msg.value > 0) {
            gasService.payNativeGasForContractCall{value: msg.value}(
                address(this),
                STELLAR_CHAIN,
                stellarBridgeAddress,
                payload,
                msg.sender
            );
        }

        // Dispatch GMP message.
        gateway.callContract(STELLAR_CHAIN, stellarBridgeAddress, payload);

        emit Deposited(msg.sender, stellarRecipient, amount, payloadHash);
    }

    // ── Outbound: Stellar → EVM ───────────────────────────────────────────────

    /**
     * @notice Called by the Axelar relayer when the Stellar bridge sends a
     *         withdrawal message. Releases escrowed aUSDC to the EVM recipient.
     *
     * @dev Only the Axelar Gateway can trigger this after validating the
     *      cross-chain message. Validated via gateway.validateContractCall().
     */
    function execute(
        bytes32 commandId,
        string calldata sourceChain,
        string calldata sourceAddress,
        bytes calldata payload
    ) external whenNotPaused {
        // 1. Validate through Axelar Gateway (marks the message consumed).
        bytes32 payloadHash = keccak256(payload);
        if (!gateway.validateContractCall(commandId, sourceChain, sourceAddress, payloadHash)) {
            revert NotApprovedByGateway();
        }

        // 2. Only accept from our Stellar bridge address.
        if (keccak256(bytes(sourceAddress)) != keccak256(bytes(stellarBridgeAddress))) {
            revert UntrustedSource();
        }

        // 3. Decode action.
        if (payload.length < 100) revert UnknownAction();
        uint32 action = uint32(bytes4(payload[0:4]));

        if (action == ACTION_DEPOSIT) {
            // Stellar-initiated deposit confirmation — no EVM-side action required.
            return;
        }

        if (action == ACTION_WITHDRAW) {
            // field_1 bytes [4..36]: EVM recipient address.
            // The Stellar bridge encodes the EVM address as 20 bytes right-padded
            // inside a 32-byte field (EVM convention: address = right-aligned uint160).
            address recipient = address(uint160(uint256(bytes32(payload[4:36]))));
            if (recipient == address(0)) revert InvalidEVMAddress();

            // field_3 bytes [68..100]: amount (lower 16 bytes of a big-endian 32-byte i128).
            // Take bytes [84..100] (the meaningful 16 bytes).
            uint128 amount = uint128(bytes16(payload[84:100]));
            if (amount == 0) revert ZeroAmount();

            if (usdc.balanceOf(address(this)) < amount) revert InsufficientReserve();

            if (!usdc.transfer(recipient, amount)) revert TransferFailed();

            emit Released(recipient, amount, commandId);
            return;
        }

        revert UnknownAction();
    }

    // ── Admin helpers ─────────────────────────────────────────────────────────

    /// Update the Stellar bridge address (e.g. after a contract upgrade).
    function setStellarBridgeAddress(string calldata addr) external onlyAdmin {
        stellarBridgeAddress = addr;
        emit BridgeAddressUpdated(addr);
    }

    /// Pre-fund the contract with aUSDC reserves for outbound withdrawals.
    function fundReserve(uint256 amount) external {
        if (!usdc.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
    }

    /// Emergency rescue for stuck tokens. Does NOT affect live user funds.
    function rescueUsdc(uint256 amount) external onlyAdmin {
        if (!usdc.transfer(admin, amount)) revert TransferFailed();
    }

    /// Transfer admin role.
    function transferAdmin(address newAdmin) external onlyAdmin {
        admin = newAdmin;
    }

    function pause() external onlyAdmin { paused = true; emit Paused(); }
    function unpause() external onlyAdmin { paused = false; emit Unpaused(); }

    // ── View helpers ──────────────────────────────────────────────────────────

    function usdcBalance() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    function _encodeDepositPayload(
        uint256 amount,
        string calldata stellarRecipient
    ) internal pure returns (bytes memory) {
        // A Stellar G-address is exactly 56 ASCII chars.
        // We pack the full address across field_1 (chars 0-31) and field_2 (chars 32-55).
        //
        // Solidity lays out `bytes(stellarRecipient)` in memory as:
        //   [32-byte length][56 bytes data][8 bytes zero-padding to next word boundary]
        // So mload(addrBytes+32) = chars  0-31  (field_1)
        //    mload(addrBytes+64) = chars 32-63  (upper 24 = chars 32-55, lower 8 = 0x00)
        bytes32 field1;
        bytes32 field2;
        bytes memory addrBytes = bytes(stellarRecipient);
        assembly {
            field1 := mload(add(addrBytes, 32))
            // chars 32-55 land in the upper 24 bytes; lower 8 bytes are already
            // zero-padded by Solidity, so field2 carries the full second half cleanly.
            field2 := mload(add(addrBytes, 64))
        }

        // field_3: amount as big-endian uint128 in the lower 16 bytes.
        bytes32 field3 = bytes32(uint256(uint128(amount)));

        return abi.encodePacked(
            ACTION_DEPOSIT, // uint32 → 4 bytes
            field1,         // bytes32 (32 bytes) — stellarRecipient chars  0-31
            field2,         // bytes32 (32 bytes) — stellarRecipient chars 32-55 + 8 zero bytes
            field3          // bytes32 (32 bytes) — lower 16 bytes = amount (uint128)
        );
    }

    receive() external payable {}
}
