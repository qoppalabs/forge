# Devnet deployment

`scripts/devnet.sh` deploys the Forge program to Solana Devnet and runs the API and worker against it. Devnet uses test SOL and the `FORGE_TEST_USD` fixture mint only; mainnet is out of scope.

Run every command inside the pinned shell: `nix-shell --run 'bash scripts/devnet.sh <command>'`.

## Program identity

The program's address is the public key of a program keypair, and `declare_id!` in `programs/forge/src/lib.rs` must equal it, or every instruction fails. The prototype first declared `4niyjcxN6ySLBVePpUaUHrUEQZvyKDyNYfiQ8N4FUTgP`, whose secret key was never in the repository. On 11 October 2026 the product owner chose a new id for Devnet:

| Role | Public key | Secret key |
| --- | --- | --- |
| Program | `CktNaBZSqpvStJtXVm7Jtjs47L2JqWd66564CV3HLwdx` | `.local/devnet/program.json` on the deploying machine |
| Deployer and upgrade authority | `FQM2nPX3s8TchNDfhzLD1Gj61AWA8CUKuaVDE5BdXcQq` | `.local/devnet/deployer.json` on the deploying machine |

Both secrets are ignored by git; back them up. The program key is needed again only to redeploy that address from scratch; the deployer key controls every upgrade. `program-id` mints a new id the same way for any other cluster or a fresh start.

## Current deployment

| Fact | Value |
| --- | --- |
| Program | `CktNaBZSqpvStJtXVm7Jtjs47L2JqWd66564CV3HLwdx` |
| Upgrade authority | `FQM2nPX3s8TchNDfhzLD1Gj61AWA8CUKuaVDE5BdXcQq` |
| Deployed | 11 October 2026, slot 510016536, signature `3zUKNpapz83zForg7EhFoGQzGW2xvYvsy6r5SsPmXCnTLpgfq5segcQL7Vw2VWokAue8ZoZeToh6ipUKwUqhVVBp` |
| Built from | commit `9287122` with `bash scripts/build.sh`; later commits do not change `programs/` |
| Program data | 321,256 bytes, SHA-256 `058cfa0c071a33095740fe74f8c6b1943a1d5ab68115e1984d602de9c2458224` |

Checked after the deploy: `solana program dump` returns bytes with the same SHA-256 as the local `target/deploy/forge.so`, and a simulated `create_vault` with a made-up mint executes the program and fails on `AccountNotInitialized` (3012) for that mint, so the declared id matches the deployed address.

## Upgrade authority

`deploy` makes the deployer keypair (`.local/devnet/deployer.json` by default, or `FORGE_DEPLOYER_KEYPAIR`) the program's upgrade authority. That key can replace the program at any time. The deployed program is therefore not immutable, and nothing in this prototype should say otherwise. `deploy` records the authority, deploy slot, data length and the SHA-256 of the deployed `forge.so` in `.local/devnet/deployment.json`; publish those values with the demo.

## Steps

```sh
nix-shell --run 'bash scripts/build.sh'              # program + IDL
nix-shell --run 'bash scripts/devnet.sh keys'        # deployer keypair; prints its address
nix-shell --run 'bash scripts/devnet.sh program-id'  # only to mint another program id
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
