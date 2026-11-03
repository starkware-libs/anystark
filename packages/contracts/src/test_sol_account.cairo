use garaga::signatures::eddsa_25519::{EdDSASignatureWithHint, is_valid_eddsa_signature};
use openzeppelin_interfaces::accounts::ISRC6_ID;
use openzeppelin_interfaces::introspection::{ISRC5Dispatcher, ISRC5DispatcherTrait, ISRC5_ID};
use openzeppelin_interfaces::src9::{
    ISRC9_V2Dispatcher, ISRC9_V2DispatcherTrait, ISRC9_V2_ID, OutsideExecution,
};
use snforge_std::{
    CheatSpan, ContractClassTrait, DeclareResultTrait, Event, EventSpyAssertionsTrait,
    cheat_block_timestamp, cheat_caller_address, declare, spy_events, start_cheat_caller_address,
    start_cheat_signature, start_cheat_transaction_hash, stop_cheat_caller_address,
};
use starknet::account::Call;
use starknet::{ContractAddress, SyscallResultTrait};
use crate::test_mocks::{
    ICompliantV2Dispatcher, ICompliantV2DispatcherTrait, IExternalMigrationHookDispatcher,
    IExternalMigrationHookDispatcherTrait,
};
use crate::{
    ISolAccountDispatcher, ISolAccountDispatcherTrait, IUpgradeableDispatcher,
    IUpgradeableDispatcherTrait, IUpgradeableSafeDispatcher, IUpgradeableSafeDispatcherTrait,
    IVersionedUpgradeDispatcher, IVersionedUpgradeDispatcherTrait,
};

