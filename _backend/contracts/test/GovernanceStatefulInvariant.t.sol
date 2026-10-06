pragma solidity ^0.8.28;

import {Test, Vm} from "./TestBase.sol";
import {RegistryCallbackToken} from "./RegistryReentrancy.t.sol";
import {ModelRegistry} from "../src/ModelRegistry.sol";
import {AttestationVerifier} from "../src/AttestationVerifier.sol";

/// @dev Test-only keys and actors. No RPC, production wallet or token is used.
contract GovernanceStatefulHandler is Test {
    uint256 private constant SUBJECTS = 9;
    uint256 private constant MUTABLE_SUBJECTS = 8;
    uint256 private constant STAKE = 1 ether;
    uint256 private constant INITIAL_BALANCE = 100 ether;
    uint256 private constant INITIAL_ALLOWANCE = 1000 ether;
    uint256 private constant CALLBACK_BALANCE = 20 ether;
    bytes32 private constant DOMAIN_TYPE = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant RECEIPT_TYPE = keccak256("InferenceReceipt(bytes32 modelHash,bytes32 codeHash,bytes32 inHash,bytes32 outHash,bytes32 attRef,bytes32 nonce,uint64 ts)");
    bytes32 private constant LEGACY_TYPE = keccak256("InferenceReceipt(bytes32 modelHash,bytes32 codeHash,bytes32 inHash,bytes32 outHash,bytes32 attRef,uint64 ts)");

    struct Subject {
        uint256 id;
        address provider;
        uint64 listedAt;
        uint16 bps;
        bytes32 policy;
        uint64 version;
        bool approved;
        bool revoked;
    }

    struct CachedReceipt {
        AttestationVerifier.Receipt receipt;
        bytes currentSignature;
        bytes legacySignature;
        uint256 chainId;
        uint256 signerIndex;
    }

    RegistryCallbackToken public immutable token;
    ModelRegistry public immutable registry;
    AttestationVerifier public immutable verifier;
    AttestationVerifier public immutable otherVerifier;
    Subject[9] private subjects;
    CachedReceipt[] private cached;
    uint256 private ghostListingCount;
    uint256 private signerIndex;
    uint256 private expectedChain = 5042;
    uint256 private expectedTime = 100;
    uint256 private receiptSequence;
    bool private violated;

    uint256 public actions;
    uint256 public listingsAccepted;
    uint256 public listingsRejected;
    uint256 public callbackOutersAccepted;
    uint256 public rejectedStakeTransfers;
    uint256 public approvalsAccepted;
    uint256 public approvalsRejected;
    uint256 public revocations;
    uint256 public repeatedRevocations;
    uint256 public deniedGovernance;
    uint256 public deniedBootstrap;
    uint256 public signerRotations;
    uint256 public deniedZeroSigner;
    uint256 public receiptsAccepted;
    uint256 public receiptsRejected;
    uint256 public cachedReceiptsChecked;
    uint256 public forks;

    // Forge dispatches invariant actions in separate call environments. Keep the selected
    // logical chain and clock in storage and reapply them per transaction/check; otherwise
    // a previous chainId/warp cheatcode can be reset while the ghost state remains changed.
    modifier scenarioEnvironment() {
        vm.chainId(expectedChain);
        vm.warp(expectedTime);
        _;
    }

    constructor() {
        vm.chainId(expectedChain);
        vm.warp(100);
        token = new RegistryCallbackToken();
        registry = new ModelRegistry(address(token), STAKE);
        verifier = new AttestationVerifier(address(registry), vm.addr(key(0)));
        otherVerifier = new AttestationVerifier(address(registry), vm.addr(key(0)));
        for (uint256 i; i < 3; ++i) {
            address actor = provider(i);
            token.mint(actor, INITIAL_BALANCE);
            vm.prank(actor);
            token.approve(address(registry), INITIAL_ALLOWANCE);
        }
        token.mint(address(token), CALLBACK_BALANCE);
        // Some active subjects and cached proofs exist before random scheduling.
        // Others remain unlisted so the campaign can exercise fresh callbacks and rollback.
        for (uint256 i; i < 4; ++i) attemptListing(i, i % 3, i % 2 != 0, false, false, 200);
        // An approved control subject remains available after all governed subjects are revoked.
        // This keeps signer/domain acceptance exercised late in long histories.
        attemptListing(MUTABLE_SUBJECTS, 0, true, false, false, 200);
        advanceTime(3600);
        approveSubject(0);
        approveSubject(1);
        registry.approve(subjects[MUTABLE_SUBJECTS].id);
        subjects[MUTABLE_SUBJECTS].approved = true;
        approvalsAccepted++;
        cacheReceipt(0);
        cacheReceipt(1);
    }

    function provider(uint256 i) private pure returns (address) { return address(uint160(0x1000 + i % 3)); }
    function key(uint256 i) private pure returns (uint256) { return 0xa11ce + i; }
    function model(uint256 i) private pure returns (bytes32) { return keccak256(abi.encode("stateful-model", i)); }
    function code(uint256 i) private pure returns (bytes32) { return keccak256(abi.encode("stateful-code", i)); }
    function policy(uint256 i) private pure returns (bytes32) { return keccak256(abi.encode("stateful-policy", i)); }

    function listSubject(uint256 seed) external scenarioEnvironment {
        actions++;
        attemptListing(seed % MUTABLE_SUBJECTS, (seed >> 8) % 3, (seed >> 16) % 2 != 0, false, false, uint16(seed % 10_001));
    }

    function listWithCallback(uint256 seed) external scenarioEnvironment {
        actions++;
        attemptListing(seed % MUTABLE_SUBJECTS, (seed >> 8) % 3, (seed >> 16) % 2 != 0, true, false, uint16(seed % 10_001));
    }

    function rejectStakeTransfer(uint256 seed) external scenarioEnvironment {
        actions++;
        attemptListing(seed % MUTABLE_SUBJECTS, (seed >> 8) % 3, true, true, true, uint16(seed % 10_001));
    }

    function attemptListing(uint256 slot, uint256 actor, bool withPolicy, bool callback, bool rejectTransfer, uint16 bps) private {
        uint256 beforeCallbacks = token.callbackAttempts();
        if (callback) {
            // Half of fresh listings attempt nested policy replacement; the others plain duplication.
            bytes memory nested = withPolicy
                ? abi.encodeCall(ModelRegistry.list, (model(slot), code(slot), uint16(700)))
                : abi.encodeCall(ModelRegistry.listWithPolicy, (model(slot), code(slot), uint16(700), keccak256("callback-policy"), uint64(999)));
            token.configureCallback(address(registry), nested);
        } else token.configureCallback(address(registry), "");
        token.setAcceptTransfers(!rejectTransfer);
        Subject storage expected = subjects[slot];
        bool shouldAccept = expected.id == 0 && !rejectTransfer;
        bytes memory data = withPolicy
            ? abi.encodeCall(ModelRegistry.listWithPolicy, (model(slot), code(slot), bps, policy(slot), uint64(slot + 1)))
            : abi.encodeCall(ModelRegistry.list, (model(slot), code(slot), bps));
        vm.prank(provider(actor));
        (bool accepted, bytes memory result) = address(registry).call(data);
        if (accepted != shouldAccept) violated = true;
        if (accepted && shouldAccept) {
            ++ghostListingCount;
            if (abi.decode(result, (uint256)) != ghostListingCount) violated = true;
            expected.id = ghostListingCount;
            expected.provider = provider(actor);
            expected.listedAt = uint64(block.timestamp);
            expected.bps = bps;
            if (withPolicy) { expected.policy = policy(slot); expected.version = uint64(slot + 1); }
            listingsAccepted++;
            if (callback) {
                callbackOutersAccepted++;
                if (token.callbackAttempts() != beforeCallbacks + 1 || token.callbackSucceeded()
                    || keccak256(token.callbackResult()) != keccak256(abi.encodeWithSignature("Error(string)", "reentrant"))) violated = true;
            }
        } else {
            listingsRejected++;
            if (rejectTransfer && expected.id == 0) rejectedStakeTransfers++;
            // Failed token calls and nested effects must roll back together with the outer listing.
            if (token.callbackAttempts() != beforeCallbacks) violated = true;
        }
        token.setAcceptTransfers(true);
        token.configureCallback(address(registry), "");
    }

    function advanceTime(uint256 seed) public scenarioEnvironment {
        actions++;
        expectedTime += seed % 7201;
        vm.warp(expectedTime);
    }

    function approveSubject(uint256 seed) public scenarioEnvironment {
        actions++;
        Subject storage expected = subjects[seed % MUTABLE_SUBJECTS];
        bool shouldAccept = expected.id != 0 && !expected.revoked && block.timestamp >= expected.listedAt + 1 hours;
        (bool accepted,) = address(registry).call(abi.encodeCall(ModelRegistry.approve, (expected.id == 0 ? 999 : expected.id)));
        if (accepted != shouldAccept) violated = true;
        if (accepted && shouldAccept) { expected.approved = true; approvalsAccepted++; }
        else approvalsRejected++;
    }

    function revokeSubject(uint256 seed) external scenarioEnvironment {
        actions++;
        Subject storage expected = subjects[seed % MUTABLE_SUBJECTS];
        bool shouldAccept = expected.id != 0;
        (bool accepted,) = address(registry).call(abi.encodeCall(ModelRegistry.revoke, (expected.id == 0 ? 999 : expected.id)));
        if (accepted != shouldAccept) violated = true;
        if (accepted && shouldAccept) {
            if (expected.revoked) repeatedRevocations++;
            expected.approved = false;
            expected.revoked = true;
            revocations++;
        }
    }

    function unauthorizedGovernance(uint256 seed) external scenarioEnvironment {
        actions++;
        uint256 id = subjects[seed % MUTABLE_SUBJECTS].id;
        bytes memory data;
        address target = address(registry);
        uint256 mode = (seed >> 8) % 5;
        if (mode == 0) data = abi.encodeCall(ModelRegistry.approve, (id));
        else if (mode == 1) data = abi.encodeCall(ModelRegistry.revoke, (id));
        else if (mode == 2) data = abi.encodeCall(ModelRegistry.bootstrapRestore, (id));
        else if (mode == 3) data = abi.encodeCall(ModelRegistry.bootstrapApprove, (id));
        else { target = address(verifier); data = abi.encodeCall(AttestationVerifier.setEnclaveSigner, (provider(seed))); }
        // Exercise both direct outsiders and the same call during a token callback.
        vm.prank(provider(seed));
        (bool accepted,) = target.call(data);
        if (accepted) violated = true;
        deniedGovernance++;
        token.configureCallback(target, data);
        uint256 freeSlot = SUBJECTS;
        for (uint256 i; i < MUTABLE_SUBJECTS; ++i) if (subjects[i].id == 0) { freeSlot = i; break; }
        if (freeSlot != SUBJECTS) {
            // A separate outer listing may succeed, but the token cannot acquire an owner role.
            vm.prank(provider(seed));
            (bool listed, bytes memory result) = address(registry).call(abi.encodeCall(ModelRegistry.list, (model(freeSlot), code(freeSlot), uint16(100))));
            if (!listed) violated = true;
            else {
                ghostListingCount++;
                if (abi.decode(result, (uint256)) != ghostListingCount || token.callbackSucceeded()) violated = true;
                subjects[freeSlot] = Subject(ghostListingCount, provider(seed), uint64(block.timestamp), 100, bytes32(0), 0, false, false);
                listingsAccepted++;
            }
        }
        token.configureCallback(address(registry), "");
    }

    function bootstrapAttempt(uint256 seed) external scenarioEnvironment {
        actions++;
        uint256 id = subjects[seed % MUTABLE_SUBJECTS].id;
        bytes memory data = (seed >> 8) % 2 == 0
            ? abi.encodeCall(ModelRegistry.bootstrapApprove, (id)) : abi.encodeCall(ModelRegistry.bootstrapRestore, (id));
        (bool accepted,) = address(registry).call(data);
        if (accepted) violated = true;
        deniedBootstrap++;
    }

    function rotateSigner(uint256 seed) external scenarioEnvironment {
        actions++;
        uint256 next = seed % 4;
        address nextAddress = next == 3 ? address(0) : vm.addr(key(next));
        (bool accepted,) = address(verifier).call(abi.encodeCall(AttestationVerifier.setEnclaveSigner, (nextAddress)));
        if (accepted != (next != 3)) violated = true;
        if (accepted && next != 3) { signerIndex = next; signerRotations++; }
        else deniedZeroSigner++;
    }

    function forkDomain(uint256 seed) external scenarioEnvironment {
        actions++;
        // Never enter the local bootstrap chain. Returning to an earlier domain is intentional.
        expectedChain = 5042 + (seed % 3) * 1001;
        vm.chainId(expectedChain);
        forks++;
    }

    function domain(address target, bool legacy, uint256 chain) private pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPE, keccak256("ENCLAVE"), keccak256(legacy ? bytes("1") : bytes("2")), chain, target));
    }

    function expectedDigest(AttestationVerifier.Receipt memory r, bool legacy, uint256 chain) private view returns (bytes32) {
        bytes32 structHash = legacy
            ? keccak256(abi.encode(LEGACY_TYPE, r.modelHash, r.codeHash, r.inHash, r.outHash, r.attRef, r.ts))
            : keccak256(abi.encode(RECEIPT_TYPE, r.modelHash, r.codeHash, r.inHash, r.outHash, r.attRef, r.nonce, r.ts));
        return keccak256(abi.encodePacked("\x19\x01", domain(address(verifier), legacy, chain), structHash));
    }

    function signReceipt(AttestationVerifier.Receipt memory r, bool legacy, uint256 chain, uint256 signingIndex) private returns (bytes memory) {
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(key(signingIndex), expectedDigest(r, legacy, chain));
        return abi.encodePacked(rr, s, v);
    }

    function makeReceipt(uint256 slot, uint256 seed) private returns (AttestationVerifier.Receipt memory) {
        receiptSequence++;
        return AttestationVerifier.Receipt(model(slot), code(slot), keccak256(abi.encode("input", seed)),
            keccak256(abi.encode("output", seed)), keccak256(abi.encode("attestation", seed)),
            keccak256(abi.encode("nonce", receiptSequence)), uint64(block.timestamp));
    }

    function cacheReceipt(uint256 seed) public scenarioEnvironment {
        actions++;
        AttestationVerifier.Receipt memory r = makeReceipt(seed % SUBJECTS, seed);
        CachedReceipt memory entry = CachedReceipt(r, signReceipt(r, false, expectedChain, signerIndex),
            signReceipt(r, true, expectedChain, signerIndex), expectedChain, signerIndex);
        if (cached.length < 16) cached.push(entry);
        else cached[seed % 16] = entry;
    }

    function verifyCached(uint256 seed) external scenarioEnvironment {
        actions++;
        CachedReceipt storage entry = cached[seed % cached.length];
        bool legacy = (seed >> 8) % 2 != 0;
        bool tamper = (seed >> 16) % 2 != 0;
        bool other = (seed >> 24) % 2 != 0;
        AttestationVerifier.Receipt memory r = entry.receipt;
        if (tamper) r.outHash = keccak256(abi.encode("changed", r.outHash));
        uint256 slot = 0;
        while (slot < SUBJECTS && model(slot) != r.modelHash) slot++;
        bool shouldAccept = subjects[slot].approved && !subjects[slot].revoked
            && entry.signerIndex == signerIndex && entry.chainId == expectedChain && !tamper && !other;
        checkReceipt(r, legacy ? entry.legacySignature : entry.currentSignature, legacy, other, shouldAccept);
        cachedReceiptsChecked++;
    }

    function verifyFresh(uint256 seed) external scenarioEnvironment {
        actions++;
        uint256 slot = (seed & 0xff) % SUBJECTS;
        bool legacy = (seed >> 8) % 2 != 0;
        uint256 signingIndex = (seed >> 16) % 4;
        uint256 mutation = (seed >> 24) % 4;
        AttestationVerifier.Receipt memory r = makeReceipt(slot, seed);
        bytes memory signature = signReceipt(r, legacy, expectedChain, signingIndex);
        if (mutation == 1) r.attRef = keccak256(abi.encode("changed", r.attRef));
        else if (mutation == 2) r.ts++;
        // The explicit v1/v2 paths are not interchangeable, even with the current signer.
        bool callLegacy = mutation == 3 ? !legacy : legacy;
        bool shouldAccept = subjects[slot].approved && !subjects[slot].revoked && signingIndex == signerIndex && mutation == 0;
        checkReceipt(r, signature, callLegacy, false, shouldAccept);
    }

    function checkReceipt(AttestationVerifier.Receipt memory r, bytes memory signature, bool legacy, bool other, bool shouldAccept) private {
        AttestationVerifier target = other ? otherVerifier : verifier;
        bytes memory data;
        if (legacy) {
            AttestationVerifier.LegacyReceipt memory old = AttestationVerifier.LegacyReceipt(r.modelHash, r.codeHash, r.inHash, r.outHash, r.attRef, r.ts);
            data = abi.encodeCall(AttestationVerifier.verifyLegacyReceipt, (old, signature));
        } else data = abi.encodeCall(AttestationVerifier.verifyReceipt, (r, signature));
        vm.recordLogs();
        (bool accepted, bytes memory result) = address(target).call(data);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        if (accepted != shouldAccept) violated = true;
        if (accepted && shouldAccept) {
            receiptsAccepted++;
            bytes32 hash = expectedDigest(r, legacy, expectedChain);
            if (abi.decode(result, (bytes32)) != hash || logs.length != 1) violated = true;
            else if (logs[0].emitter != address(verifier) || logs[0].topics.length != 2
                || logs[0].topics[0] != keccak256("Verified(bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,address)")
                || logs[0].topics[1] != hash
                || keccak256(logs[0].data) != keccak256(abi.encode(r.modelHash, r.codeHash, r.inHash, r.outHash, r.attRef, vm.addr(key(signerIndex))))) violated = true;
        } else {
            receiptsRejected++;
            if (logs.length != 0) violated = true;
        }
        // Verification is stateless. Repeated verification is allowed; payment replay prevention
        // belongs to UsageMeter and is deliberately not asserted as a verifier property.
    }

    function assertRegistryState() external view {
        require(!violated, "unexpected governance or admission outcome");
        assertEq(registry.owner(), address(this));
        assertEq(address(registry.encl()), address(token));
        assertEq(registry.listingCount(), ghostListingCount);
        for (uint256 i; i < SUBJECTS; ++i) assertSubjectState(i);
        assertStakeState();
    }

    function assertSubjectState(uint256 i) private view {
        Subject storage expected = subjects[i];
        assertEq(registry.idByHashes(model(i), code(i)), expected.id);
        if (expected.id == 0) { assertFalse(registry.isApproved(model(i), code(i))); return; }
        assertListingData(i);
        assertSubjectPolicy(i);
    }

    function assertListingData(uint256 i) private view {
        Subject storage expected = subjects[i];
        (bytes32 m, bytes32 c, address actor, uint64 listedAt, uint16 bps, uint256 stake, bool approved, bool revoked) = registry.listings(expected.id);
        assertEq(m, model(i)); assertEq(c, code(i)); assertEq(actor, expected.provider);
        assertEq(listedAt, expected.listedAt); assertEq(bps, expected.bps);
        assertTrue(approved == expected.approved && revoked == expected.revoked);
        assertEq(stake, expected.revoked ? 0 : STAKE);
        assertTrue(registry.isApproved(model(i), code(i)) == (expected.approved && !expected.revoked));
    }

    function assertSubjectPolicy(uint256 i) private view {
        Subject storage expected = subjects[i];
        (bytes32 binding, uint64 version) = registry.listingPolicy(expected.id);
        assertEq(binding, expected.policy); assertEq(version, expected.version);
        assertTrue(registry.isApprovedWithPolicy(model(i), code(i), expected.policy, expected.version)
            == (expected.approved && !expected.revoked && expected.policy != bytes32(0) && expected.version != 0));
        assertFalse(registry.isApprovedWithPolicy(model(i), code(i), keccak256("wrong-policy"), expected.version));
    }

    function assertStakeState() private view {
        uint256 locked;
        uint256[3] memory consumedAllowances;
        uint256[3] memory providerLocked;
        for (uint256 i; i < SUBJECTS; ++i) {
            Subject storage expected = subjects[i];
            if (expected.id == 0) continue;
            for (uint256 j; j < 3; ++j) if (expected.provider == provider(j)) {
                consumedAllowances[j] += STAKE;
                if (!expected.revoked) { providerLocked[j] += STAKE; locked += STAKE; }
            }
        }
        assertEq(token.balanceOf(address(registry)), locked);
        assertEq(token.balanceOf(address(token)), CALLBACK_BALANCE);
        for (uint256 j; j < 3; ++j) {
            assertEq(token.balanceOf(provider(j)), INITIAL_BALANCE - providerLocked[j]);
            assertEq(token.allowance(provider(j), address(registry)), INITIAL_ALLOWANCE - consumedAllowances[j]);
        }
    }

    function assertSignerState() external scenarioEnvironment {
        require(!violated, "unexpected governance or admission outcome");
        assertEq(block.chainid, expectedChain);
        assertEq(block.timestamp, expectedTime);
        assertEq(verifier.owner(), address(this));
        assertEq(verifier.enclaveSigner(), vm.addr(key(signerIndex)));
        assertEq(verifier.domainSeparator(), domain(address(verifier), false, expectedChain));
        assertEq(verifier.legacyDomainSeparator(), domain(address(verifier), true, expectedChain));
        assertEq(block.chainid, expectedChain);
    }
}

