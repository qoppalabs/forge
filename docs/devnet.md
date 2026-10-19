# Devnet deployment

`scripts/devnet.sh` deploys the Forge program to Solana Devnet and runs the API and worker against it. Devnet uses test SOL and the `FORGE_TEST_USD` fixture mint only; mainnet is out of scope.

Run every command inside the pinned shell: `nix-shell --run 'bash scripts/devnet.sh <command>'`.

## Program identity

The program's address is the public key of a program keypair, and `declare_id!` in `programs/forge/src/lib.rs` must equal it, or every instruction fails. The prototype first declared `4niyjcxN6ySLBVePpUaUHrUEQZvyKDyNYfiQ8N4FUTgP`, whose secret key was never in the repository. On 11 October 2026 a new id was minted for Devnet:

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

## Demo fixtures

The public faucet rate-limits airdrops, so on Devnet the seed does not airdrop to every role. With `FORGE_FIXTURE_WALLETS` set, it keeps the role wallets in that file, checks that the treasury holds at least 0.3 SOL, and pays approver A, approver B and the borrower 0.05 SOL each from it. The first run creates the wallets and stops with the treasury address to fund (https://faucet.solana.com); later runs reuse them.

```sh
nix-shell --run 'bash scripts/devnet.sh api'         # creates the forge_devnet database; keep it running
FORGE_RPC_URL=https://api.devnet.solana.com \
FORGE_DATABASE_URL=postgres://forge@127.0.0.1:54329/forge_devnet \
FORGE_FIXTURE_WALLETS=.local/devnet/fixture-wallets.json \
FORGE_DEMO_DIR=.local/devnet \
  bun apps/localnet/src/seed.ts                      # wallets, mint, institutions → .local/devnet/session.json
FORGE_DEMO_SESSION=$PWD/.local/devnet/session.json bun run dev:console
```

`FORGE_DEMO_DIR=.local/devnet bun apps/localnet/src/direct-draw.ts` calls `draw_loan` on the session's newest loan directly, around the API. Before both approvals the program rejects it, and the failed transaction lands where an explorer can show it.

Fixtures seeded on 12 October 2026:

| Fixture | Address |
| --- | --- |
| Treasury, also the mint authority | `7JBFmF73kkJc6vrRebntKYCNbjV4UqiKrXkGq1sk7SVQ` |
| `FORGE_TEST_USD` mint | `EaobAHzbHXAoWdqBbvyQCWxU1PAZZF3SuGmAoYM1Zhv5` |

The mint has six decimals and no freeze authority. Its supply is 10,100 test tokens: 10,000 for the treasury to fund the vault and 100 for the borrower's interest. The treasury keeps mint authority and can issue more. The wallet seeds and API keys stay in the ignored `.local/devnet/`.

## Not covered yet

- The console's local demo signing holds keys in the browser; on a shared Devnet demo, signers should use their own wallets.