// sig1*() / sig2(): real Ed25519 signatures by PK1 / PK2 respectively.
// sig1() signs the NO-LABEL base64 message (the 44-char base64 of HASH's 32 big-endian
// bytes) and drives the happy-path message binding; sig1_labeled() signs a readable
// label + "\n" + base64(HASH) (2 SHA-512 blocks); sig1_maxlabel() signs a 258-char label
// (msg_len 303, the 3-block MAX_MSG_LEN ceiling). All three are regenerated in lockstep
// with packages/core (garaga.test.ts EXPECTED_FELTS / test_vectors.ts) via
// gen_contract_vectors.mjs over the SAME seed-0..31 key, so they lock the
// off-chain->on-chain encoding both ways. sig2 is a real PK2 signature over base64(HASH):
// it binds to HASH, so an account holding PK1 rejects it at the Ed25519 verification
// (garaga checks against the STORED key passed as Py_twisted), surfacing 'INVALID_SIG'.
// MAX_PK maxes out both limbs: proves getters/events read back the whole u256,
// not just the low felt or a single fixed vector.
const HASH: felt252 = 0x1a2b3c4d5e6f70819293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8;
const MAX_PK: u256 = u256 {
    low: 0x99c04be718dd701dbe10cef3bf07a103, high: 0xb83155126486dc1d5f0da59b30d6e467,
};
// The repo's locked Ed25519 test key (seed bytes 0..31) as the little-endian u256
// SolAccount stores. Shared with test_outside_execution.cairo, which signs the
// SNIP-9 locked vector with this same key — kept single-source to match how the
// generator refuses to re-declare LOCKED_PUBKEY.
pub(crate) const PK1: u256 = u256 { low: 0x99c04be718dd701dbe10cef3bf07a103, high: 0xb83155126486dc1d5f0da59b30d6e467 };
const PK2: u256 = u256 { low: 0xa78ba9e812b17840f954e68f2e56b579, high: 0x649604ad0b91e3e0d7be95e63a851f90 };
fn sig1() -> Array<felt252> { array![0x89e728eb2b0b1b9bacf641b1a583ef52, 0x8dc3707c1b1beed1ce9233112d2edb3d, 0xe335bd8fd781a83e86dd138b84a8a435, 0x2b44e0dc38fa4ce0a833f01d1c9e7cb, 0x2c, 0x41, 0x42, 0x6f, 0x72, 0x50, 0x45, 0x31, 0x65, 0x62, 0x33, 0x43, 0x42, 0x6b, 0x70, 0x4f, 0x6b, 0x74, 0x63, 0x62, 0x58, 0x36, 0x50, 0x6b, 0x4b, 0x47, 0x79, 0x77, 0x39, 0x54, 0x6c, 0x39, 0x67, 0x63, 0x59, 0x4b, 0x54, 0x70, 0x4c, 0x58, 0x47, 0x31, 0x2b, 0x67, 0x3d, 0x14, 0xbb47013d92a599345834a422, 0x19a7288136520d2e679eb7be, 0x2ef3f19d1d01bc5, 0x0, 0x9c676d3acc465b792a29b91b, 0x9f42c18ab28d1c0a9412ece4, 0x5409a8346f542f3a, 0x0, 0x25b7d652fba2869d4ca134d92f217285, 0x119d8f39d4187e900681bbe109d458760, 0xe885ebe4dc616353180683eb, 0x12aa23dc48341c10084caa4, 0x2ff50558bfc791cb, 0x0, 0xb593a2a998bcd541a44cf8f8, 0xdb0edfccf2f56c00b2490856, 0x7c7e22b5c2ac250d, 0x0, 0x1555a4839dacbe6aaddff9f6afc6e578, 0x1141a76675877aa44c826f3da912e8105, 0xa0dbae440d3b2a7f56b0e39cfd041659, 0xf62118d9e870bef3decd656a6a857d7, 0xc95fb5a1cbb999c4629a4836155d1d73, 0x22f0627bcb72c7ea8aa709cdce7618d3] }
// Labeled happy-path vector: LOCKED_LABEL ("anystark: transfer 25 USDC to alice.strk") + "\n"
// + base64(HASH); msg_len 0x55 (85), 2 SHA-512 blocks. Byte-identical to
// EXPECTED_FELTS_LABELED in packages/core/src/garaga.test.ts.
fn sig1_labeled() -> Array<felt252> { array![0x32776b3325c9957d3d886b74a796ccd3, 0xcf49b2ad6cc03e22d5caa3a8b52673c0, 0xf4434f1831d31ad37a8d8e79f4769fa7, 0x892ea9656175c9327b958b0cbac88ed, 0x55, 0x61, 0x6e, 0x79, 0x73, 0x74, 0x61, 0x72, 0x6b, 0x3a, 0x20, 0x74, 0x72, 0x61, 0x6e, 0x73, 0x66, 0x65, 0x72, 0x20, 0x32, 0x35, 0x20, 0x55, 0x53, 0x44, 0x43, 0x20, 0x74, 0x6f, 0x20, 0x61, 0x6c, 0x69, 0x63, 0x65, 0x2e, 0x73, 0x74, 0x72, 0x6b, 0xa, 0x41, 0x42, 0x6f, 0x72, 0x50, 0x45, 0x31, 0x65, 0x62, 0x33, 0x43, 0x42, 0x6b, 0x70, 0x4f, 0x6b, 0x74, 0x63, 0x62, 0x58, 0x36, 0x50, 0x6b, 0x4b, 0x47, 0x79, 0x77, 0x39, 0x54, 0x6c, 0x39, 0x67, 0x63, 0x59, 0x4b, 0x54, 0x70, 0x4c, 0x58, 0x47, 0x31, 0x2b, 0x67, 0x3d, 0x14, 0xbe412d284dcd7607ad10ce5b, 0x6d8dfd2ad770f34819f4ab70, 0x6c3e3315d5cfb359, 0x0, 0x1e6282a239361c4b3cf77b6c, 0x3e1b42c5fe22c9616a13a51c, 0x5ef8d6570eaacf82, 0x0, 0x2237f9d0d4a229c90c34ce992912f02, 0x295ca53eb5aefc81ebeffde47a923555, 0xd004d199c20bd032a2e596d4, 0x41ce28b3c218d28982dbd73e, 0x2abde6772cad5537, 0x0, 0x9cfe19c0a8ee3136009ed4f5, 0xcbb8d0e0e2467e378ed2be35, 0x1953290e1d52f537, 0x0, 0x31a23b5bad2fbac930b7d6362e5379f9, 0x11c630377c23f58740c21cb7555ba640b, 0x2c83f053624fd1488cad48eec01f8f7, 0x25f0ac23e7080d87dc4a422476c6cbd2, 0xc95fb5a1cbb999c4629a4836155d1d73, 0x22f0627bcb72c7ea8aa709cdce7618d3] }
// Max-label vector: a 258-byte label ('x' * 258) + "\n" + base64(HASH); msg_len 0x12f
// (303) = MAX_MSG_LEN, the 3-SHA-512-block ceiling. Proves the largest accepted message
// validates on-chain end to end.
fn sig1_maxlabel() -> Array<felt252> { array![0xfa05b94ff4b28796861f3e9d710a5e5f, 0xf54d370ebb6da668b46c4a0aa582b276, 0xb96f03905d06d69addec794e757a18af, 0xf2d665d1fcad4a752061a0a797b5abc, 0x12f, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0xa, 0x41, 0x42, 0x6f, 0x72, 0x50, 0x45, 0x31, 0x65, 0x62, 0x33, 0x43, 0x42, 0x6b, 0x70, 0x4f, 0x6b, 0x74, 0x63, 0x62, 0x58, 0x36, 0x50, 0x6b, 0x4b, 0x47, 0x79, 0x77, 0x39, 0x54, 0x6c, 0x39, 0x67, 0x63, 0x59, 0x4b, 0x54, 0x70, 0x4c, 0x58, 0x47, 0x31, 0x2b, 0x67, 0x3d, 0x14, 0x3cf83e8695a8475ca0d42c7a, 0x4a1ec16a1a9220436307361b, 0x3e38bb91e9a03cbb, 0x0, 0x4dffd9be21ea5d9ed5919763, 0xfd5bcecbcf2ff63b915ff981, 0x798d860c73b4346c, 0x0, 0x107f4d21495f4c83bcbd92f778a5e8c1, 0x117d3f8b2495e075e78a9a6b1b4b7a824, 0x1f25145a559da0be908431ff, 0x59512925a55c0a4010fd8f4a, 0x79373d8aed55b190, 0x0, 0x645f1c0ce8314afe5f17eaf7, 0x281a7a2d1e954413f1e781c7, 0x1d727f33ad3e2358, 0x0, 0xdc86009f990ac62c276f88d8e889fd7, 0x245a58dd8076166d0e708a2a338260c1, 0x1ce777bf3fcac9cb9713151f9e553ca1, 0x28e8ccbf041fb8726428c54fffdf7838, 0xc95fb5a1cbb999c4629a4836155d1d73, 0x22f0627bcb72c7ea8aa709cdce7618d3] }
// A real PK1 signature over a decoy-label message: "decoy:\n" + <44-char base64 of a
// DIFFERENT hash> + "\n" + base64(HASH); msg_len 0x60 (96). The embedded '\n'+decoy pair
// tempts a delimiter-search parser onto the wrong hash; the contract's fixed trailing
// window ignores it and binds to HASH. Same locked key/encoder as sig1*, generated at the
// raw-message level (the SDK forbids '\n' in labels), so it exercises the contract parse.
fn decoy_label_signature() -> Array<felt252> { array![0x9d3369ad64906ca52dac60c27dd72ce5, 0x48c31eb0144f5d1298261705d26086c0, 0x69fa3f9eee7851af40d8a6fde8886b36, 0x8a6f52a07d8b92609828a13118a9857, 0x60, 0x64, 0x65, 0x63, 0x6f, 0x79, 0x3a, 0xa, 0x41, 0x4e, 0x36, 0x74, 0x76, 0x75, 0x2f, 0x4b, 0x2f, 0x76, 0x41, 0x4e, 0x45, 0x53, 0x49, 0x7a, 0x52, 0x46, 0x56, 0x6d, 0x64, 0x34, 0x69, 0x5a, 0x41, 0x42, 0x45, 0x69, 0x4d, 0x30, 0x52, 0x56, 0x5a, 0x6e, 0x65, 0x49, 0x6d, 0x51, 0x43, 0x71, 0x75, 0x38, 0x77, 0x3d, 0xa, 0x41, 0x42, 0x6f, 0x72, 0x50, 0x45, 0x31, 0x65, 0x62, 0x33, 0x43, 0x42, 0x6b, 0x70, 0x4f, 0x6b, 0x74, 0x63, 0x62, 0x58, 0x36, 0x50, 0x6b, 0x4b, 0x47, 0x79, 0x77, 0x39, 0x54, 0x6c, 0x39, 0x67, 0x63, 0x59, 0x4b, 0x54, 0x70, 0x4c, 0x58, 0x47, 0x31, 0x2b, 0x67, 0x3d, 0x14, 0x6ccad03d2c4d9d9e8592f8ec, 0xc64f1afa51a91dc564f4d594, 0x69259dd3e5370f63, 0x0, 0xb6bfcfb62121aea2d9880e70, 0x883339808b27001d4e51cd87, 0x3005884efb0ac34, 0x0, 0x389ec6ba96cf2657683a7dd6b745293f, 0x536fc09865473da380cc0e39610c455, 0x7050700a84e650e13ec2e4d1, 0xd03dd0affa27ccd56e5681f4, 0x58a20cd4a331a74d, 0x0, 0x56967263d8e6c147e08f8386, 0x7860583eb1c61790727c4ded, 0x33b1bae106f105a0, 0x0, 0x1410f7e71bd5dee72ec3d545df5a12eb, 0x627e6d8f52ffb142061ab213777d9b9, 0x13bd64826564c2fb2f24c63660b54aba, 0x5860bf5cba1992c36397ea3f05cfc641, 0xc95fb5a1cbb999c4629a4836155d1d73, 0x22f0627bcb72c7ea8aa709cdce7618d3] }
// A real PK2 signature over base64(HASH) (no label, msg_len 44). It binds to HASH, so an
// account holding PK1 passes message binding and then FAILS the Ed25519 verification
// ('INVALID_SIG'): garaga verifies against the stored key (PK1) passed as Py_twisted, not
// against the key that produced the signature.
fn sig2() -> Array<felt252> { array![0x276541b452b30c1cf57d67d5f50f555b, 0xdd42bed40290d535f931147051c6b3e2, 0x91d9d9b6eca731aae090f526ff16a737, 0xd311c45c9034b108ee3147fe303f1ce, 0x2c, 0x41, 0x42, 0x6f, 0x72, 0x50, 0x45, 0x31, 0x65, 0x62, 0x33, 0x43, 0x42, 0x6b, 0x70, 0x4f, 0x6b, 0x74, 0x63, 0x62, 0x58, 0x36, 0x50, 0x6b, 0x4b, 0x47, 0x79, 0x77, 0x39, 0x54, 0x6c, 0x39, 0x67, 0x63, 0x59, 0x4b, 0x54, 0x70, 0x4c, 0x58, 0x47, 0x31, 0x2b, 0x67, 0x3d, 0x14, 0x35c71191e6089d738dfe10f, 0x5416ac3af387ea1c18d854bf, 0x3ed2d34b29ab8e3, 0x0, 0x1ba45de4b1a658577b3d3b44, 0x504a0c694a056dce660770ae, 0x76d27d9ad4385300, 0x0, 0x29b4d229ac85fba8a5677a5a016ce8b6, 0x1145e247bbc69db12976a09ab053d1ecf, 0x940dfe5297222adf5af4874c, 0x5d56e0f91c4aa32b312c1ae, 0x149c504f32064816, 0x0, 0x3467df2a98a8b7582748c758, 0xf98afc5a764309f4a9850ccc, 0x68f3e5069781fa1b, 0x0, 0xb45be690ce360c74b3c93384ff48b9f, 0x15305f128c225a8c2b33f2b26b7fe454, 0x5006dfea8336c387ede5205c7cad1157, 0xc3b67383f3ac7c133a0777a4a1c2bbc, 0x9c373c4abcace38f85fced2c2d13685e, 0x504112c6a157d86dcf9420df7ced6441] }
// A real PK1 signature over a 43-byte message (one byte under B64_HASH_LEN): rejected
// 'MSG_TOO_SHORT' after the bundle deserializes, before any base64 decode.
fn msg_too_short_signature() -> Array<felt252> { array![0xba1ea0ecd96637c4b2a37816a5dcb02d, 0x346e47a04b9766663749dd22cc6456e3, 0xb78ad52fc3d98bc06293d80b347d0b73, 0x4a63a66bf73424e34bb0b6fef3ad0ec, 0x2b, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x14, 0x83a51974e5f39a61d17ea05, 0xf42a93d46f199caa108b452a, 0x2ccc6f8ac26de19d, 0x0, 0x7fa74dfbffd7c2112df0e7a4, 0x3da66df9683a1fa760805ae6, 0x10085565c30c904c, 0x0, 0x3951e3a2d08d7c2243705f86a4280947, 0x12a77229c853edaa7d16fdd1cf262e053, 0x59b2578d63a5a011878d4327, 0xb5f07d5c9651d9f6908935ef, 0x38c0e82a5dce2fed, 0x0, 0x618104d8d5f9328e50441566, 0x8233eed6da04db31f7426e6f, 0x9ef1a11304e1eba, 0x0, 0x2d144d0a461d902ab78c5c1270f4c54d, 0x1080e05024f1099ddeed439c78e13f41b, 0x55816adfb1802bf15cc5937775d6c046, 0x79a473f2d949285616da0f92a24d2ede, 0xc95fb5a1cbb999c4629a4836155d1d73, 0x22f0627bcb72c7ea8aa709cdce7618d3] }
// A real PK1 signature over a 304-byte message (259-byte label + '\n' + 44-byte base64,
// one over MAX_MSG_LEN): rejected 'MSG_TOO_LONG' after deserialize, before any decode or
// garaga work, so the DoS bound is genuinely exercised.
fn msg_too_long_signature() -> Array<felt252> { array![0x6a4e36abd7afd2f7d83c2bf0961bf72c, 0xe584aad25cf67eb9dd1cafe9819f47a1, 0x378232d4507e24db324883a2dec84314, 0x1bb3fa40cf1bf3a93ff8e70f868d6a6, 0x130, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0x78, 0xa, 0x41, 0x42, 0x6f, 0x72, 0x50, 0x45, 0x31, 0x65, 0x62, 0x33, 0x43, 0x42, 0x6b, 0x70, 0x4f, 0x6b, 0x74, 0x63, 0x62, 0x58, 0x36, 0x50, 0x6b, 0x4b, 0x47, 0x79, 0x77, 0x39, 0x54, 0x6c, 0x39, 0x67, 0x63, 0x59, 0x4b, 0x54, 0x70, 0x4c, 0x58, 0x47, 0x31, 0x2b, 0x67, 0x3d, 0x14, 0xcf02d3338f2cd8d08d6f4f44, 0x5005129f1878c51185fa527b, 0x75137bb0f7ffaa0e, 0x0, 0xf718e756fd05751dc08912c2, 0xa0cf5024b94b76776c82edcb, 0x7c8ccd2f9a12af7, 0x0, 0x3b6866b20877ce3ee1e03a762661700a, 0x1036a8cbb53fb6e5b58bbd2146c77adc5, 0xa03b7b785b5aec0b910e354a, 0xadcdae9b00bb4d556ad808f7, 0x3b2b1d12f4cd8cd3, 0x0, 0x41fbbb9ac1a412fdf4fe9c4e, 0xbeddbab0f4ca68e95e81e8c6, 0x307acc0ca2560120, 0x0, 0x5558cacc63625d8d4b11ae93e5302fc, 0x33bdb04c1a5e7ea0425a5e56c9ede929, 0x1680be687da7a3a78d4585e03e7132f3, 0x453d45d1bf443d6208161c370f5e0cbc, 0xc95fb5a1cbb999c4629a4836155d1d73, 0x22f0627bcb72c7ea8aa709cdce7618d3] }
// A real PK1 signature over a hex-encoded ("0x"+64 hex chars, 66 bytes) hash message: it
// survives the length range, but msg_len > 44 forces the separator check, and the byte
// before the trailing 44-byte window is a hex char, not '\n' -> 'BAD_MSG_SEPARATOR'.
fn hex_message_signature() -> Array<felt252> { array![0x165337d4f98d972c78298d5a93115fcb, 0x9e540e6a10d80c9f61b05ed4b3f032d7, 0x6cd4166d060f8e8518d4ad17e3655ffd, 0x601c39c4236c5a79074faa38fd90e9, 0x42, 0x30, 0x78, 0x30, 0x30, 0x31, 0x61, 0x32, 0x62, 0x33, 0x63, 0x34, 0x64, 0x35, 0x65, 0x36, 0x66, 0x37, 0x30, 0x38, 0x31, 0x39, 0x32, 0x39, 0x33, 0x61, 0x34, 0x62, 0x35, 0x63, 0x36, 0x64, 0x37, 0x65, 0x38, 0x66, 0x39, 0x30, 0x61, 0x31, 0x62, 0x32, 0x63, 0x33, 0x64, 0x34, 0x65, 0x35, 0x66, 0x36, 0x30, 0x37, 0x31, 0x38, 0x32, 0x39, 0x33, 0x61, 0x34, 0x62, 0x35, 0x63, 0x36, 0x64, 0x37, 0x65, 0x38, 0x14, 0xc64e57dd9b1adaca9f0bcad5, 0xbf49a9c22969e868ba5fbbc, 0x7ffc434dc47a992b, 0x0, 0xf6e89ff6f81310dc73142e, 0xabcfee8e014f437b5885287e, 0x354439a00d5cd79c, 0x0, 0x24dd8a6d9979f6e2f8d254b4728703db, 0x1681278cedc425c16b0d3d91ab7fe708, 0x36e892fd6617c6c4077d074b, 0x1f40389b7b1ebb970f5cf08c, 0x7075d4e3417e48e9, 0x0, 0x780276de2a3df82ae013191e, 0x9064a60a931e653b8ee94de4, 0x701b41a42fc0a6aa, 0x0, 0x34428773b82a779470502f407f4aff5c, 0x1a1e7e7df9c77edaf948fccb47046577, 0x98076d75959d8a36c0038870680c9157, 0x551da51306d20c15fe1c0e6deccba432, 0xc95fb5a1cbb999c4629a4836155d1d73, 0x22f0627bcb72c7ea8aa709cdce7618d3] }

