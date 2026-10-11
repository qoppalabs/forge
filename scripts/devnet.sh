#!/usr/bin/env bash
# Devnet deployment of the Forge program, and the API/worker pointed at it. See docs/devnet.md.
# Run inside the pinned shell: nix-shell --run 'bash scripts/devnet.sh <command>'
#
#   keys        create the deployer (upgrade authority) keypair under .local/devnet/
#   program-id  mint a new program keypair and point declare_id at it, then rebuild
#   check       keypair ↔ declare_id ↔ IDL agree; deployer balance covers the deploy
#   airdrop     request Devnet SOL for the deployer (public faucet, rate-limited)
#   deploy      deploy or upgrade target/deploy/forge.so; record it in .local/devnet/
#   api         run the API and worker against Devnet with a local forge_devnet database
#
# FORGE_DEPLOYER_KEYPAIR / FORGE_PROGRAM_KEYPAIR point at existing keys instead of the defaults;
# FORGE_DEVNET_URL overrides the RPC (e.g. a local validator for a rehearsal).
set -euo pipefail
cd "$(dirname "$0")/.."

URL="${FORGE_DEVNET_URL:-https://api.devnet.solana.com}"
STATE="$PWD/.local/devnet"
DEPLOYER="${FORGE_DEPLOYER_KEYPAIR:-$STATE/deployer.json}"
PROGRAM_KEYPAIR="${FORGE_PROGRAM_KEYPAIR:-$STATE/program.json}"
PG_PORT="${FORGE_PG_PORT:-54329}"
SO=target/deploy/forge.so

declared() { grep -oP 'declare_id!\("\K[^"]+' programs/forge/src/lib.rs; }

keys() {
	mkdir -p "$STATE"
	if [[ ! -f $DEPLOYER ]]; then
		solana-keygen new --silent --no-bip39-passphrase --outfile "$DEPLOYER" >/dev/null
	fi
	echo "deployer (upgrade authority): $(solana-keygen pubkey "$DEPLOYER")  [$DEPLOYER]"
}

program_id() {
	mkdir -p "$STATE"
	if [[ -f $PROGRAM_KEYPAIR ]]; then
		echo "refusing to overwrite $PROGRAM_KEYPAIR" >&2
		exit 1
	fi
	solana-keygen new --silent --no-bip39-passphrase --outfile "$PROGRAM_KEYPAIR" >/dev/null
	local id old
	id=$(solana-keygen pubkey "$PROGRAM_KEYPAIR")
	old=$(declared)
	sed -i "s/$old/$id/" programs/forge/src/lib.rs Anchor.toml
	echo "program id $old → $id (lib.rs, Anchor.toml); rebuilding"
	bash scripts/build.sh
}

check() {
	local id ok=1
	id=$(declared)
	echo "declared program id: $id"
	if [[ ! -f $PROGRAM_KEYPAIR ]]; then
		echo "✘ no program keypair at $PROGRAM_KEYPAIR (use the key for $id, or run program-id)"
		ok=0
	elif [[ $(solana-keygen pubkey "$PROGRAM_KEYPAIR") != "$id" ]]; then
		echo "✘ $PROGRAM_KEYPAIR is $(solana-keygen pubkey "$PROGRAM_KEYPAIR"), not $id"
		ok=0
	else
		echo "✔ program keypair matches"
	fi
	if [[ $(jq -r .address target/idl/forge.json) != "$id" ]]; then
		echo "✘ target/idl/forge.json is for another id; run scripts/build.sh"
		ok=0
	else
		echo "✔ IDL matches; $SO sha256 $(sha256sum "$SO" | cut -c1-16)…"
	fi
	if [[ -f $DEPLOYER ]]; then
		# Rent-exempt minimum is (bytes + 128) × 6960 lamports. A first deploy holds a buffer and
		# the program data at once (twice that); an upgrade only needs the buffer. Plus fees.
		local need have copies=2
		if solana program show "$id" --keypair "$DEPLOYER" --url "$URL" >/dev/null 2>&1; then
			copies=1
		fi
		need=$((($(stat -c %s "$SO") + 128) * 6960 * copies + 50000000))
		# Finalized, like the deploy itself: a fresh airdrop is not spendable there yet.
		have=$(solana balance "$(solana-keygen pubkey "$DEPLOYER")" --url "$URL" --lamports \
			--commitment finalized | cut -d' ' -f1)
		echo "deployer balance $((have / 1000000000)).$(printf %09d $((have % 1000000000)) | cut -c1-3) SOL, deploy needs ≈ $((need / 1000000000)).$(printf %09d $((need % 1000000000)) | cut -c1-3) SOL"
		((have >= need)) || ok=0
	else
		echo "✘ no deployer keypair; run keys"
		ok=0
	fi
	((ok)) && echo "ready to deploy to $URL" || {
		echo "not ready"
		return 1
	}
}

airdrop() {
	local who
	who=$(solana-keygen pubkey "$DEPLOYER")
	solana airdrop 2 "$who" --url "$URL" ||
		echo "faucet refused (rate limit); fund $who at https://faucet.solana.com and run check" >&2
}

deploy() {
	check
	solana program deploy "$SO" --program-id "$PROGRAM_KEYPAIR" --keypair "$DEPLOYER" \
		--upgrade-authority "$DEPLOYER" --url "$URL" --commitment finalized
	solana program show "$(declared)" --keypair "$DEPLOYER" --url "$URL" --output json >"$STATE/deployment.json"
	jq --arg sha "$(sha256sum "$SO" | cut -d' ' -f1)" '. + {soSha256: $sha}' "$STATE/deployment.json" >"$STATE/deployment.tmp"
	mv "$STATE/deployment.tmp" "$STATE/deployment.json"
	echo "recorded $STATE/deployment.json"
}

api() {
	psql -h 127.0.0.1 -p "$PG_PORT" -U forge -d postgres -tAc \
		"SELECT 1 FROM pg_database WHERE datname = 'forge_devnet'" | grep -q 1 ||
		psql -h 127.0.0.1 -p "$PG_PORT" -U forge -d postgres -qc "CREATE DATABASE forge_devnet"
	FORGE_DATABASE_URL="postgres://forge@127.0.0.1:$PG_PORT/forge_devnet" FORGE_RPC_URL="$URL" \
		FORGE_NETWORK=devnet exec bun apps/api/src/main.ts all
}

case "${1:-}" in
keys) keys ;;
program-id) program_id ;;
check) check ;;
airdrop) airdrop ;;
deploy) deploy ;;
api) api ;;
*)
	echo "usage: $0 {keys|program-id|check|airdrop|deploy|api}" >&2
	exit 2
	;;
esac
