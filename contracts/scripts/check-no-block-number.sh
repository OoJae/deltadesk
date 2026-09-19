#!/usr/bin/env bash
# Fails if block.number is used in contracts/src. On Robinhood Chain (Arbitrum Orbit) block.number is an L1 block
# estimate, so every limit must use block.timestamp (invariant I13). Comments are stripped first: the frozen
# IDeskLane interface mentions the rule in its NatSpec.
set -euo pipefail
cd "$(dirname "$0")/.."

hits=$(find src -name '*.sol' -print0 | xargs -0 perl -0777 -ne '
  my $f = $ARGV;
  s{/\*.*?\*/}{ my $c = $&; $c =~ s/[^\n]//g; $c }gse;  # block comments (keep line numbers)
  s{//[^\n]*}{}g;                                        # line comments
  my $n = 0;
  for my $line (split /\n/, $_, -1) { $n++; print "$f:$n: $line\n" if $line =~ /block\s*\.\s*number/; }
')

if [ -n "$hits" ]; then
  echo "block.number is not allowed in src/ (use block.timestamp):" >&2
  echo "$hits" >&2
  exit 1
fi
echo "ok: no block.number in src/"