// ─── constructor Ed25519 key vetting ───
// Vectors generated offline with @noble/curves. The constructor rejects the encodings
// garaga can never verify against: the zero key, a non-canonical encoding (y >= p), and
// any small-order (torsion) point. It does NOT check on-curve membership, so an off-curve
// key deploys (garaga rejects it at verify time and the SDK applies the same non-zero and
// canonical checks before address derivation). A false REJECT of a valid key would make a
// legitimately derived address undeployable, so valid_keys_deploy is the fund-critical
// no-false-negative check; the rejection tests pin the fail-fast reverts.

// Real Phantom-style keys: @noble/curves getPublicKey of random scalars. V0..V6 carry the
// x-sign bit (bit 255) set, V7 clears it, so both encodings are exercised. Each must deploy.
fn valid_keys() -> Array<u256> {
    array![
        u256 { low: 0x2db723f9e1aafe95c784c89943148b00, high: 0x99e9d1cbfda0c5cae6a4ffed0791bd35 },
        u256 { low: 0xa158d47dc8322e1f1efed439065304cb, high: 0xd281c338730e14ef6200d4bdf9321c04 },
        u256 { low: 0xc1602af43d257434184dbeaaacc7ebc0, high: 0xcbbf73bbe5f0ce81cdab465784affabb },
        u256 { low: 0xf1668befb692ed3cdbea8f80e0a0be3f, high: 0xab6bd047b5791ec102474828f806b107 },
        u256 { low: 0xccf5340d0832d39fa3b7f85e14b4ef57, high: 0xb8c4159dadc4ab41481c4e47405cd8f9 },
        u256 { low: 0x463377675d32b6d341d3271ea4a5fb27, high: 0x858c0d6d0992eaf697758d8d635914b5 },
        u256 { low: 0xc4d59008bb6e6135b073ce38e3dcf9d1, high: 0xafea5cc861f97edb5a1662d34832c8f6 },
        u256 { low: 0x15b5362aea4c7c4e24850a57ca93f7ea, high: 0x5a391e381b5684818bf155a78eb0e315 },
    ]
}

// The canonical y-coordinates (x-sign bit stripped) of the complete Ed25519 torsion
// subgroup: the eight small-order points collapse to these five distinct y values (see the
// SMALL_ORDER_Y_* constants in lib.cairo). y = 0 with x-sign 0 is the all-zero key.
fn small_order_ys() -> Array<u256> {
    array![
        0x0, // y = 0: the two order-4 points (x = +/- sqrt(-1))
        0x1, // y = 1: the identity (order 1)
        0x5fc536d880238b13933c6d305acdfd5f098eff289f4c345b027b2c28f95e826, // order 8
        0x7a03ac9277fdc74ec6cc392cfa53202a0f67100d760b3cba4fd84d3d706a17c7, // order 8
        0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffec, // y = p - 1 (order 2)
    ]
}

// bit 255: the x-sign bit. Setting it on a torsion y gives the point's other encoding.
const X_SIGN_BIT: u256 = 0x8000000000000000000000000000000000000000000000000000000000000000;

// True iff SolAccount deploys successfully with this signer (its constructor did not revert).
fn deploy_succeeds(pk: u256) -> bool {
    let c = declare("SolAccount").unwrap().contract_class();
    c.deploy(@array![pk.low.into(), pk.high.into()]).is_ok()
}

// Deploy SolAccount and re-panic with the constructor's revert reason if it reverts, so a
// should_panic test can pin the exact named error.
fn deploy_expect_panic(pk: u256) {
    let c = declare("SolAccount").unwrap().contract_class();
    c.deploy(@array![pk.low.into(), pk.high.into()]).unwrap_syscall();
}

#[test]
fn valid_keys_deploy() {
    // No-false-negative guarantee: every real Ed25519 key deploys and stores its signer,
    // including keys whose x-sign bit is set. A regression here would strand legitimately
    // derived (and possibly already funded) addresses, so this is the fund-critical case.
    for key in valid_keys() {
        let (dispatcher, _) = deploy_with_addr(key.low.into(), key.high.into());
        assert!(dispatcher.get_public_key() == key);
    }
}

#[test]
fn off_curve_key_deploys() {
    // Deliberate tradeoff: the constructor does NOT check on-curve membership (that cost
    // ~5.26M L2 gas per deploy), so an off-curve key deploys. This is a canonical y (y < p,
    // x-sign 0) with no valid x, generated offline with @noble/curves.
    // It is covered elsewhere: garaga rejects it at signature-verification time and the
    // client SDK applies the same non-zero and canonical checks before deriving an address,
    // so such a key can never drive the account even though it deploys.
    const OFF_CURVE_KEY: u256 =
        u256 { low: 0x2511ec52271724f1f06c99a584909dfa, high: 0x3afcc991949a62355b144f53caaf42cd };
    assert!(deploy_succeeds(OFF_CURVE_KEY) == true);
}

#[test]
fn small_order_keys_rejected() {
    // Every Ed25519 torsion point is small order; garaga rejects them, so the constructor
    // rejects both x-sign encodings of each. y = 0 with x-sign 0 is the all-zero key, caught
    // by the non-zero guard; every other combination is caught as a small-order point.
    for y in small_order_ys() {
        assert!(!deploy_succeeds(y));
        assert!(!deploy_succeeds(y | X_SIGN_BIT));
    }
}

#[test]
#[should_panic(expected: "public_key is a small-order point")]
fn small_order_key_reverts_with_named_error() {
    // An order-8 torsion point: non-zero, on the curve, and canonical, so it clears the
    // earlier guards and is rejected specifically as a small-order point.
    deploy_expect_panic(0x5fc536d880238b13933c6d305acdfd5f098eff289f4c345b027b2c28f95e826);
}