contract GovernanceStatefulInvariantTest is Test {
    struct FuzzSelector { address addr; bytes4[] selectors; }
    GovernanceStatefulHandler private handler;

    function setUp() public { handler = new GovernanceStatefulHandler(); }

    function targetContracts() external view returns (address[] memory targets) {
        targets = new address[](1); targets[0] = address(handler);
    }

    function targetSelectors() external view returns (FuzzSelector[] memory targets) {
        bytes4[] memory selectors = new bytes4[](13);
        selectors[0] = handler.listSubject.selector;
        selectors[1] = handler.listWithCallback.selector;
        selectors[2] = handler.rejectStakeTransfer.selector;
        selectors[3] = handler.advanceTime.selector;
        selectors[4] = handler.approveSubject.selector;
        selectors[5] = handler.revokeSubject.selector;
        selectors[6] = handler.unauthorizedGovernance.selector;
        selectors[7] = handler.bootstrapAttempt.selector;
        selectors[8] = handler.rotateSigner.selector;
        selectors[9] = handler.forkDomain.selector;
        selectors[10] = handler.cacheReceipt.selector;
        selectors[11] = handler.verifyCached.selector;
        selectors[12] = handler.verifyFresh.selector;
        targets = new FuzzSelector[](1); targets[0] = FuzzSelector(address(handler), selectors);
    }

    function invariant_RegistryStakePolicyAndPermanentRevocation() public view { handler.assertRegistryState(); }
    function invariant_SignerGovernanceAndReceiptAdmission() public { handler.assertSignerState(); }

    function test_SeededMixedLifecycleHasPositiveAndNegativeCoverage() public {
        // A deterministic harness check establishes reachable positive/negative branches without
        // flaky per-random-sequence coverage minima. Forge reports random selector call counts.
        handler.listWithCallback(4);
        handler.approveSubject(4); // Too early: approval must fail without releasing stake.
        handler.rejectStakeTransfer(5);
        handler.listSubject(5);
        handler.unauthorizedGovernance(0);
        handler.unauthorizedGovernance(4 << 8);
        handler.bootstrapAttempt(4);
        handler.advanceTime(3600);
        handler.approveSubject(4);
        handler.cacheReceipt(4);
        handler.verifyFresh(4);
        handler.verifyFresh(4 | (1 << 24));
        handler.verifyFresh(4 | (1 << 8));
        handler.verifyFresh(4 | (3 << 24));
        handler.verifyCached(0);
        handler.rotateSigner(1);
        handler.verifyCached(0);
        handler.rotateSigner(3);
        handler.forkDomain(1);
        handler.verifyCached(0);
        handler.forkDomain(0);
        handler.rotateSigner(0);
        handler.verifyCached(0);
        handler.revokeSubject(0);
        handler.verifyCached(0);
        handler.revokeSubject(0);
        handler.approveSubject(0);
        handler.bootstrapAttempt(0);
        handler.listSubject(0);
        handler.assertRegistryState(); handler.assertSignerState();
        assertTrue(handler.actions() >= 20);
        assertTrue(handler.listingsAccepted() > 0 && handler.listingsRejected() > 0);
        assertTrue(handler.callbackOutersAccepted() > 0 && handler.rejectedStakeTransfers() > 0);
        assertTrue(handler.approvalsAccepted() > 0 && handler.approvalsRejected() > 0);
        assertTrue(handler.revocations() > 0 && handler.repeatedRevocations() > 0);
        assertTrue(handler.deniedGovernance() > 0 && handler.deniedBootstrap() > 0);
        assertTrue(handler.signerRotations() > 0 && handler.deniedZeroSigner() > 0);
        assertTrue(handler.receiptsAccepted() > 0 && handler.receiptsRejected() > 0 && handler.cachedReceiptsChecked() > 0);
        assertTrue(handler.forks() > 0);
    }
}
