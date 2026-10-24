# opencode ボットを Muse の VM に移す手順

Muse（<@U0CCCH69XMW>）にはプロンプトでしか頼めないので、VM 側の作業はすべて `deploy/linux/setup.sh` の
サブコマンドにして、依頼文 3 本で済むようにしてある。Mac 側（owner）の作業は、トークンの暗号化と旧ボットの停止だけ。

## 流れ

| # | どこで | 何を |
|---|---|---|
| 1 | Muse に依頼 | clone → `install` → `keygen`。公開鍵 `osc-pub1:…` と環境情報を返してもらう |
| 2 | Mac | 公開鍵に向けてトークンを暗号化（`osc-sealed1:…` の 1 行ができる） |
| 3 | Muse に依頼 | `import` → `check`。結果を返してもらう |
| 4 | Mac | 旧ボットを停止（同じ Slack アプリで 2 つ動くと、イベントが 2 つに振り分けられて両方おかしくなる）。**2026-10-24 に済み** |
| 5 | Muse に依頼 | `start --cutover` |
| 6 | Slack | ボットにメンションして返事が来るか見る |

## 依頼文 1（セットアップ）

```text
<@U0CCCH69XMW> お願いです。opencode の Slack ボット（<@U0C9Y2F2HEV>）を、あなたの VM に移します。今回はセットアップと確認まで。ボット本体（Slack ブリッジ）はまだ起動しないでください（Mac で動いている同じボットとイベントを取り合ってしまうため）。

1. clone（すでにあれば、そのディレクトリで git pull --ff-only）
   git clone https://github.com/azumag/opencode-slack-channel.git ~/opencode-slack-channel
2. セットアップ（sudo 不要。Node 22 以上が無ければ ~/.opencode-slack/node に入ります）
   ~/opencode-slack-channel/deploy/linux/setup.sh install
   - 「lingering is off」と出たら: sudo loginctl enable-linger $(id -un)（できなければ、その旨を報告）
   - 「no usable systemd」と出たら: 表示された @reboot の行を crontab に追加
3. トークン受け渡し用の鍵を作る
   ~/opencode-slack-channel/deploy/linux/setup.sh keygen
   出力された osc-pub1: で始まる 1 行を、このスレッドにそのまま返信してください（公開鍵なので貼って大丈夫です。~/.opencode-slack/handoff-key.json は秘密鍵なので VM の外に出さないでください）。
4. 次も報告してください: install の出力の最後の 20 行 / uname -m と OS / gh auth status で誰としてログインしているか（トークンの値は貼らない）/ git config --global user.name と user.email が設定済みか

やらないでほしいこと:
- setup.sh start は実行しない（合図するまで）
- ~/.config/opencode（あなた自身の opencode 設定があれば）には触れない。このセットアップは ~/.opencode-slack と ~/.config/opencode-slack-channel の中で完結します
- トークン・パスワード・鍵ファイルの中身を Slack に貼らない
- エラーが出たら、システムの設定を変えて回避せず、エラー出力をそのまま報告する
```

## Mac 側: トークンを暗号化する

Muse が返してきた `osc-pub1:…` を使う。出力の `osc-sealed1:…` は、その VM の秘密鍵でしか開けない（鍵は 1 回開けると消える）。

```sh
cd ~/work/opencode-slack-channel
node deploy/secrets.mjs seal 'osc-pub1:…' --tokens ~/.config/opencode-slack-channel/tokens.json
```

渡すのは Slack のトークン 2 つだけ。VM のボットは Zen の無料モデルだけを使うので、モデルの鍵は要らない（無料モデルは鍵なしで呼べる）。
なお opencode v2 はモデルの鍵を `auth.json` ではなく自分の DB から読む。鍵が要るモデルにするなら、`opencode2 auth export --standalone <id>` /
`auth import` で移す（OAuth の `opencode` は、リフレッシュトークンを 2 台で共有すると片方が切れうるので移さない）。

## 依頼文 2（トークンを入れて確認）

```text
<@U0CCCH69XMW> 続きです。暗号化したトークンを渡します（あなたの VM の秘密鍵でしか開けません）。

~/opencode-slack-channel/deploy/linux/setup.sh import 'osc-sealed1:…ここに貼る…'
~/opencode-slack-channel/deploy/linux/setup.sh check

check の出力をそのまま返信してください（秘密の値は出ません）。Slack のソケットにはつながないので、まだ start はしないでください。
```

`check` で見るところ:

- `✓ Slack bot token — bot … (U0C9Y2F2HEV)`: 同じボットのトークンが入った。
- `✓ Slack app token — Socket Mode URL issued (not connected)`: app トークンが有効。
- `✓ model answers — opencode/glm-5.3-flash-free, N s`: VM からモデルを呼べる。テスト用のセッションは削除される。失敗したら、
  opencode のログ（`~/.opencode-slack/xdg/data/opencode/log/opencode.log`）の ERROR 行が `· opencode log —` として出る。
- `· GitHub CLI — logged in as …`: ボットはこのアカウントで GitHub を操作する。
- `· git user.name — … (bot env)`: ボットのコミットの名義。未設定なら
  `setup.sh git-identity "azumag" azumag@users.noreply.github.com`（Mac のボットと同じ名義。`~/.gitconfig` は変えない）。

## 2026-10-24 の修正を VM に入れる（依頼文 2 のあと）