#[test]
#[should_panic(expected: "public_key must be non-zero")]
fn zero_key_reverts() {
    // The all-zero key (y = 0, x-sign 0) permanently bricks its derived address; the deploy
    // must fail fast. Previously untested at the deploy boundary.
    deploy_expect_panic(0);
}

#[test]
#[should_panic(expected: "public_key is not a canonical Ed25519 key")]
fn non_canonical_key_reverts() {
    // y == p is a non-canonical encoding (y is not a field element), rejected before any
    // curve math. Previously untested at the deploy boundary.
    deploy_expect_panic(0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed);
}

#[test]
fn stores_public_key() {
    let actual = deploy(MAX_PK.low.into(), MAX_PK.high.into());
    assert!(actual.get_public_key() == MAX_PK);
}

#[test]
fn emits_signer_initialized_on_deploy() {
    let pk_lo: felt252 = MAX_PK.low.into();
    let pk_hi: felt252 = MAX_PK.high.into();
    // Spy must be live before the constructor runs (i.e. before deploy).
    let mut spy = spy_events();
    let actual = deploy(pk_lo, pk_hi);
    // SignerInitialized has no #[key] fields, so keys = [event name], data = [pk.low, pk.high].
    spy
        .assert_emitted(
            @array![
                (
                    actual.contract_address,
                    Event {
                        keys: array![selector!("SignerInitialized")], data: array![pk_lo, pk_hi],
                    },
                ),
            ],
        );
}

#[test]
fn valid_signature_passes() {
    let acct = deploy(PK1.low.into(), PK1.high.into());
    assert!(acct.is_valid_signature(HASH, sig1()) == 'VALID');
}

#[test]
fn is_valid_signature_returns_zero_on_rejection() {
    // SNIP-6 conformance: for EVERY rejection the contract itself detects, is_valid_signature
    // returns 0 (never a revert), matching how OZ accounts answer. At least one assertion per
    // named reason (with sibling paths for BAD_SIG_ENCODING and BAD_B64_PAD), each the
    // non-reverting mirror of a panicking-path test below. The lone
    // exception (a hint-tampered bundle that reverts INSIDE garaga) is pinned separately by
    // tampered_label_rejected, since no on-chain code can catch that internal panic.
    let acct = deploy(PK1.low.into(), PK1.high.into());
    // BAD_SIG_ENCODING: msg_len felt does not fit u32.
    assert!(acct.is_valid_signature(HASH, with_felt_replaced(sig1(), 4, 0x100000000)) == 0);
    // BAD_SIG_ENCODING: a message content felt does not fit u8 (sibling of the msg_len path).
    assert!(acct.is_valid_signature(HASH, with_felt_replaced(sig1(), 5, 0x100)) == 0);
    // SIG_HAS_EXTRA_DATA: one junk felt past the bundle.
    let mut extra = sig1();
    extra.append(0xdead);
    assert!(acct.is_valid_signature(HASH, extra) == 0);
    // MSG_TOO_SHORT / MSG_TOO_LONG: length outside [44, 303].
    assert!(acct.is_valid_signature(HASH, msg_too_short_signature()) == 0);
    assert!(acct.is_valid_signature(HASH, msg_too_long_signature()) == 0);
    // BAD_MSG_SEPARATOR: labeled message without '\n' before the base64 tail.
    assert!(acct.is_valid_signature(HASH, with_felt_replaced(sig1_labeled(), 45, 0x58)) == 0);
    // BAD_B64_CHAR: a space in the base64 window.
    assert!(acct.is_valid_signature(HASH, with_felt_replaced(sig1(), 5, 0x20)) == 0);
    // BAD_B64_PAD: the final '=' pad overwritten with 'A'.
    assert!(acct.is_valid_signature(HASH, with_felt_replaced(sig1(), 48, 0x41)) == 0);
    // BAD_B64_PAD: non-zero pad bits in char 42 (sibling of the missing-pad-char path).
    assert!(acct.is_valid_signature(HASH, with_felt_replaced(sig1(), 47, 0x68)) == 0);
    // MSG_NOT_BOUND: correct signer, wrong hash.
    assert!(acct.is_valid_signature(HASH + 1, sig1()) == 0);
    // INVALID_SIG: a genuine PK2 signature rejected against the stored PK1.
    assert!(acct.is_valid_signature(HASH, sig2()) == 0);
}

