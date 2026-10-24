# agent-guards

エージェントが GitHub へ投稿する本文の**秘密情報スキャン**。2026-10-23 の
docich#2676 インシデント（PR コメントに `gh` の OAuth トークン実値を混入）の再発防止。

`docich/AGENTS.md` §3「機密情報を書かない」は既に存在していた規則で、欠けていたのは
規則ではなく**投稿直前の機械的な関門**。これをその関門にする。

## 使い方

投稿前に本文を走査する:

```bash
python3 secret_scan.py draft.md          # 検出あれば exit 1
echo "本文" | python3 secret_scan.py -   # stdin
python3 secret_scan.py --json draft.md   # 機械可読
python3 secret_scan.py --redact draft.md # 伏せた本文を stdout へ
```

投稿をラップして強制する（推奨）:

```bash
./gh-comment pr 2676 --body-file draft.md
./gh-comment issue 1149 --body-file draft.md -R azumag/docich
```

検出時は投稿せず exit 1。`gh` の起動前に止まるため、資格情報が飛ぶことはない。

## exit code

| code | 意味 |
|---|---|
| 0 | clean（投稿可） |
| 1 | 秘密情報らしき文字列を検出（投稿中止） |
| 2 | 使い方・IO エラー |
| 3 | スキャナ/実行環境の異常（fail-closed で中止。**検出とは区別**） |

`gh-comment` は `/bin/bash`（macOS 同梱 3.2）と `/usr/bin/python3`（system Python）を
優先して使う。homebrew の bash / python3 が dylib 欠落や sandbox 制約で落ちる環境でも
起動できるようにするため。スキャナが異常終了した場合は exit 3 で止まり、
「検出した」とは表示しない（原因の取り違えを防ぐ）。

## 設計

- **検出値は絶対に出力しない。** 先頭6文字 + `***` + 長さのみ（`gho_tF*** (40 chars)`）。
- 既知の公開サンプル（`AKIAIOSFODNN7EXAMPLE` 等）は除外。
- `<REDACTED>` / `…` / `***` / `redacted` / `placeholder` を含む値はプレースホルダとして除外。
- 行末に `secret-scan:allow` がある行はスキップ（テスト・文書用）。
- 検出ルール: GitHub トークン（`gho_`/`ghp_`/`ghs_`/`ghu_`/`ghr_`、`github_pat_`）、
  Slack トークン・webhook、AWS access key、Google API key、GitLab PAT、`sk-` 系、
  Stripe live key、秘密鍵ブロック、JWT、Bearer ヘッダ、URL 資格情報、
  `KEY=value` / `"key": "value"` 形。

### `_` 境界の教訓

`\b(api[_-]?key|token|...)` は `SLACK_BOT_TOKEN=` を取りこぼす（`_` は語構成文字で
境界が切れない）。本スキャナはキーワード前に `[A-Za-z0-9_.-]{0,40}` を許して回避し、
回帰テスト `test_detects_slack_token_after_underscore_key` で固定している。

## 限界

- 未知形式のトークン、高エントロピー文字列、**コマンド出力の貼り付け**そのものは
  検出できない。スキャナは最後の網であって、生出力を貼らない規律の代替ではない。
- 検出は行単位のパターン一致。分割・難読化された秘密はすり抜ける。
- `password=hunter2` のような**16文字未満の key=value は意図的に止めない**。
  実 credential ではない例示まで止めると通常の文面で誤爆し、関門ごと無効化されるため。
  この閾値は `test_short_key_value_is_not_flagged_by_design` で固定している。

## テスト

```bash
python3 -m pytest tests/ -q
```
