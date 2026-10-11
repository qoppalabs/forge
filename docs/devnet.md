# Devnet deployment

`scripts/devnet.sh` deploys the Forge program to Solana Devnet and runs the API and worker against it. Devnet uses test SOL and the `FORGE_TEST_USD` fixture mint only; mainnet is out of scope.

Run every command inside the pinned shell: `nix-shell --run 'bash scripts/devnet.sh <command>'`.

## Decision before the first deploy: the program identity

The program's address is the public key of a program keypair, and `declare_id!` in `programs/forge/src/lib.rs` must equal it, or every instruction fails. The repository declares `4niyjcxN6ySLBVePpUaUHrUEQZvyKDyNYfiQ8N4FUTgP`. Its secret key is not in the repository and was not found on the build machine. The `target/deploy/forge-keypair.json` produced by `scripts/build.sh` belongs to a different address because builds use `--ignore-keys`.

Pick one:

- **Keep `4niyjc…`:** whoever holds that keypair runs the deploy with `FORGE_PROGRAM_KEYPAIR=/path/to/it`.
- **New Devnet id:** `program-id` creates `.local/devnet/program.json`, rewrites `lib.rs` and `Anchor.toml` to its address and rebuilds (offline once `.tools/` is populated). Commit the two changed files; keep the keypair out of git and back it up, because it controls nothing after deployment but is the only way to deploy to that address again from scratch.

## Upgrade authority

`deploy` makes the deployer keypair (`.local/devnet/deployer.json` by default, or `FORGE_DEPLOYER_KEYPAIR`) the program's upgrade authority. That key can replace the program at any time. The deployed program is therefore not immutable, and nothing in this prototype should say otherwise. `deploy` records the authority, deploy slot, data length and the SHA-256 of the deployed `forge.so` in `.local/devnet/deployment.json`; publish those values with the demo.

## Steps

```sh
nix-shell --run 'bash scripts/build.sh'              # program + IDL
nix-shell --run 'bash scripts/devnet.sh keys'        # deployer keypair; prints its address
nix-shell --run 'bash scripts/devnet.sh program-id'  # only if not keeping 4niyjc…
nix-shell --run 'bash scripts/devnet.sh airdrop'     # repeat until check passes, or use https://faucet.solana.com
nix-shell --run 'bash scripts/devnet.sh check'       # keypair ↔ declare_id ↔ IDL, balance ≥ need
nix-shell --run 'bash scripts/devnet.sh deploy'      # first deploy or upgrade
bun run --cwd packages/sdk build                     # SDK and API pick up the deployed id from the IDL
nix-shell --run 'bash scripts/localnet.sh pg-up'
nix-shell --run 'bash scripts/devnet.sh api'         # API + worker on Devnet, database forge_devnet
```

A first deploy of the current 321 KB program needs about 4.5 SOL: the buffer and the program data are both rent-exempt during the deploy. An upgrade needs about 2.3 SOL. `check` computes the figure for the current binary and reads the balance at finalized commitment, the same view the deploy uses.

## Rehearsal

The whole flow was rehearsed against a local validator (`FORGE_DEVNET_URL=http://127.0.0.1:8899`) in a scratch worktree on 11 October 2026: new program id, offline rebuild (7 min), deployer, faucet, `check`, first deploy, upgrade, recorded deployment, and `api` serving `network: devnet` with a running worker. The rehearsal found and fixed two problems: `check` read the balance at a weaker commitment than `deploy`, and it asked for first-deploy funding before an upgrade.

## Not covered yet

- Devnet fixtures: `apps/localnet` seeds wallets and the test mint with local airdrops, which the public Devnet faucet rate-limits. A Devnet demo needs those wallets funded once and the seed pointed at Devnet.
- The console's local demo signing holds keys in the browser; on a shared Devnet demo, signers should use their own wallets.
