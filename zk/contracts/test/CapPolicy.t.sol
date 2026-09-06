// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {MockUSDCV2_2} from "erc-8366/MockUSDCV2_2.sol";
import {ZKSpendingPolicyAccount} from "erc-8366/ZKSpendingPolicyAccount.sol";
import {Groth16Verifier} from "../src/CapPolicyVerifier.sol";

/// @notice pi-crypto-gate's cap policy on the ERC-8366 reference account.
///         Loads test/fixtures/cap-fixture.json, one real Groth16 proof from
///         zk/circuits/cap_policy.circom, and settles it as a plain EIP-3009
///         USDC transfer. The proof is bound to the fixture's account address
///         and chain id, so the account is deployed at exactly that address
///         with deployCodeTo and the chain id is pinned.
contract CapPolicyTest is Test {
    using stdJson for string;

    string constant FIXTURE = "test/fixtures/cap-fixture.json";
    address constant OWNER = 0x4444444444444444444444444444444444444444;
    address constant FACILITATOR = 0x5555555555555555555555555555555555555555;
    address constant OTHER_ACCOUNT = address(uint160(0xACC2));
    uint256 constant VALID_BEFORE = type(uint256).max;

    MockUSDCV2_2 usdc;
    Groth16Verifier verifier;
    ZKSpendingPolicyAccount acct;

    uint256[2] a;
    uint256[2][2] b;
    uint256[2] c;
    bytes32 paramsCommit;
    address account;
    address to;
    uint256 value;
    uint256 cap;
    uint256 chainId;
    bytes32 nonce;

    function setUp() public {
        require(vm.exists(FIXTURE), "missing fixture: run npm run zk:ceremony");
        string memory json = vm.readFile(FIXTURE);
        uint256[] memory a_ = json.readUintArray(".a");
        uint256[] memory b0 = json.readUintArray(".b[0]");
        uint256[] memory b1 = json.readUintArray(".b[1]");
        uint256[] memory c_ = json.readUintArray(".c");
        a = [a_[0], a_[1]];
        b = [[b0[0], b0[1]], [b1[0], b1[1]]];
        c = [c_[0], c_[1]];
        paramsCommit = bytes32(json.readUint(".paramsCommit"));
        account = json.readAddress(".account");
        to = json.readAddress(".to");
        value = json.readUint(".value");
        cap = json.readUint(".cap");
        chainId = json.readUint(".chainId");
        nonce = json.readBytes32(".nonce");

        vm.chainId(chainId);
        usdc = new MockUSDCV2_2();
        verifier = new Groth16Verifier();
        acct = _deployAccount(account);
    }

    function _deployAccount(address where) internal returns (ZKSpendingPolicyAccount a_) {
        deployCodeTo("ZKSpendingPolicyAccount.sol:ZKSpendingPolicyAccount", abi.encode(address(usdc), OWNER), where);
        a_ = ZKSpendingPolicyAccount(where);
        usdc.mint(where, 1_000_000_000); // 1,000 USDC of escrow
        vm.prank(OWNER);
        a_.allowPolicy(nonce, paramsCommit, address(verifier));
    }

    /// @dev The ERC-8366 envelope: abi.encode(proof, authorization).
    function _envelope(address to_, uint256 value_) internal view returns (bytes memory) {
        uint256[2] memory a_ = a;
        uint256[2][2] memory b_ = b;
        uint256[2] memory c_ = c;
        return abi.encode(abi.encode(a_, b_, c_), abi.encode(to_, value_, uint256(0), VALID_BEFORE, nonce));
    }

    function _pay(address from, address to_, uint256 value_) internal {
        vm.prank(FACILITATOR);
        usdc.transferWithAuthorization(from, to_, value_, 0, VALID_BEFORE, nonce, _envelope(to_, value_));
    }

    /// @dev The digest USDC computes, recomputed independently of the account.
    function _digest(address from, address to_, uint256 value_) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), from, to_, value_, uint256(0), VALID_BEFORE, nonce)
        );
        return keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
    }

    // --- the happy path -----------------------------------------------------

    function test_settles_a_payment_under_the_cap() public {
        _pay(account, to, value);
        assertEq(usdc.balanceOf(to), value);
        assertEq(usdc.balanceOf(account), 1_000_000_000 - value);
        assertTrue(usdc.authorizationState(account, nonce));
    }

    function test_isValidSignature_returns_the_magic_value() public view {
        assertEq(acct.isValidSignature(_digest(account, to, value), _envelope(to, value)), bytes4(0x1626ba7e));
    }

    function test_verifyPolicy_accepts_the_proven_payment() public view {
        uint256[2] memory a_ = a;
        uint256[2][2] memory b_ = b;
        uint256[2] memory c_ = c;
        assertTrue(acct.verifyPolicy(abi.encode(to, value, uint256(0), VALID_BEFORE, nonce), abi.encode(a_, b_, c_)));
    }

    function test_the_chain_holds_only_the_commitment() public view {
        (bytes32 registered, address v) = acct.allowedPolicy(nonce);
        assertEq(registered, paramsCommit);
        assertEq(v, address(verifier));
        // The cap itself never appears on chain: 250 USDC is a small number, the commitment is not it.
        assertTrue(registered != bytes32(cap));
        assertTrue(value <= cap);
    }

    // --- what the proof refuses ---------------------------------------------

    function test_a_higher_value_with_the_same_proof_is_refused() public {
        vm.prank(FACILITATOR);
        vm.expectRevert(bytes("USDC: EIP-1271 invalid signature"));
        usdc.transferWithAuthorization(account, to, value + 1, 0, VALID_BEFORE, nonce, _envelope(to, value + 1));
    }

    function test_a_different_recipient_with_the_same_proof_is_refused() public {
        address elsewhere = 0x6666666666666666666666666666666666666666;
        vm.prank(FACILITATOR);
        vm.expectRevert(bytes("USDC: EIP-1271 invalid signature"));
        usdc.transferWithAuthorization(account, elsewhere, value, 0, VALID_BEFORE, nonce, _envelope(elsewhere, value));
    }

    function test_nonce_replay_is_refused() public {
        _pay(account, to, value);
        vm.prank(FACILITATOR);
        vm.expectRevert(bytes("USDC: authorization used"));
        usdc.transferWithAuthorization(account, to, value, 0, VALID_BEFORE, nonce, _envelope(to, value));
    }

    function test_the_proof_is_bound_to_the_account() public {
        ZKSpendingPolicyAccount other = _deployAccount(OTHER_ACCOUNT);
        assertEq(address(other), OTHER_ACCOUNT);
        vm.prank(FACILITATOR);
        vm.expectRevert(bytes("USDC: EIP-1271 invalid signature"));
        usdc.transferWithAuthorization(OTHER_ACCOUNT, to, value, 0, VALID_BEFORE, nonce, _envelope(to, value));
    }

    function test_the_proof_is_bound_to_the_chain() public {
        vm.chainId(chainId + 1);
        vm.prank(FACILITATOR);
        vm.expectRevert(bytes("USDC: EIP-1271 invalid signature"));
        usdc.transferWithAuthorization(account, to, value, 0, VALID_BEFORE, nonce, _envelope(to, value));
    }

    function test_a_revoked_policy_is_refused() public {
        vm.prank(OWNER);
        acct.revokePolicy(nonce);
        vm.prank(FACILITATOR);
        vm.expectRevert(bytes("USDC: EIP-1271 invalid signature"));
        usdc.transferWithAuthorization(account, to, value, 0, VALID_BEFORE, nonce, _envelope(to, value));
    }
}
