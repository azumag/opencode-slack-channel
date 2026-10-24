# vendor

Linux セットアップ（[deploy/linux/setup.sh](../deploy/linux/setup.sh)）が `~/.opencode-slack/` にコピーして使う、Mac 版ボットと同じ中身のコピー。npm や他のリポジトリから取ってこないので、clone だけで同じものが入る。

| ディレクトリ | 中身 | 元 |
|---|---|---|
| `opencode-rate-limit-fallback/` | opencode のモデルフォールバックプラグイン（ビルド済み JS、依存なし） | Mac の `~/.local/share/opencode-local-plugins/opencode-rate-limit-fallback-2.1.0`（[azumag/opencode-rate-limit-fallback](https://github.com/azumag/opencode-rate-limit-fallback) の v2 をビルドしたもの）。2026-10-24 時点のコピー |
| `agent-guards/` | GitHub 投稿前の秘密情報スキャン（`gh-comment` ラッパーと `secret_scan.py`、Python 標準ライブラリのみ） | Mac の `~/work/agent-guards`。テストと audit は含めない |

更新するときは元からコピーし直して、Linux 側で `deploy/linux/setup.sh install` を再実行する（install は毎回 vendor から入れ直す）。

## opencode-rate-limit-fallback に足したもの（元にはない。コピーし直すときは移し替える）

- **設定ファイルを `OPENCODE_CONFIG_DIR` からも探す**（`src/utils/config.js`）。Linux 版は opencode の設定をそこに置き、`XDG_CONFIG_HOME` は変えないので、これがないとプラグインが設定を見つけられず、フォールバックが一切働かない。
- **`autoFallback: { providers, freeOnly, unavailableMs }`**（`v2.js`）。フォールバック先に、サーバーがその時点で一覧に出しているモデル（`providers` のもの。`freeOnly` が既定の true なら無料のものだけ、ツールが使えて active なもの）を、`fallbackModels` の後ろに新しい順で足す。モデルが増えたり消えたりしても設定を直さなくてよい。
  - `fallbackModels` に書いたものでも、一覧にないものは飛ばす（優先順のヒントとして使うだけ）。
  - 「Model is unavailable」などモデル自体が使えないという失敗をしたモデルは、`unavailableMs`（既定 6 時間）のあいだチェーンから外す。
  - 普通のプロンプトの前に、セッションのモデルが一覧にないか、使えないと分かっているなら、先に使えるモデルへ切り替える（失敗してから切り替えるのではなく）。
