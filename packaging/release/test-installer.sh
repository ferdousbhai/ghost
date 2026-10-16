#!/usr/bin/env bash
# The Install → AI → Ghost entry Omarchy runs: it installs the package, starts
# the daemon, and enables the HUD once the shell has discovered it.
set -euo pipefail
# Relative to this file, not to git: test-check-dependencies.sh also runs this
# inside makepkg's check() and inside the extracted source archive, where
# there is no repository.
script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd -- "$(realpath -e -- "$script_dir/../..")"

installer=packaging/omarchy/bin/omarchy-install-ai-ghost
bash -n "$installer"

# Exercise it without contacting the owner's shell or services.
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$work/bin" "$work/home"
cat > "$work/bin/omarchy" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == 'plugin list --json' ]]; then
  count=$(cat "$TEST_STATE/count")
  count=$((count + 1))
  echo "$count" > "$TEST_STATE/count"
  if [[ "$TEST_DISCOVERY" == delayed && "$count" -ge 3 ]]; then
    echo '[{"id":"ferdousbhai.ghost"}]'
  else
    echo '[]'
  fi
else
  [[ "$*" == 'plugin enable ferdousbhai.ghost' ]]
  [[ "$(cat "$TEST_STATE/count")" -ge 3 ]]
  echo enabled >> "$TEST_STATE/actions"
fi
EOF
for command in omarchy-pkg-add systemctl omarchy-shell sleep; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$work/bin/$command"
done
for command in bash cat grep jq ln mkdir rm; do
  ln -s "$(command -v "$command")" "$work/bin/$command"
done
# Never invoke the machine's upstream installer or privilege helper.
printf '#!/usr/bin/env bash\nexit 0\n' > "$work/bin/sudo"
chmod +x "$work/bin/omarchy" "$work/bin/sudo"
for command in omarchy-pkg-add systemctl omarchy-shell sleep; do
  chmod +x "$work/bin/$command"
done
for discovery in delayed missing; do
  echo 0 > "$work/count"
  : > "$work/actions"
  result=0
  HOME="$work/home" PATH="$work/bin" TEST_STATE="$work" \
    TEST_DISCOVERY="$discovery" bash "$installer" > "$work/output" 2>&1 || result=$?
  if [[ "$discovery" == delayed ]]; then
    [[ "$result" == 0 ]]
    [[ "$(cat "$work/count")" == 3 ]]
    grep -Fxq enabled "$work/actions"
    grep -Fq 'ghost new <name>' "$work/output"
    ! grep -Fq 'ghost login' "$work/output"
  else
    [[ "$result" != 0 ]]
    [[ "$(cat "$work/count")" == 40 ]]
    [[ ! -s "$work/actions" ]]
    grep -Fq 'enable the HUD with:' "$work/output"
  fi
done
printf 'ok the menu installer waits for discovery and fails with a recovery command\n'
