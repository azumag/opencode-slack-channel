# vendor

Linux セットアップ（[deploy/linux/setup.sh](../deploy/linux/setup.sh)）が `~/.opencode-slack/` にコピーして使う、Mac 版ボットと同じ中身のコピー。npm や他のリポジトリから取ってこないので、clone だけで同じものが入る。

| ディレクトリ | 中身 | 元 |
|---|---|---|
| `opencode-rate-limit-fallback/` | opencode のモデルフォールバックプラグイン（ビルド済み JS、依存なし） | Mac の `~/.local/share/opencode-local-plugins/opencode-rate-limit-fallback-2.1.0`（[azumag/opencode-rate-limit-fallback](https://github.com/azumag/opencode-rate-limit-fallback) の v2 をビルドしたもの）。2026-10-24 時点のコピー |
| `agent-guards/` | GitHub 投稿前の秘密情報スキャン（`gh-comment` ラッパーと `secret_scan.py`、Python 標準ライブラリのみ） | Mac の `~/work/agent-guards`。テストと audit は含めない |

更新するときは元からコピーし直して、Linux 側で `deploy/linux/setup.sh install` を再実行する（install は毎回 vendor から入れ直す）。
