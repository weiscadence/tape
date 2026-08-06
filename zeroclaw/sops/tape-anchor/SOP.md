# TAPE interval anchor

Runs every 15 minutes. Anchors first, verifies second.

**Anchoring is unconditional and that is a deliberate reversal.** The earlier
`anchor-now` refused to anchor when any entry failed the eligibility gate. In a daemon
that is a self-inflicted denial of service: one bad entry and every honest call posted
after it goes unanchored forever — and it hands the operator a deniable way to freeze the
record precisely when it is about to say something inconvenient. **An anchor attests
time, not validity.** Eligibility is a separate, re-derivable judgement over an already
committed record.

## Steps

1. **Anchor** — Commit every entry to a Merkle root and write it to Solana mainnet.
   - call: {"tool":"tape_anchor","args":{}}
   - tools: tape_anchor
   - on_failure: retry:2
   - next: 2

2. **Receipt** — Export a receipt for the newest anchored entry.
   - call: {"tool":"tape_receipt","args":{"selector":"latest"}}
   - tools: tape_receipt
   - on_failure: fail
   - next: 3

3. **Verify** — Check that receipt against Solana with the independent verifier.
   - call: {"tool":"tape_verify","args":{"receipt_path":"/tmp/tape-latest-receipt.json"}}
   - tools: tape_verify
   - on_failure: fail
   - terminal: true
