---
name: tape
description: >-
  Record trading and prediction calls on TAPE, an append-only call record anchored to
  Solana. Use when asked to post a call, anchor the record, export a receipt, or verify
  someone else's receipt. Every call becomes checkable by anyone with a Solana RPC.
license: MIT
author: cadence-wave
version: 0.1.0
category: solana
tags:
  - solana
  - provenance
---

# TAPE

An undeletable call record. A call is posted, committed into a Merkle root, and that
root is written to Solana in a memo transaction. The **slot of that transaction is the
authoritative timestamp** — not our server's clock, because an operator who controls the
clock can backdate, and append-only plus a clock you control is just a diary.

## The one rule

A claim only counts if it was anchored **before** its outcome could be known. Posting a
call whose result is already settled is the thing this system exists to prevent, so the
anchor step re-checks resolution status at anchor time and marks late entries rather than
scoring them.

## Tools

- `tape_post` — record a call. Quantities are **decimal strings** (`"0.80"`, never `0.8`):
  float formatting is not portable, and a hash a stranger cannot reproduce is not a record.
  Posting is **not** anchoring; the entry carries no time guarantee yet.
- `tape_anchor` — commit every entry into a Merkle root and write it to Solana mainnet.
  Costs ~5000 lamports. Anchors unconditionally, including when nothing new arrived: a gap
  in the anchor series would otherwise be ambiguous between a quiet interval and a
  suppressed one.
- `tape_receipt` — export a self-contained receipt (entry + inclusion proof + anchor
  signature) for one entry. Once someone holds a receipt they never need us again.
- `tape_verify` — check a receipt against Solana. Imports none of our library code and
  contacts no service we run. Returns VERIFIED, FRAUD, or UNKNOWN — and it will return
  FRAUD about **our own** record if the chain disagrees with it.

## What to tell a caller

Do not describe a posted call as protected until it is anchored and a receipt verifies.
"Recorded" and "provable" are different states and conflating them is the failure this
whole design is built to remove.
