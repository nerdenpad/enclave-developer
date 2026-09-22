pragma solidity ^0.8.28;

import {MockUSDC} from "./MockUSDC.sol";
import {IArcConfidentialTransfer} from "./interfaces/IArcConfidentialTransfer.sol";
import {AgentMandate} from "./AgentMandate.sol";
import {ModelRegistry} from "./ModelRegistry.sol";

/// @notice Per-call USDC settlement hook (x402). Confidential path is a stub until Arc ABIs are pinned.
contract UsageMeter {
    uint256 public constant X402_VERSION = 2;
    struct FundingBlock { uint256 number; bytes32 hash; }
    address public owner;
    MockUSDC public usdc;
    address public feeVault;
    IArcConfidentialTransfer public confidential;
    AgentMandate public mandate;
    ModelRegistry public modelRegistry;
    bool private entered;

    mapping(bytes32 => bool) public settled;
    mapping(address => uint256) public spent;
    mapping(uint256 => uint256) public providerEarned;
    mapping(uint256 => uint256) public listingVolume;
    mapping(bytes32 => bytes32) public x402AuthorizationPayments;
    bytes32 private constant TRANSFER_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    event Settled(address indexed payer, uint256 amount, bytes32 indexed receiptHash, bool confidentialPath);
    event ProviderFeePaid(uint256 indexed listingId, address indexed provider, bytes32 indexed paymentId, uint256 amount);
    event AgentSettled(bytes32 indexed agent, bytes32 indexed paymentId, address indexed payer, uint256 amount);
    event X402AuthorizationConsumed(address indexed payer, bytes32 indexed nonce, bytes32 indexed paymentId, bool prepaid);

    modifier nonReentrant() {
        require(!entered, "reentrant");
        entered = true;
        _;
        entered = false;
    }

    constructor(address usdc_, address feeVault_) {
        require(usdc_ != address(0) && feeVault_ != address(0), "zero");
        owner = msg.sender;
        usdc = MockUSDC(usdc_);
        feeVault = feeVault_;
    }

    function setConfidential(address next) external {
        require(msg.sender == owner, "owner");
        confidential = IArcConfidentialTransfer(next);
    }

    function setMandate(address next) external {
        require(msg.sender == owner, "owner");
        require(next != address(0) && next.code.length > 0, "mandate config");
        mandate = AgentMandate(next);
    }

    function setModelRegistry(address next) external {
        require(msg.sender == owner, "owner");
        require(next != address(0) && next.code.length > 0, "registry config");
        modelRegistry = ModelRegistry(next);
    }

    function settle(address payer, uint256 amount, bytes32 receiptHash) external nonReentrant {
        _settle(payer, amount, receiptHash, bytes32(0), 0, false);
    }

    function settleAgent(address payer, bytes32 agent, uint256 amount, bytes32 paymentId) external nonReentrant {
        require(agent != bytes32(0), "agent");
        _settle(payer, amount, paymentId, agent, 0, false);
    }

    function settleModel(address payer, uint256 amount, bytes32 paymentId, uint256 listingId, bytes32 agent) external nonReentrant {
        require(listingId > 0, "listing");
        _settle(payer, amount, paymentId, agent, listingId, false);
    }

    /// @notice EIP-3009 authorizes the transfer, while the owner relay is trusted to bind listing/agent terms.
    /// The payer may submit directly. Untrusted relayers cannot substitute routing or omit a mandate.
    function settleAuthorized(address from, uint256 amount, bytes32 paymentId, uint256 listingId, bytes32 agent,
        uint256 validAfter, uint256 validBefore, bytes calldata signature) external nonReentrant {
        require(msg.sender == owner || msg.sender == from, "relayer");
        require(!settled[paymentId], "replay");
        _receiveAuthorized(from, amount, paymentId, validAfter, validBefore, signature);
        _settle(from, amount, paymentId, agent, listingId, true);
    }

    function _receiveAuthorized(address from, uint256 amount, bytes32 paymentId, uint256 validAfter, uint256 validBefore,
        bytes calldata signature) internal {
        require(signature.length == 65, "signature");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        uint256 beforeBalance = usdc.balanceOf(address(this));
        usdc.receiveWithAuthorization(from, address(this), amount, validAfter, validBefore, paymentId, v, r, s);
        require(usdc.balanceOf(address(this)) - beforeBalance == amount, "received");
    }

    /// @notice Standard x402 exact/EIP-3009 transfer signature and independently chosen client nonce.
    function settleTransferAuthorized(address from, uint256 amount, bytes32 paymentId, uint256 listingId, bytes32 agent,
        uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes calldata signature) external nonReentrant {
        require(msg.sender == owner || msg.sender == from, "relayer");
        _consumeX402(from, amount, paymentId, validAfter, validBefore, nonce, signature, false);
        _transferX402(from, amount, validAfter, validBefore, nonce, signature);
        _settle(from, amount, paymentId, agent, listingId, true);
    }

    function _transferX402(address from, uint256 amount, uint256 validAfter, uint256 validBefore,
        bytes32 nonce, bytes calldata signature) private {
        (uint8 v, bytes32 r, bytes32 s) = _splitSignature(signature);
        uint256 beforeBalance = usdc.balanceOf(address(this));
        usdc.transferWithAuthorization(from, address(this), amount, validAfter, validBefore, nonce, v, r, s);
        require(usdc.balanceOf(address(this)) - beforeBalance == amount, "received");
    }

    /// @notice Trusted owner recovery ONLY after separately verifying a canonical token Transfer + AuthorizationUsed proof.
    /// A token's authorizationState also covers cancellation: it is not itself evidence of a received deposit.
    function settlePrepaidTransfer(address from, uint256 amount, bytes32 paymentId, uint256 listingId, bytes32 agent,
        uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes calldata signature,
        FundingBlock calldata funding) external nonReentrant {
        require(msg.sender == owner, "owner");
        require(funding.hash != bytes32(0) && funding.number < block.number && block.number - funding.number <= 256
            && blockhash(funding.number) == funding.hash, "funding block");
        _consumeX402(from, amount, paymentId, validAfter, validBefore, nonce, signature, true);
        require(usdc.authorizationState(from, nonce), "authorization unused");
        require(usdc.balanceOf(address(this)) >= amount, "prepaid balance");
        _settle(from, amount, paymentId, agent, listingId, true);
    }

    function _consumeX402(address from, uint256 amount, bytes32 paymentId, uint256 validAfter, uint256 validBefore,
        bytes32 nonce, bytes calldata signature, bool prepaid) private {
        require(paymentId != bytes32(0) && !settled[paymentId], "payment");
        bytes32 key = keccak256(abi.encode(from, nonce));
        require(x402AuthorizationPayments[key] == bytes32(0), "authorization replay");
        (uint8 v, bytes32 r, bytes32 s) = _splitSignature(signature);
        require(v == 27 || v == 28, "v");
        require(uint256(s) <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0, "s");
        require(from != address(0) && ecrecover(_x402Digest(from, amount, validAfter, validBefore, nonce), v, r, s) == from, "signature");
        x402AuthorizationPayments[key] = paymentId;
        emit X402AuthorizationConsumed(from, nonce, paymentId, prepaid);
    }

    function _x402Digest(address from, uint256 amount, uint256 validAfter, uint256 validBefore, bytes32 nonce) private view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), keccak256(abi.encode(
            TRANSFER_TYPEHASH, from, address(this), amount, validAfter, validBefore, nonce
        ))));
    }

    function _splitSignature(bytes calldata signature) private pure returns (uint8 v, bytes32 r, bytes32 s) {
        require(signature.length == 65, "signature");
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
    }

    function _settle(address payer, uint256 amount, bytes32 receiptHash, bytes32 agent, uint256 listingId, bool funded) internal {
        // Token approval alone is not authorization for a third party to charge it.
        require(funded || msg.sender == payer, "payer");
        require(receiptHash != bytes32(0), "receipt");
        require(!settled[receiptHash], "replay");
        require(amount > 0, "amount");
        settled[receiptHash] = true;
        spent[payer] += amount;
        if (agent != bytes32(0)) {
            require(address(mandate) != address(0), "no mandate");
            mandate.spendFor(agent, payer, amount, receiptHash);
            emit AgentSettled(agent, receiptHash, payer, amount);
        }
        uint256 providerFee;
        if (listingId != 0) {
            require(address(modelRegistry) != address(0), "no registry");
            (address provider, uint16 bps) = modelRegistry.paymentTerms(listingId);
            providerFee = (amount / 10_000) * bps + ((amount % 10_000) * bps) / 10_000;
            listingVolume[listingId] += amount;
            providerEarned[listingId] += providerFee;
            if (providerFee > 0) _pay(payer, provider, providerFee, funded);
            emit ProviderFeePaid(listingId, provider, receiptHash, providerFee);
        }
        if (amount > providerFee) _pay(payer, feeVault, amount - providerFee, funded);
        emit Settled(payer, amount, receiptHash, false);
    }

    function _pay(address payer, address recipient, uint256 amount, bool funded) internal {
        require(funded ? usdc.transfer(recipient, amount) : usdc.transferFrom(payer, recipient, amount), "usdc");
    }

    function settleConfidential(address payer, bytes calldata shieldedAmount, bytes32 receiptHash) external nonReentrant {
        // This hook has no verified Arc ABI or debit proof. Never mark an external-chain payment settled through it.
        require(block.chainid == 31337 || block.chainid == 1337, "local only");
        require(msg.sender == payer, "payer");
        require(receiptHash != bytes32(0), "receipt");
        require(shieldedAmount.length > 0, "amount");
        require(!settled[receiptHash], "replay");
        require(address(confidential) != address(0), "no confidential");
        settled[receiptHash] = true;
        require(confidential.confidentialTransfer(feeVault, shieldedAmount), "shielded");
        emit Settled(payer, 0, receiptHash, true);
    }
}
