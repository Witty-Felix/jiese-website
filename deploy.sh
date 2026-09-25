#!/usr/bin/env sh
# 部署到 Cloudflare Pages —— 只发布公开静态资源。
#
# 为什么需要这一层：
#   `wrangler pages deploy <dir>` 会上传 <dir> 下的**全部**文件，只排除一份硬编码清单
#   （_worker.js / _redirects / _headers / _routes.json / .DS_Store / node_modules / .git），
#   并且**不读 .gitignore**（`.assetsignore` 对 Pages 也不生效，已实测）。
#   因此直接 `deploy .` 会把本地密钥 `.dev.vars`（ima OpenAPI 凭据 + 邀请码）、工程资料
#   `.workbuddy/`、`wrangler.toml` 一并公开发布 —— 2026-09-25 已因此发生真实泄露事故。
#   本脚本改为「白名单拷贝到 .deploy/ 再发布」，从机制上杜绝该类事故。
#
# 维护须知：新增公开静态资源时，必须同步加进下面的 PUBLIC_FILES / PUBLIC_DIRS，
#           否则该资源不会上线（表现为线上 404 或返回 SPA 首页）。
set -eu
cd "$(dirname "$0")"

PUBLIC_FILES="index.html app.js styles.css _headers"
PUBLIC_DIRS="functions"

rm -rf .deploy
mkdir -p .deploy
for f in $PUBLIC_FILES; do cp "$f" .deploy/; done
for d in $PUBLIC_DIRS; do cp -r "$d" .deploy/; done

# 兜底自检：私密文件一旦混入就中止，宁可部署失败也不发布凭据
for forbidden in .dev.vars .workbuddy docs wrangler.toml README.md CONTEXT.md AGENTS.md; do
  if [ -e ".deploy/$forbidden" ]; then
    echo "✗ 发布目录混入私密文件：$forbidden —— 已中止部署" >&2
    exit 1
  fi
done

echo "→ 发布目录 .deploy/ 内容：$(find .deploy -type f | wc -l) 个文件"
exec npx wrangler pages deploy .deploy --project-name jiese-checkin --commit-dirty=true "$@"