#[test]
#[should_panic(expected: 'INVALID_SIG')]
fn wrong_signer_rejected() {
    // sig2 is a genuine PK2 signature over base64(HASH); the account holds PK1. Message
    // binding passes (it binds to HASH), then garaga verifies against the STORED key
    // (PK1) passed as Py_twisted and rejects the PK2 signature. On the tx-validation path
    // that structural rejection is the NAMED panic 'INVALID_SIG'.
    let (_, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    validate_tx_reverts(addr, HASH, sig2());
}

#[test]
#[should_panic(expected: 'MSG_NOT_BOUND')]
fn replayed_hash_rejected() {
    // Correct signer, but a different hash than the signed message encodes.
    let (_, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    validate_tx_reverts(addr, HASH + 1, sig1());
}

#[test]
#[should_panic(expected: 'INVALID_SIG')]
fn invalid_signature_rejected() {
    // A message that binds to HASH, but Ry's low limb (felt 0) has one byte flipped
    // (…52 -> …53). Message binding still passes, so this reaches the Ed25519
    // verification, where garaga (checking against the stored PK1) returns false and the
    // tx path panics 'INVALID_SIG'.
    let (_, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    let tampered = with_felt_replaced(sig1(), 0, 0x89e728eb2b0b1b9bacf641b1a583ef53);
    validate_tx_reverts(addr, HASH, tampered);
}

// ─── base64 message binding (Part A) ───

#[test]
fn labeled_signature_passes() {
    // Readable-label happy path: a real signature over LOCKED_LABEL + "\n" + base64(HASH)
    // (2 SHA-512 blocks) binds to HASH and validates. Proves the fixed-trailing-window
    // decode ignores the label and the separator assert accepts a genuine "\n".
    let acct = deploy(PK1.low.into(), PK1.high.into());
    assert!(acct.is_valid_signature(HASH, sig1_labeled()) == 'VALID');
}

#[test]
fn max_label_signature_passes() {
    // The 3-SHA-512-block ceiling: a 258-byte label pushes msg_len to exactly
    // MAX_MSG_LEN (303) and still validates - the largest accepted message.
    let acct = deploy(PK1.low.into(), PK1.high.into());
    assert!(acct.is_valid_signature(HASH, sig1_maxlabel()) == 'VALID');
}

#[test]
fn decoy_hash_in_label_binds_to_trailing_window() {
    // No second-hash smuggling / no delimiter search: the LABEL here contains a '\n'
    // FOLLOWED BY a full 44-char decoy base64 (of a DIFFERENT hash), and the real
    // base64(HASH) is the fixed trailing window ("decoy:\n" + decoyB64 + "\n" + base64(HASH),
    // msg_len 96). The contract decodes ONLY the last 44 bytes, so it binds to HASH and the
    // decoy is inert - validation returns 'VALID'. A naive "find a '\n', then decode the next
    // 44 chars" parse would instead lock onto the decoy and reject, so this pins that the
    // decode is trailing-window-only. Built as a raw signed message at the vector level
    // (the SDK's assembleSignedMessage forbids a '\n' in the label) to exercise the CONTRACT
    // parse directly. Regenerate with scripts alongside the other vectors.
    let acct = deploy(PK1.low.into(), PK1.high.into());
    assert!(acct.is_valid_signature(HASH, decoy_label_signature()) == 'VALID');
}

#[test]
#[should_panic]
fn tampered_label_rejected() {
    // HONEST LIMIT of the SNIP-6 non-reverting guarantee: tampering ONE label byte leaves
    // the base64 tail intact, so message binding to HASH still passes, but it changes
    // garaga's SHA-512 input while the msm/sqrt hints were computed for the untampered
    // message. garaga then panics INTERNALLY on that hint inconsistency, a panic no on-chain
    // code can catch, so is_valid_signature REVERTS here rather than returning 0. Every
    // rejection the contract itself detects returns 0 instead (see
    // is_valid_signature_returns_zero_on_rejection); only a hint-tampered bundle like this
    // still reverts inside garaga. Generic should_panic: the revert is garaga's internal
    // code, not one of our named reasons; either way the label is bound to the signature and
    // cannot be altered after signing.
    let acct = deploy(PK1.low.into(), PK1.high.into());
    // Flip the first label byte 'a' (0x61, felt index 5) to 'e' (0x65).
    let tampered = with_felt_replaced(sig1_labeled(), 5, 0x65);
    acct.is_valid_signature(HASH, tampered);
}

#[test]
#[should_panic(expected: 'MSG_TOO_SHORT')]
fn msg_len_below_44_rejected() {
    // A genuine bundle whose message is 43 bytes (one under B64_HASH_LEN). It
    // deserializes cleanly, so the msg_len >= 44 guard is the rejection - before the
    // trailing-window subtraction, so there is no underflow.
    let (_, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    validate_tx_reverts(addr, HASH, msg_too_short_signature());
}

#[test]
#[should_panic(expected: 'MSG_TOO_LONG')]
fn msg_len_above_303_rejected() {
    // A genuine bundle whose message is 304 bytes (259-byte label + '\n' + 44-byte
    // base64, one over MAX_MSG_LEN). It deserializes cleanly, so msg_len <= 303 is the
    // rejection, before any decode or garaga work - bounding the attacker-chosen length.
    let (_, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    validate_tx_reverts(addr, HASH, msg_too_long_signature());
}

#[test]
#[should_panic(expected: 'BAD_SIG_ENCODING')]
fn oversized_msg_len_felt_rejected() {
    // The bundle's msg_len is the Serde length of a Span<u8>. A hostile felt that does
    // not fit u32 (here 2^32) makes Serde's length narrowing fail, so deserialization
    // returns None and validate_tx reverts with the NAMED 'BAD_SIG_ENCODING' rather than
    // a raw panic. Replacing felt index 4 (msg_len in the v1 layout) triggers it.
    let (_, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    validate_tx_reverts(addr, HASH, with_felt_replaced(sig1(), 4, 0x100000000));
}

#[test]
#[should_panic(expected: 'BAD_SIG_ENCODING')]
fn non_byte_msg_content_felt_rejected() {
    // Each message felt is a Serde element of a Span<u8>. A content felt that does not fit
    // u8 (here 0x100) makes Serde's per-element u8 narrowing return None, so deserialization
    // fails and validate_tx reverts with the NAMED 'BAD_SIG_ENCODING' before any indexed
    // read. This exercises the u8-narrowing guarantee that the downstream message-byte reads
    // rely on. Felt index 5 is the first message-content byte in the v1 layout (the 'A' that
    // opens the base64 tail), distinct from index 4 (the msg_len u32 narrowing).
    let (_, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    validate_tx_reverts(addr, HASH, with_felt_replaced(sig1(), 5, 0x100));
}

#[test]
#[should_panic(expected: 'BAD_SIG_ENCODING')]
fn truncated_span_rejected() {
    // A hostile span that claims msg_len 44 but does not carry the 44 message bytes (nor
    // the hints) must hit a named error, not a raw out-of-bounds index panic. This span
    // is just [Ry, s, msg_len=44] (5 felts); Serde runs out of felts reading the message
    // and returns None -> 'BAD_SIG_ENCODING'.
    let (_, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    let truncated = array![*sig1().at(0), *sig1().at(1), *sig1().at(2), *sig1().at(3), 0x2c];
    validate_tx_reverts(addr, HASH, truncated);
}

#[test]
#[should_panic(expected: 'SIG_HAS_EXTRA_DATA')]
fn trailing_felt_rejected() {
    // sig1() is a valid PK1 bundle that deserializes and would otherwise validate.
    // Appending one junk felt past the bundle leaves the Serde span non-empty after
    // deserialize, so validate_tx rejects it 'SIG_HAS_EXTRA_DATA': each valid signature
    // has exactly one canonical encoding, with no malleable trailing padding.
    let (_, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    let mut tampered = sig1();
    tampered.append(0xdead);
    validate_tx_reverts(addr, HASH, tampered);
}

#[test]
#[should_panic(expected: 'BAD_B64_PAD')]
fn missing_pad_char_rejected() {
    // The last base64 char (felt index 48 for a no-label message) MUST be '='. Replacing
    // it with 'A' fails the canonical-pad check.
    let (_, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    validate_tx_reverts(addr, HASH, with_felt_replaced(sig1(), 48, 0x41)); // 'A'
}

#[test]
#[should_panic(expected: 'BAD_B64_PAD')]
fn nonzero_pad_bits_rejected() {
    // char 42 (felt index 47) carries only 4 significant bits; its low 2 bits must be
    // zero. sig1's char is 'g' (sextet 32, low bits 0); 'h' (sextet 33, low bit 1) makes
    // the encoding non-canonical -> BAD_B64_PAD.
    let (_, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    validate_tx_reverts(addr, HASH, with_felt_replaced(sig1(), 47, 0x68)); // 'h'
}

#[test]
#[should_panic(expected: 'BAD_B64_CHAR')]
fn non_alphabet_char_rejected() {
    // A space (0x20) is not in the standard base64 alphabet: the first message char
    // (felt index 5) fails classification.
    let (_, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    validate_tx_reverts(addr, HASH, with_felt_replaced(sig1(), 5, 0x20)); // ' '
}

#[test]
#[should_panic(expected: 'BAD_MSG_SEPARATOR')]
fn wrong_separator_byte_rejected() {
    // With a label present, the byte before the base64 tail MUST be '\n'. Take the
    // labeled vector and overwrite that separator (felt index 5 + 40 = 45) with 'X'.
    let (_, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    validate_tx_reverts(addr, HASH, with_felt_replaced(sig1_labeled(), 45, 0x58)); // 'X'
}

#[test]
#[should_panic(expected: 'BAD_MSG_SEPARATOR')]
fn old_hex_format_rejected() {
    // A real PK1 signature over a hex-encoded 66-byte "0x"+hex message survives the
    // 44..303 length range, but msg_len 66 > 44 triggers the separator assert, and the
    // byte before the (mis-aligned) trailing window is a hex char, not '\n'. So a
    // hex-encoded hash cannot bind; only base64 does.
    let (_, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    validate_tx_reverts(addr, HASH, hex_message_signature());
}

#[test]
fn garaga_pubkey_param_is_verified_key() {
    // Pins the garaga v1 API contract validate_signature relies on: is_valid_eddsa_signature
    // verifies the bundle against the Py_twisted PARAMETER (which the account fills from
    // its stored signer), not any key embedded in the bundle. sig1() (PK1's signature)
    // verifies against PK1 and is rejected against PK2, so passing the stored key is
    // exactly what binds the signer. If this breaks after a garaga bump, re-derive
    // validate_signature's verifier call.
    let mut bundle_span = sig1().span();
    let bundle = Serde::<EdDSASignatureWithHint>::deserialize(ref bundle_span).unwrap();
    assert!(is_valid_eddsa_signature(bundle, PK1));
    assert!(!is_valid_eddsa_signature(bundle, PK2));
}

// ─── upgrade (replace_class) ───

#[test]
fn upgrade_reachable_only_via_execute() {
    // END-TO-END proof of the PR's core security claim: upgrade() is self-gated, so
    // the ONLY legitimate route is the account's own __execute__ dispatching a Call
    // back into itself. Here we drive that real route instead of cheating the caller
    // straight to `upgrade`:
    //   1. cheat the caller to 0 (the protocol — the only caller __execute__ accepts),
    //   2. invoke __execute__ with a single Call{to: addr, selector: 'upgrade',
    //      calldata: [new_class]},
    //   3. __execute__'s call_contract_syscall re-enters the account, so inside
    //      upgrade() get_caller_address() == addr == get_contract_address() and the
    //      NOT_SELF guard passes — proving the route reaches upgrade() and swaps class.
    let (acct, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());

    // LOCAL NEGATIVE BASELINE (self-contained, no cross-test coupling): the
    // post-upgrade `== 'VALID'` below is only a genuine reroute proof if the V1
    // class would have REJECTED sig2(). sig2 is a PK2 signature over base64(HASH), so
    // the account (holding PK1) rejects it at garaga verification. Pin that directly:
    // V1's SNIP-6-conforming is_valid_signature returns 0 (not 'VALID') for sig2, plus
    // PK2 != PK1 and that the account holds PK1, so a future edit elsewhere can never
    // silently make this a tautology.
    assert!(PK2 != PK1);
    assert!(acct.get_public_key() == PK1);
    let v1_rejects_sig2 = acct.is_valid_signature(HASH, sig2());
    assert!(v1_rejects_sig2 == 0);

    // RELIED-UPON SNFORGE SEMANTIC (load-bearing for the reroute proof): upgrade()
    // runs replace_class_syscall INSIDE contract execution (not the replace_bytecode
    // cheatcode). snforge observes that in-contract swap, so subsequent dispatcher
    // calls to the SAME address reroute to the new class within this test. The
    // replacement class is declare()'d first because snforge requires the new class
    // to be declared for it to execute. Verified green on snforge 0.60.0.
    // CompliantV2Account is the guard-compliant target (identity()=='solana_account',
    // signer-slot faithful) and accepts every signature, so sig2() (rejected by V1's
    // 'INVALID_SIG') returning 'VALID' below still proves the class swap.
    let v2 = declare("CompliantV2Account").unwrap().contract_class();
    let v2_hash: felt252 = (*v2.class_hash).into();

    let mut spy = spy_events();
    // Caller 0 == the protocol: the only caller __execute__ accepts. CheatSpan::TargetCalls(1)
    // spoofs ONLY this first (outer) call to `addr`; __execute__'s nested re-entrant
    // call_contract_syscall back into `addr` is the second call, so it carries the
    // NATURAL caller (`addr` itself) — which is precisely what upgrade()'s self-check needs.
    cheat_caller_address(addr, 0.try_into().unwrap(), CheatSpan::TargetCalls(1));
    let call = Call {
        to: addr, selector: selector!("upgrade"), calldata: array![v2_hash].span(),
    };
    acct.__execute__(array![call]);

    // Reaching upgrade() through __execute__ emitted Upgraded and swapped the class.
    spy
        .assert_emitted(
            @array![
                (addr, Event { keys: array![selector!("Upgraded")], data: array![v2_hash] }),
            ],
        );
    assert!(acct.is_valid_signature(HASH, sig2()) == 'VALID');

    // The post-replace migration hook also ran: upgrade() self-called
    // execute_after_upgrade on the NEW class, which recorded the old VERSION (1).
    let v2_acct = ICompliantV2Dispatcher { contract_address: addr };
    assert!(v2_acct.migration_ran());
    assert!(v2_acct.migrated_from() == 1);
}

#[test]
fn upgrade_preserves_signer_slot() {
    // Fund-safety regression: replace_class preserves the storage tree, so a V2
    // that keeps `public_key: u256` at the same slot MUST read back the original
    // root signer (the key that derives the user's address).
    let (acct, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    assert!(acct.get_public_key() == PK1); // V1 holds PK1 (non-zero, so not a default-zero match)

    // CompliantV2Account keeps `public_key: u256` as its first storage field, so the
    // slot survives the swap, and it clears the identity upgrade guard.
    let v2 = declare("CompliantV2Account").unwrap().contract_class();
    start_cheat_caller_address(addr, addr);
    IUpgradeableDispatcher { contract_address: addr }.upgrade(*v2.class_hash);
    stop_cheat_caller_address(addr);

    // After replace_class the same address is now the V2 class, yet the signer
    // slot is intact: it still reads back PK1 byte-for-byte.
    let v2_acct = ICompliantV2Dispatcher { contract_address: addr };
    assert!(v2_acct.get_public_key() == PK1);
}

#[test]
#[should_panic(expected: 'NOT_SELF')]
fn upgrade_rejects_non_self() {
    let (_, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    // Pin EXACTLY which caller is rejected: cheat the caller to a concrete address
    // that is not the account itself, rather than relying on snforge's implicit
    // default caller happening to differ from `addr`.
    let other: ContractAddress = 0xbad_ca11e2.try_into().unwrap();
    assert!(other != addr);
    start_cheat_caller_address(addr, other);
    let bogus: starknet::ClassHash = 0x1234.try_into().unwrap();
    IUpgradeableDispatcher { contract_address: addr }.upgrade(bogus);
    stop_cheat_caller_address(addr);
}

#[test]
#[should_panic(expected: 'ZERO_CLASS')]
fn upgrade_rejects_zero_class() {
    let (_, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    start_cheat_caller_address(addr, addr);
    IUpgradeableDispatcher { contract_address: addr }.upgrade(0.try_into().unwrap());
    stop_cheat_caller_address(addr);
}

#[test]
fn version_is_one() {
    // v1 is the fresh class: version() is non-gating metadata (the upgrade guard no
    // longer reads it) exposed as a view and used as the migration hook's from_version.
    let (_, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    assert!(IVersionedUpgradeDispatcher { contract_address: addr }.version() == 1);
}

#[test]
fn upgrade_runs_migration_hook() {
    // Guard-compliant upgrade succeeds AND the post-replace migration hook runs: the
    // new class records that execute_after_upgrade fired with from_version == the old
    // VERSION (1), and the signer slot is preserved across the swap. This is the
    // concrete observable that closes the SRC5-discovery caveat for the guarded path.
    let (acct, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    assert!(acct.get_public_key() == PK1);

    let v2 = declare("CompliantV2Account").unwrap().contract_class();
    let mut spy = spy_events();
    start_cheat_caller_address(addr, addr);
    IUpgradeableDispatcher { contract_address: addr }.upgrade(*v2.class_hash);
    stop_cheat_caller_address(addr);

    let v2_hash: felt252 = (*v2.class_hash).into();
    spy
        .assert_emitted(
            @array![(addr, Event { keys: array![selector!("Upgraded")], data: array![v2_hash] })],
        );
    let v2_acct = ICompliantV2Dispatcher { contract_address: addr };
    assert!(v2_acct.get_public_key() == PK1); // storage preserved
    assert!(v2_acct.migration_ran()); // hook fired
    assert!(v2_acct.migrated_from() == 1); // with the old version
}

#[test]
#[should_panic(expected: 'NOT_SOL_ACCOUNT')]
fn upgrade_rejects_wrong_identity() {
    // Identity guard: a class that self-reports a DIFFERENT identity() is not a
    // sol_account and is rejected NOT_SOL_ACCOUNT - a foreign class cannot be installed
    // through upgrade().
    let (_, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    let wrong = declare("WrongIdentityAccount").unwrap().contract_class();
    start_cheat_caller_address(addr, addr);
    IUpgradeableDispatcher { contract_address: addr }.upgrade(*wrong.class_hash);
    stop_cheat_caller_address(addr);
}

#[test]
#[should_panic]
fn upgrade_rejects_absent_identity() {
    // The absent-identity variant: with NO identity() entrypoint the identity library
    // call fails (entrypoint not found), reverting the upgrade. This is also the
    // target-declared probe - an undeclared/entrypoint-less target cannot be installed.
    // Generic should_panic: the revert is a syscall failure, not one of our named assert
    // codes.
    let (_, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    let absent = declare("AbsentIdentityAccount").unwrap().contract_class();
    start_cheat_caller_address(addr, addr);
    IUpgradeableDispatcher { contract_address: addr }.upgrade(*absent.class_hash);
    stop_cheat_caller_address(addr);
}

#[test]
#[should_panic(expected: 'FORBIDDEN_CALL')]
fn execute_rejects_direct_migration_hook_call() {
    // FORBIDDEN-CALL guard: a user-signed multicall cannot invoke the migration hook.
    // __execute__ rejects any Call whose selector is execute_after_upgrade (Argent's
    // forbidden-call pattern), so it stays reachable ONLY via upgrade()'s internal
    // self-call - closing the replay vector for future non-idempotent hooks. Validation
    // has already passed by the time __execute__ runs, so we drive it as the protocol
    // (caller 0) with the forbidden Call.
    let (acct, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    cheat_caller_address(addr, 0.try_into().unwrap(), CheatSpan::TargetCalls(1));
    let call = Call {
        to: addr, selector: selector!("execute_after_upgrade"), calldata: array![0].span(),
    };
    acct.__execute__(array![call]);
}

#[test]
fn execute_allows_migration_hook_selector_on_external_target() {
    // The FORBIDDEN_CALL guard is scoped to self-calls (to == the account), so a normal
    // multicall can still invoke a function that merely shares the name
    // execute_after_upgrade on an UNRELATED external contract. The migration hook's real
    // protection is the callee's NOT_SELF + NOT_IN_MIGRATION asserts, not this entrypoint
    // guard, so scoping it leaves the account safe. Validation has already passed by the
    // time __execute__ runs, so we drive it as the protocol (caller 0) and confirm the
    // foreign target observed the call.
    let (acct, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    let target_cls = declare("ExternalMigrationHookMock").unwrap().contract_class();
    let (target, _) = target_cls.deploy(@array![]).unwrap();
    cheat_caller_address(addr, 0.try_into().unwrap(), CheatSpan::TargetCalls(1));
    let call = Call {
        to: target, selector: selector!("execute_after_upgrade"), calldata: array![7].span(),
    };
    acct.__execute__(array![call]);
    let recorded = IExternalMigrationHookDispatcher { contract_address: target }
        .last_from_version();
    assert(recorded == 7, 'external hook not called');
}

#[test]
#[should_panic(expected: 'FORBIDDEN_CALL')]
fn execute_rejects_self_migration_hook_in_mixed_multicall() {
    // The FORBIDDEN_CALL guard is evaluated per iteration, so it still catches a
    // self-targeted execute_after_upgrade call even when it is mixed into a multicall
    // alongside a permitted external-target call sharing the same selector. The external
    // call to the unrelated ExternalMigrationHookMock is allowed (to != the account),
    // but the self-targeted call (to == the account) trips the guard. Validation has
    // already passed by the time __execute__ runs, so we drive it as the protocol
    // (caller 0).
    let (acct, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    let target_cls = declare("ExternalMigrationHookMock").unwrap().contract_class();
    let (target, _) = target_cls.deploy(@array![]).unwrap();
    cheat_caller_address(addr, 0.try_into().unwrap(), CheatSpan::TargetCalls(1));
    let external_call = Call {
        to: target, selector: selector!("execute_after_upgrade"), calldata: array![7].span(),
    };
    let self_call = Call {
        to: addr, selector: selector!("execute_after_upgrade"), calldata: array![0].span(),
    };
    acct.__execute__(array![external_call, self_call]);
}

#[test]
fn upgrade_target_is_itself_upgradeable() {
    // RELEASE-TIME INVARIANT (fund-critical): every sol_account class MUST retain a
    // working upgrade() and self-report the sol_account identity, so the fleet can always
    // move forward. This is a BEHAVIORAL TEMPLATE, not an automatic guard on the real
    // future production class: it exercises the COMPLIANT MOCKS (CompliantV2Account /
    // CompliantV3Account) to prove the pattern - deploy v1, upgrade into the compliant next
    // version (V2), then drive V2's OWN retained upgrade() into a compliant V3, proving the
    // target is itself an upgradeable sol_account (identity guard + migration hook +
    // preserved signer slot), not a dead end. It does NOT test the actual next production
    // class unless that class is wired in here as the target at release. RELEASE-PROCESS
    // EXPECTATION: when a real v2 is cut, replace (or add) the target with the real class
    // and re-run this, so a class that breaks upgrade() fails loudly at release time
    // instead of stranding the fleet on-chain.
    let (_, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    let v2 = declare("CompliantV2Account").unwrap().contract_class();
    let v3 = declare("CompliantV3Account").unwrap().contract_class();

    // v1 -> V2 through SolAccount's guarded upgrade (identity guard + hook).
    start_cheat_caller_address(addr, addr);
    IUpgradeableDispatcher { contract_address: addr }.upgrade(*v2.class_hash);
    stop_cheat_caller_address(addr);
    let as_v2 = ICompliantV2Dispatcher { contract_address: addr };
    assert!(as_v2.version() == 2);
    assert!(as_v2.migration_ran() && as_v2.migrated_from() == 1);

    // V2 -> V3 through V2's OWN upgrade() (the invariant under test): the account now runs
    // V2 code, so this exercises the target class's retained, guarded upgrade path.
    start_cheat_caller_address(addr, addr);
    IUpgradeableDispatcher { contract_address: addr }.upgrade(*v3.class_hash);
    stop_cheat_caller_address(addr);
    let as_v3 = ICompliantV2Dispatcher { contract_address: addr };
    assert!(as_v3.version() == 3);
    assert!(as_v3.migration_ran() && as_v3.migrated_from() == 2); // V2 passed its own VERSION
    assert!(as_v3.get_public_key() == PK1); // signer slot preserved across BOTH swaps
}

#[test]
fn upgrade_reverts_atomically_when_migration_hook_panics() {
    // FUND-SAFETY ATOMICITY INVARIANT (the core half-upgrade promise): if the
    // post-replace_class migration hook panics, the WHOLE upgrade reverts - the
    // replace_class rolls back and the account stays on v1, never half-upgraded.
    // MigrationPanicAccount clears the identity guard but its
    // execute_after_upgrade always panics, so `upgrade`'s final self-call re-panics and
    // Starknet rolls the swap back atomically. We drive it through the SAFE dispatcher so
    // the panic surfaces as Err (letting us inspect post-revert state) instead of
    // aborting the test.
    let (acct, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    let boom = declare("MigrationPanicAccount").unwrap().contract_class();

    start_cheat_caller_address(addr, addr);
    let result = IUpgradeableSafeDispatcher { contract_address: addr }.upgrade(*boom.class_hash);
    stop_cheat_caller_address(addr);
    assert!(result.is_err()); // the hook panic propagated and reverted the upgrade

    // Post-revert the account is STILL v1 and fully functional: version() == 1, the
    // signer slot is intact, and signature validation still works.
    assert!(IVersionedUpgradeDispatcher { contract_address: addr }.version() == 1);
    assert!(acct.get_public_key() == PK1);
    assert!(acct.is_valid_signature(HASH, sig1()) == 'VALID');
}

#[test]
fn upgrade_reverts_atomically_when_migration_hook_absent() {
    // Same atomicity invariant via the ABSENT-hook path: NoMigrationHookAccount clears
    // the identity guard but has no execute_after_upgrade entrypoint, so
    // `upgrade`'s post-replace self-call fails (entrypoint not found) and reverts the
    // replace_class. The account stays on v1.
    let (acct, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    let no_hook = declare("NoMigrationHookAccount").unwrap().contract_class();

    start_cheat_caller_address(addr, addr);
    let result = IUpgradeableSafeDispatcher { contract_address: addr }
        .upgrade(*no_hook.class_hash);
    stop_cheat_caller_address(addr);
    assert!(result.is_err()); // the missing-hook self-call failed and reverted the upgrade

    assert!(IVersionedUpgradeDispatcher { contract_address: addr }.version() == 1);
    assert!(acct.get_public_key() == PK1);
    assert!(acct.is_valid_signature(HASH, sig1()) == 'VALID');
}

#[test]
#[should_panic(expected: 'NOT_SELF')]
fn execute_after_upgrade_rejects_non_self() {
    // The migration hook must not be an externally reachable migration trigger: a
    // non-self caller is rejected, so it can only run as upgrade()'s self-call.
    let (_, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    let other: ContractAddress = 0xbad_ca11e2.try_into().unwrap();
    assert!(other != addr);
    start_cheat_caller_address(addr, other);
    IVersionedUpgradeDispatcher { contract_address: addr }.execute_after_upgrade(0);
    stop_cheat_caller_address(addr);
}

#[test]
#[should_panic(expected: 'NOT_IN_MIGRATION')]
fn execute_after_upgrade_direct_self_call_rejected() {
    // execute_after_upgrade is a PUBLIC entrypoint the owner can self-call standalone,
    // and caller == self alone would let it through (the account calling itself). The
    // path-independent migration_in_progress flag closes that: outside `upgrade`'s
    // post-replace self-call the flag is false, so a standalone self-call - even one that
    // passes the NOT_SELF gate - reverts NOT_IN_MIGRATION. This is the multicall/direct
    // analog of outside_execution_rejects_direct_migration_hook_call (the SNIP-9 route);
    // together they prove the hook is unreachable standalone on EVERY route.
    let (_, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());

    // Owner-initiated self-call (caller == self) with an arbitrary from_version: NOT_SELF
    // passes, but the migration window is closed, so NOT_IN_MIGRATION fires.
    start_cheat_caller_address(addr, addr);
    IVersionedUpgradeDispatcher { contract_address: addr }.execute_after_upgrade(0xdeadbeef);
    stop_cheat_caller_address(addr);
}

// ─── SRC5 introspection ───

#[test]
fn supports_src5_interface() {
    // ISRC5_ID needs no registration: OZ's supports_interface answers it directly.
    let (_, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    assert!(ISRC5Dispatcher { contract_address: addr }.supports_interface(ISRC5_ID));
}

#[test]
fn supports_src6_interface() {
    // The constructor registers ISRC6_ID: the account's entrypoints match the
    // canonical SNIP-6 shape, so wallets / tooling may treat it as a SNIP-6 account.
    let (_, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    assert!(ISRC5Dispatcher { contract_address: addr }.supports_interface(ISRC6_ID));
}

#[test]
fn unregistered_interface_not_supported() {
    // Introspection must not blanket-answer true: an id nothing has registered answers false.
    let (_, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    assert!(!ISRC5Dispatcher { contract_address: addr }.supports_interface(0xdead));
}

// ─── SNIP-9 outside execution ───
// Guard tests only (caller / window / reaching validation), with no crypto fixture.
// The locked-vector happy path / replay / tamper / cross-account tests — plus the
// vector's provenance and the gen_snip9_vector.mjs generator — live in
// test_outside_execution.cairo.

#[test]
fn supports_src9_interface() {
    // Registered by the constructor's SRC9 initializer, so relayers can discover
    // that this account accepts execute_from_outside_v2.
    let (_, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    assert!(ISRC5Dispatcher { contract_address: addr }.supports_interface(ISRC9_V2_ID));
}

#[test]
fn fresh_nonce_reported_unused() {
    // SRC9 nonces are arbitrary user-chosen felts, not sequential; a relayer asks
    // this view before submitting.
    let (_, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    assert!(ISRC9_V2Dispatcher { contract_address: addr }.is_valid_outside_execution_nonce(42));
}

#[test]
fn upgrade_from_pre_snip9_leaves_src5_unregistered() {
    // Pins the RESIDUAL (legacy-only) discovery caveat. SolAccount now re-registers
    // the SRC5 ids via its execute_after_upgrade migration hook, but that hook only
    // runs through SolAccount's OWN guarded upgrade path. A pre-SNIP-9 class upgrades
    // with a BARE replace_class (no guards, no hook), so upgrading OldNoSrc5Account
    // into SolAccount still gets the SRC9 entrypoints (execute_from_outside_v2 / the
    // nonce view work) but NOT the SRC5 registration: the constructor does not re-run
    // and the old class never invokes the hook. A paymaster probing
    // supports_interface(ISRC9_V2_ID) still sees it as unsupported. The caveat is thus
    // CLOSED for accounts already on the v1 (hook-bearing) class upgrading forward, and
    // remains only for accounts stranded on a pre-hook class. If this ever changes,
    // this test fails loudly and the README must be updated.
    let old = declare("OldNoSrc5Account").unwrap().contract_class();
    let (addr, _) = old.deploy(@array![PK1.low.into(), PK1.high.into()]).unwrap();
    let sol_hash = *declare("SolAccount").unwrap().contract_class().class_hash;

    // Self-authorized upgrade: cheat the caller to the account itself.
    start_cheat_caller_address(addr, addr);
    IUpgradeableDispatcher { contract_address: addr }.upgrade(sol_hash);
    stop_cheat_caller_address(addr);

    // The SRC9 entrypoint is live (view answers) ...
    assert!(ISRC9_V2Dispatcher { contract_address: addr }.is_valid_outside_execution_nonce(42));
    // ... but SRC5 discovery is blind: the registration never ran.
    assert!(!ISRC5Dispatcher { contract_address: addr }.supports_interface(ISRC9_V2_ID));
}

#[test]
#[should_panic(expected: 'SRC9: invalid caller')]
fn outside_execution_rejects_wrong_caller() {
    // The signed request pins caller 0x999; submitting from 0x888 must fail the
    // FIRST guard — pinning the exact SRC9 error proves the caller check fires
    // before window / nonce / signature are ever consulted.
    let (_, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    let request = outside_execution_from(0x999.try_into().unwrap());
    cheat_caller_address(addr, 0x888.try_into().unwrap(), CheatSpan::TargetCalls(1));
    ISRC9_V2Dispatcher { contract_address: addr }
        .execute_from_outside_v2(request, array!['junk'].span());
}

#[test]
#[should_panic(expected: 'SRC9: now <= execute_after')]
fn outside_execution_rejects_premature_window() {
    // snforge's default block timestamp is 0, before the window opens at 5. The
    // bound is strict: SNIP-9 requires execute_after < now.
    let (_, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    let request = outside_execution_from('ANY_CALLER'.try_into().unwrap());
    ISRC9_V2Dispatcher { contract_address: addr }
        .execute_from_outside_v2(request, array!['junk'].span());
}

#[test]
#[should_panic(expected: 'SRC9: now >= execute_before')]
fn outside_execution_rejects_expired_window() {
    // now = 20 is past the window close at 10 (strict too: now < execute_before).
    let (_, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    let request = outside_execution_from('ANY_CALLER'.try_into().unwrap());
    cheat_block_timestamp(addr, 20, CheatSpan::TargetCalls(1));
    ISRC9_V2Dispatcher { contract_address: addr }
        .execute_from_outside_v2(request, array!['junk'].span());
}

#[test]
#[should_panic(expected: 'SRC9: now <= execute_after')]
fn outside_execution_rejects_window_open_boundary() {
    // now == execute_after (5) is the boundary instant that PINS strictness: it lies
    // outside the open half-interval only if the bound is `execute_after < now`.
    // Would pass under a regressed `execute_after <= now`, so this discriminates.
    let (_, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    let request = outside_execution_from('ANY_CALLER'.try_into().unwrap());
    cheat_block_timestamp(addr, 5, CheatSpan::TargetCalls(1));
    ISRC9_V2Dispatcher { contract_address: addr }
        .execute_from_outside_v2(request, array!['junk'].span());
}

#[test]
#[should_panic(expected: 'SRC9: now >= execute_before')]
fn outside_execution_rejects_window_close_boundary() {
    // now == execute_before (10) is the boundary instant that PINS strictness: it
    // lies outside the open half-interval only if the bound is `now < execute_before`.
    // Would pass under a regressed `now <= execute_before`, so this discriminates.
    let (_, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    let request = outside_execution_from('ANY_CALLER'.try_into().unwrap());
    cheat_block_timestamp(addr, 10, CheatSpan::TargetCalls(1));
    ISRC9_V2Dispatcher { contract_address: addr }
        .execute_from_outside_v2(request, array!['junk'].span());
}

#[test]
#[should_panic(expected: 'SRC9: invalid signature')]
fn outside_execution_reaches_signature_validation() {
    // End-to-end wiring proof with no new crypto fixtures: caller / window / nonce
    // guards all pass, so OZ hashes the request (SNIP-12) and dispatcher-self-calls
    // is_valid_signature. sig2() binds to HASH (base64 of HASH), but the account here
    // computes the SNIP-12 outside-execution hash, which differs, so message binding
    // fails; is_valid_signature returns 0 (SNIP-6 conformance), which OZ turns into
    // 'SRC9: invalid signature'. OZ emits that error ONLY after the self-call returns
    // non-'VALID', so reaching it (rather than an earlier caller / window / nonce SRC9
    // error) still proves the self-call reached validation.
    let (_, addr) = deploy_with_addr(PK1.low.into(), PK1.high.into());
    let request = outside_execution_from('ANY_CALLER'.try_into().unwrap());
    cheat_block_timestamp(addr, 7, CheatSpan::TargetCalls(1));
    ISRC9_V2Dispatcher { contract_address: addr }.execute_from_outside_v2(request, sig2().span());
}

// TS/Cairo counterfactual-derivation cross-check
// @starkware-libs/anystark-core's deriveSolAccountAddress (key_to_address.ts) derives a Phantom user's
// address as calculateContractAddressFromHash(salt, class_hash, [low, high], 0)
// with salt = poseidon([low, high]). These two tests bind that TS derivation to the
// Cairo runtime so the locked vector in key_to_address.test.ts can never be TS-only.
// The vector's pubkey is bytes 0..31 read as a little-endian u256; its limbs are:
// TS_VECTOR_PK_LOW / TS_VECTOR_PK_HIGH and the salt literal asserted below are
// hand-copied from the TS PUBKEY / EXPECTED.salt in key_to_address.test.ts; if the
// test pubkey ever changes, update these constants and that vector together.
const TS_VECTOR_PK_LOW: felt252 = 0xf0e0d0c0b0a09080706050403020100;
const TS_VECTOR_PK_HIGH: felt252 = 0x1f1e1d1c1b1a19181716151413121110;

#[test]
fn derived_salt_matches_ts_locked_vector() {
    // Binds the SALT half directly: the Cairo runtime's poseidon over the vector's
    // u256 limbs equals the salt starknet.js's computePoseidonHashOnElements locked
    // into key_to_address.test.ts. Salt is class-hash-independent (it hashes only the
    // pubkey limbs), so this is an exact Cairo-poseidon vs starknet.js-poseidon
    // cross-check that holds regardless of which build's class hash is deployed.
    let salt = core::poseidon::poseidon_hash_span(
        array![TS_VECTOR_PK_LOW, TS_VECTOR_PK_HIGH].span(),
    );
    assert!(salt == 0x7c4c5d1a2d076d49a47a4b8db8a10dbabdb0920328deb23b0a9ad9273d3d348);
}

// Re-derivation aid - mirrors print_vector_snip12_hash in test_outside_execution.cairo.
// Declares SolAccount (snforge's TEST-CONFIG build; its class hash currently coincides
// with the sepolia deploy class hash, differing only in leading-zero padding) and actually
// deploys it with deploy_from_zero at salt = poseidon(limbs), constructor calldata
// [low, high]. That is byte-for-byte the tuple @starkware-libs/anystark-core hashes, so the deployed address
// is starknet.js's calculateContractAddressFromHash(salt, class_hash, [low, high], 0)
// evaluated by the Cairo runtime. Panics with the (class_hash, address) pair, which is
// committed to packages/core/src/__fixtures__/cairo_derivation_vector.json and
// cross-checked in key_to_address.test.ts, binding starknet.js's address formula +
// deployer=0 to the runtime's real deployment. That cross-check also asserts the
// fixture's class_hash equals the current latest class hash, so if the contract is
// re-declared and the latest hash moves but the fixture isn't regenerated, the test fails
// loudly instead of passing on a self-consistent but stale pair. Ignored so it never
// runs in the normal suite (a passing test cannot print a panic message). Regenerate
// (values print in DECIMAL, convert to hex before committing to the JSON):
//   snforge test --ignored print_derived_deploy_vector
#[test]
#[ignore]
fn print_derived_deploy_vector() {
    let class_hash = *declare("SolAccount").unwrap().contract_class().class_hash;
    let salt = core::poseidon::poseidon_hash_span(
        array![TS_VECTOR_PK_LOW, TS_VECTOR_PK_HIGH].span(),
    );
    let (address, _) = starknet::syscalls::deploy_syscall(
        class_hash, salt, array![TS_VECTOR_PK_LOW, TS_VECTOR_PK_HIGH].span(), true,
    )
        .unwrap();
    let class_hash_felt: felt252 = class_hash.into();
    let address_felt: felt252 = address.into();
    panic!("CAIRO_DERIVATION class_hash={} address={}", class_hash_felt, address_felt);
}

fn deploy(pk_lo: felt252, pk_hi: felt252) -> ISolAccountDispatcher {
    let (dispatcher, _) = deploy_with_addr(pk_lo, pk_hi);
    dispatcher
}

fn deploy_with_addr(pk_lo: felt252, pk_hi: felt252) -> (ISolAccountDispatcher, ContractAddress) {
    let c = declare("SolAccount").unwrap().contract_class();
    let (addr, _) = c.deploy(@array![pk_lo, pk_hi]).unwrap();
    (ISolAccountDispatcher { contract_address: addr }, addr)
}

// A benign OutsideExecution from `caller`: fresh nonce, a 5 < now < 10 execution
// window, and no calls — the SNIP-9 tests target the component's guards, which
// all run before any call executes.
fn outside_execution_from(caller: ContractAddress) -> OutsideExecution {
    OutsideExecution {
        caller, nonce: 1, execute_after: 5, execute_before: 10, calls: array![].span(),
    }
}

// Drive the transaction-validation path (validate_tx, shared by __validate__ /
// __validate_deploy__ / __validate_declare__) with a cheated tx hash and signature, so a
// rejection surfaces as its NAMED panic exactly as the protocol sees it on-chain. This is
// the PANICKING surface; is_valid_signature is the SNIP-6-conforming one that returns 0 for
// the same rejections (see is_valid_signature_returns_zero_on_rejection). The should_panic
// aborts before any cheat is stopped, which is fine: each test deploys a fresh account.
fn validate_tx_reverts(addr: ContractAddress, hash: felt252, signature: Array<felt252>) {
    let acct = ISolAccountDispatcher { contract_address: addr };
    start_cheat_transaction_hash(addr, hash);
    start_cheat_signature(addr, signature.span());
    acct.__validate__(array![]);
}

// Returns a copy of `data` with the element at `index` replaced by `value`.
fn with_felt_replaced(data: Array<felt252>, index: u32, value: felt252) -> Array<felt252> {
    let mut out = array![];
    let mut position: u32 = 0;
    for element in data.span() {
        out.append(if position == index {
            value
        } else {
            *element
        });
        position += 1;
    }
    out
}
