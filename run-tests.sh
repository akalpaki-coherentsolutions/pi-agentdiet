#!/usr/bin/env bash
# Unit tests for the agentdiet extension.
#
# Runs in a temp dir with stubbed @earendil-works modules, because the real ones
# only resolve inside a running pi process. Node strips TypeScript natively, so
# there is no build step and no dependency on any repo checkout.
#
# Typechecking is a bonus: it runs only if a tsc turns up, and is skipped otherwise.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="$(mktemp -d "${TMPDIR:-/tmp}/agentdiet.XXXXXX")"
trap 'rm -rf "$out"' EXIT

mkdir -p "$out/node_modules/@earendil-works/pi-coding-agent" "$out/node_modules/@earendil-works/pi-ai"
printf '{"type":"module"}\n' > "$out/package.json"

cat > "$out/node_modules/@earendil-works/pi-coding-agent/index.js" <<'EOF'
export function getAgentDir() { return "/tmp/agentdir"; }
export function estimateTokens(message) {
  let chars = 0;
  const content = message.content;
  if (typeof content === "string") chars = content.length;
  else if (Array.isArray(content)) for (const b of content) if (b.type === "text") chars += b.text.length;
  return Math.ceil(chars / 4);
}
EOF
printf '{"name":"@earendil-works/pi-coding-agent","type":"module","main":"index.js"}\n' \
  > "$out/node_modules/@earendil-works/pi-coding-agent/package.json"
printf 'export function uuidv7(){return "uuid-test";}\n' \
  > "$out/node_modules/@earendil-works/pi-ai/index.js"
printf '{"name":"@earendil-works/pi-ai","type":"module","main":"index.js"}\n' \
  > "$out/node_modules/@earendil-works/pi-ai/package.json"

cp "$here/index.ts" "$here/test.mjs" "$out/"

global_node_modules="$(npm root -g 2>/dev/null || true)"
pi_pkg="${PI_CODING_AGENT_PACKAGE_DIR:-$global_node_modules/@earendil-works/pi-coding-agent}"
tsc=""
for candidate in "$(command -v tsc || true)"; do
  [ -n "$candidate" ] && [ -x "$candidate" ] && { tsc="$candidate"; break; }
done

if [ -n "$tsc" ] && [ -d "$pi_pkg" ]; then
  cat > "$out/node-stub.d.ts" <<'EOF'
declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
  export function writeFileSync(path: string, data: string, encoding: string): void;
}
declare module "node:path" {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
}
EOF
  cat > "$out/tsconfig.json" <<EOF
{
  "compilerOptions": {
    "target": "ES2023", "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noEmit": true, "skipLibCheck": true,
    "allowImportingTsExtensions": true, "types": [],
    "paths": {
      "@earendil-works/pi-coding-agent": ["$pi_pkg/dist/index.d.ts"],
      "@earendil-works/pi-ai": ["$pi_pkg/node_modules/@earendil-works/pi-ai/dist/index.d.ts"]
    }
  },
  "files": ["$out/node-stub.d.ts", "$out/index.ts"]
}
EOF
  "$tsc" -p "$out/tsconfig.json"
  echo "typecheck clean"
else
  echo "typecheck SKIPPED (no tsc found)"
fi

cd "$out" && node test.mjs