最初の install から次の 3 点を直した。VM では `git pull` のあと `install --reconfigure` で入る（設定は `.bak-*` を残して作り直し、
opencode は新しい環境で再起動する。Slack のトークンと opencode の DB はそのまま）。

- モデルを Zen の無料モデルに変えた（`glm-5.3-flash-free`、フォールバック 9 個）。opencode-go の鍵は使わない。
- `XDG_CONFIG_HOME` を差し替えていたせいで、ボットの中の gh が `~/.config/gh` を見つけられず未ログイン扱いだった。opencode の設定は
  `OPENCODE_CONFIG_DIR` で分けるようにした。
- root が `HOME=/home/…` で install すると、systemd がサービスに `HOME=/root` を渡し、ブリッジが設定を見つけられなかった。
  環境ファイルに install 時の `HOME` を書くようにした。

```text
<@U0CCCH69XMW> 修正を入れたので、次をお願いします（ブリッジはまだ起動しないでください）。

1. cd ~/opencode-slack-channel && git pull --ff-only
2. ~/opencode-slack-channel/deploy/linux/setup.sh install --reconfigure
3. ~/opencode-slack-channel/deploy/linux/setup.sh git-identity "azumag" azumag@users.noreply.github.com
4. rm -f ~/.opencode-slack/xdg/data/opencode/auth.json
   （前回渡した opencode の鍵。free モデルだけにしたので不要。opencode v2 はこのファイルを読みません）
5. ~/opencode-slack-channel/deploy/linux/setup.sh check
6. id -un; echo $HOME

check の出力と 6 の結果を返信してください。
```

## Mac 側: 旧ボットを止める（2026-10-24 に済み）

実行中のターンが無い（`/api/session/active` が空）ことを確かめてから、ブリッジ `com.azumag.opencode-slack-channel` と、
その接続先の opencode2 サーバー `ai.opencode.v2-service`（つないでいたのはブリッジだけ）を止めた。ログイン時に戻らないよう、
plist は消さずに `.plist.disabled` にリネームしてある。Slack の `users.getPresence` で、ボットの接続数が 0 になったことも確認済み。

```sh
uid=$(id -u); cd ~/Library/LaunchAgents
for l in com.azumag.opencode-slack-channel ai.opencode.v2-service; do
  launchctl bootout gui/$uid/$l; mv -n $l.plist $l.plist.disabled
done
```

Mac の opencode v1 web（`ai.opencode.web`、`*:4096`）と OpenCodeGoMeter はボットとは別物なので、動かしたまま。

## 依頼文 3（切り替え）

```text
<@U0CCCH69XMW> Mac 側のボットを止めました。次を実行して、出力を返信してください。

~/opencode-slack-channel/deploy/linux/setup.sh start --cutover
```

出力（ブリッジのログの末尾）に `slack identity: @… (U0C9Y2F2HEV, …)` と `running` があり、`socket connect failed` が無ければ起動はできている。ソケットの接続成功はログに出ないので、つながったかどうかは #agent-council で <@U0C9Y2F2HEV> にメンションして、返事が来るかで確かめる。

## 戻すとき

```text
<@U0CCCH69XMW> ~/opencode-slack-channel/deploy/linux/setup.sh stop を実行して、出力を返信してください。
```

そのあと Mac で（サーバーを先に。ブリッジは起動時にサーバーへつなぐ）:

```sh
uid=$(id -u); cd ~/Library/LaunchAgents
for l in ai.opencode.v2-service com.azumag.opencode-slack-channel; do
  mv -n $l.plist.disabled $l.plist && launchctl bootstrap gui/$uid $l.plist
done
```

## Mac 版との違い（移すと変わること）

- **スレッドとセッションの対応は引き継がない。** 移す前からあるスレッドでメンションすると、VM で新しいセッションになる（スレッドの直近 30 件を文脈として渡すので、話の流れはある程度つながる）。
- **作業場所は VM の `~/work`**（最初は空）。Mac の `~/work` のリポジトリは見えない。GitHub は VM で `gh` にログインしているアカウントで操作する。
- **モデルは Zen の無料モデルだけ。** Mac は `opencode-go/deepseek-v4.1-flash`（有料）→ gemma4:12b（Mac の tailnet 内の Ollama）→
  `x-preview-f-free` だった。VM は `glm-5.3-flash-free` → deepseek-v4.1-flash-free → mimo-v2.6-flash-free → beam-free →
  nemotron-3.5-super-vl-free → nemotron-3-ultra-free → big-pickle → flint-40b-free → x-preview-f-free → nemotron-3.5-lightning-free
  （10/18 に Mac で使っていた無料チェーンの順。space-bunny と longcat は一覧から消えていた。lightning は読むだけの依頼でファイルを
  書き換えたことがあるので最後）。
- **`secrets-hygiene.md` を VM では instructions に入れた。** Mac では `~/.config/opencode/rules/` に置いてあるだけで、opencode.json から読まれていない。GitHub に投稿するときは `~/.opencode-slack/agent-guards/gh-comment` 経由になる。
- **Mac のグローバルプラグイン（auto-continue / loop / fiosracht-model-sync）は入れない。** ボットのセッションで動いた記録が無く、fiosracht プロバイダはもう無い。
- **Zen 無料モデルの日次枠は IP ごと**なので、VM は Mac と別の枠になる。
