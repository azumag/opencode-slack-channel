# 秘密情報の取り扱い(全セッション共通・2026-10-23 owner 指示で固定)

2026-10-23 の docich#2676 インシデント(PR コメントに gh の OAuth トークン実値を混入、
GitHub secret scanning が検出・失効)を受けた再発防止ルール。owner 指示により必須。

## 1. GitHub への投稿は必ずスキャン経由

- PR / issue のコメント・レビュー本文・本文編集は、`@OSC_HOME@/agent-guards/gh-comment`
  ラッパー経由で投稿する。ラッパーを経由しない `gh pr comment` / `gh issue comment` /
  `gh api .../comments` の直接実行は禁止。
- 使い方:
  ```bash
  @OSC_HOME@/agent-guards/gh-comment pr 2676 --body-file draft.md -R azumag/docich
  @OSC_HOME@/agent-guards/gh-comment issue 1149 --body-file draft.md -R azumag/twica
  ```
- 検出時は exit 1 で `gh` 起動前に中止される。`secret-scan:allow` で回避しない
  (テスト・文書で正当に必要な場合のみ、理由を添えて最小行に限定)。
- ラッパーが使えない環境では、投稿前に `python3 @OSC_HOME@/agent-guards/secret_scan.py -` で
  本文を走査し、clean を確認してから投稿する。走査なしの投稿は行わない。

## 2. 実値の直貼りを全面禁止

- 実測・検証・レビューの入力例・フィクスチャには**合成値(ダミー)のみ**を使う。
- 実物の資格情報・トークン・API キー・cookie・セッション ID を、表・コードブロック・
  引用・スクリーンショットに貼らない。`gh auth token` の出力や keychain の値を
  テストデータとして転用しない。
- 「redact が弱い」等の指摘は、合成トークンで再現する。実トークンで再現しない。

## 3. コマンド出力・ログは要約して書く

- `gh` / `env` / `docker inspect` / `kubectl` / クラウド CLI の出力やログをそのまま
  貼らない。必要な情報だけを要約・再構成して書く。
- やむを得ず出力を示す場合は、投稿前にスキャナを通し、値は先頭数文字+長さに伏せる。

## 4. 混入に気づいたときの初動

1. 直ちに該当コメントを編集して文字列を除去(失効済みでも残さない)。削除より編集を優先
   (レビュー指摘として有効な場合)。
2. 匿名(未認証)で残存 0 件を確認する。
3. トークンの持ち主と混入経路を特定し、失効・再認証を owner に依頼する。
4. 当日の他の投稿をパターンスキャンし、範囲を確定して報告する。
