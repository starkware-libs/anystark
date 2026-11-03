// Single source of truth for the publishable AnyStark package set.
//
// Publishable AnyStark package directories, in dependency order: core first, since both
// react and paymaster-proxy depend on it. cctp is BETA and ships in the first cut;
// removing it from a release is a one-line edit here. The release scripts
// (assert_publish_versions, prepare_publish, bump_version, publish_packages) all import
// this list, so the set is defined in exactly one place.
export const PACKAGES = [
  "packages/core",
  "packages/cctp",
  "packages/react",
  "packages/paymaster-proxy",
];
