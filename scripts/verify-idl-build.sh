#!/usr/bin/env bash
set -euo pipefail

# Build every program's IDL without the Anchor CLI.
#
# `anchor build` generates the IDL in a second compile pass, with a different
# toolchain, different features and different codegen from anything `cargo
# test` or `cargo clippy` runs. Three distinct failures have reached CI through
# that gap, each invisible locally:
#
#   * a locked proc-macro2 that dropped `Span::source_file()`, which only
#     anchor-syn's IDL module calls;
#   * `anchor-spl/idl-build` failing to compile without `token_2022`;
#   * a `Program<'info, path::to::Type>` written with a qualified path, which
#     anchor-syn's account-resolution codegen reduces to its last segment.
#
# This reproduces that pass using cargo alone, so the check costs a minute
# locally instead of a CI cycle. It is not a replacement for `anchor build`:
# it proves the IDL compiles and emits, not that the artifact anchor writes is
# byte-identical. `npm run test:f1` remains the authority.

NIGHTLY="nightly-2024-06-15"
PROGRAMS=(ppv_core ppv_commerce ppv_escrow)

if ! rustup toolchain list | grep -q "^${NIGHTLY}"; then
  echo "Missing toolchain ${NIGHTLY}." >&2
  echo "Anchor 0.30.1 builds the IDL on this exact nightly: anchor-syn calls" >&2
  echo "proc_macro2::Span::source_file(), which later nightlies removed." >&2
  echo "Install it with:  rustup toolchain install ${NIGHTLY} --profile minimal" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repo_root}"

# The environment `anchor build` sets. `resolution = true` in Anchor.toml is
# what turns on the account-resolution codegen, and that codegen is stricter
# than the default: without it a qualified program path compiles fine.
resolution="$(sed -n 's/^resolution = \(.*\)$/\1/p' Anchor.toml | head -1)"
if [[ "${resolution}" == "true" ]]; then
  export ANCHOR_IDL_BUILD_RESOLUTION=TRUE
  echo "Anchor.toml sets resolution = true; building IDLs with account resolution."
else
  echo "Anchor.toml does not set resolution; building IDLs without it."
fi
export RUSTFLAGS="--cfg procmacro2_semver_exempt${RUSTFLAGS:+ ${RUSTFLAGS}}"

# A separate target directory, because this pass uses a different toolchain and
# different rustflags from every other command in the repo. Sharing ./target
# leaves artifacts the stable toolchain then rejects:
#
#   error[E0514]: found crate `ppv_core` compiled by an incompatible version
#                 of rustc
#
# which looks like a broken checkout and is really just two compilers in one
# directory.
export CARGO_TARGET_DIR="${repo_root}/target/idl-build"

status=0
for program in "${PROGRAMS[@]}"; do
  printf '%-14s ' "${program}"
  output="$(
    ANCHOR_IDL_BUILD_PROGRAM_PATH="${repo_root}/programs/${program}" \
      cargo "+${NIGHTLY}" test -p "${program}" --features idl-build -- \
      --quiet --nocapture --test-threads=1 __anchor_private_print_idl 2>&1
  )" || {
    echo "FAILED"
    echo "${output}" | grep -E '^(error|  -->)' | head -20 >&2
    status=1
    continue
  }

  # An IDL that does not emit is as broken as one that does not compile, and a
  # silent empty result is exactly what this script exists to catch.
  instructions="$(
    printf '%s' "${output}" | python3 -c '
import json, re, sys
raw = sys.stdin.read()
match = re.search(r"--- IDL begin program ---\n(.*?)\n[.\s]*--- IDL end program ---", raw, re.S)
if not match:
    sys.exit("no IDL program block in the output")
print(len(json.loads(match.group(1))["instructions"]))
'
  )" || {
    echo "FAILED (no IDL emitted)"
    status=1
    continue
  }
  echo "ok — ${instructions} instructions"
done

if [[ "${status}" -ne 0 ]]; then
  echo >&2
  echo "IDL build failed. This is what the Anchor CI job would have caught." >&2
fi
exit "${status}"
