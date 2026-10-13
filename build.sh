#!/usr/bin/env bash
# Build file .vsix, có thể nâng version và cài luôn vào VS Code.
#
#   ./build.sh                 # nâng patch (0.1.0 -> 0.1.1) rồi build
#   ./build.sh minor           # 0.1.1 -> 0.2.0 (patch | minor | major | x.y.z)
#   ./build.sh 0.3.0 --install # đặt version cụ thể, build, cài vào VS Code
#   ./build.sh --no-bump       # giữ nguyên version, chỉ build lại
set -euo pipefail
cd "$(dirname "$0")"

bump=patch
install=false
for arg in "$@"; do
  case "$arg" in
    --install) install=true ;;
    --no-bump) bump= ;;
    -h | --help)
      sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) bump="$arg" ;;
  esac
done

[ -d node_modules ] || npm install

if [ -n "$bump" ]; then
  # Chỉ sửa package.json và package-lock.json, không tạo commit/tag.
  npm version "$bump" --no-git-tag-version >/dev/null
fi

name=$(node -p "require('./package.json').name")
version=$(node -p "require('./package.json').version")
vsix="$name-$version.vsix"

npm run compile
npm run package

echo "Đã build: $vsix"

if $install; then
  code --install-extension "$vsix" --force
  echo "Đã cài $vsix. Reload Window trong VS Code để dùng bản mới."
fi
