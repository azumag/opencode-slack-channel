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
| 7 | Muse に依頼 | 10 分ごとの cron で `start-saved`（VM が作り直されても戻るように）。切り替えの前に入れておいてよい |

## 依頼文 1（セットアップ）

```text
<@U0CCCH69XMW> お願いです。opencode の Slack ボット（<@U0C9Y2F2HEV>）を、あなたの VM に移します。今回はセットアップと確認まで。ボット本体（Slack ブリッジ）はまだ起動しないでください（Mac で動いている同じボットとイベントを取り合ってしまうため）。

1. clone（すでにあれば、そのディレクトリで git pull --ff-only）
   git clone https://github.com/azumag/opencode-slack-channel.git ~/opencode-slack-channel
2. セットアップ（sudo 不要。Node 22 以上が無ければ ~/.opencode-slack/node に入ります）
   ~/opencode-slack-channel/deploy/linux/setup.sh install
   - 「lingering is off」と出たら: sudo loginctl enable-linger $(id -un)（できなければ、その旨を報告）
   - 「no usable systemd」と出たら: 表示された start-saved の行を crontab に追加
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
VM の IP で無料枠が尽きていたため、Zen の API キーも渡せるようにした（`--zen-key`。下の「2026-10-24 (5)」）。
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
- `✓ Slack socket host — … reachable`: ソケットの接続先ホストまで届く（WebSocket と同じ経路の HTTPS。ソケットは開かない）。
- `· network — proxy settings: …`: サービスの環境にあるプロキシ変数の名前。check はサービスと同じ環境（env ファイルだけ）で走る。
- `✓ model answers — opencode/…, N s`: VM からモデルを呼べる（設定のモデルが一覧になければ、プラグインが選んだ別の無料モデルの名前が出る）。
  テスト用のセッションは削除される。失敗したら、opencode のログ（`~/.opencode-slack/xdg/data/opencode/log/opencode.log`）の ERROR 行が
  `· opencode log —` として出る。
- `✓ model fallback — opencode/osc-check-missing-model → opencode/…`: 存在しないモデルを指定したセッションが、フォールバックプラグインで
  別のモデルに移って答えた。プラグインが設定を読めていて、自動で選べている。
- `· model catalog — N failed fetch(es) …`: opencode がモデル一覧（カタログ）を取れていない。そのあいだは opencode に組み込まれた古い一覧だけで動く。
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

## 2026-10-24 (2): モデルを自動で選ぶようにした

VM の opencode はモデル一覧（カタログ、`https://models.opencode.ai/api.json` を 5 分ごとに取りに行く。タイムアウト 10 秒）を取れておらず、
opencode 2.0.31 に組み込まれた一覧だけで動いていた。そこに `glm-5.3-flash-free` がないので check が失敗した。モデル名を設定に書き足すのは
一覧が変わるたびに直す羽目になるので、やめた。

- フォールバックプラグインに `autoFallback` を足し（[vendor/README.md](../vendor/README.md)）、その時点で一覧にある無料モデルを順に試すようにした。
  設定のモデル（`glm-5.3-flash-free`）や `fallbackModels` は優先順のヒントで、一覧から消えても飛ばすだけ。
- **それまでの VM ではフォールバックが働いていなかった。** `XDG_CONFIG_HOME` をやめて `OPENCODE_CONFIG_DIR` にしたとき、プラグインが設定を
  探す場所から外れていた。プラグインが `OPENCODE_CONFIG_DIR` も探すようにした。
- チェーンの長さが一覧しだいになったので、ブリッジの `upstreamRetry.maxAttempts` を 0（回数では打ち切らない）にした。打ち切りは
  `maxWaitMs`（次の試行まで 10 分を超えたら）に任せる。
- 廃止された `x-preview-f-free`（試すと「Model is unavailable」）を設定から外した。

カタログが取れないままだと、新しい無料モデルは出てこない（消えたモデルは自動で飛ばせる）。取れない理由は、依頼文の 4〜6 の結果を見て直す。

```text
<@U0CCCH69XMW> 修正を入れたので、次をお願いします（ブリッジはまだ起動しないでください）。

1. cd ~/opencode-slack-channel && git pull --ff-only
2. ~/opencode-slack-channel/deploy/linux/setup.sh install --reconfigure
3. ~/opencode-slack-channel/deploy/linux/setup.sh check
4. curl -sS -o /dev/null -w '%{http_code} %{size_download}B %{time_total}s\n' --max-time 60 https://models.opencode.ai/api.json
   curl -sS -o /dev/null -w '%{http_code} %{size_download}B %{time_total}s\n' --max-time 60 https://models.dev/api.json
5. 4 と同じことを、ボットのサービスと同じ環境変数で:
   env -i bash -c 'set -a; . "$0"; set +a; curl -sS -o /dev/null -w "%{http_code} %{size_download}B %{time_total}s\n" --max-time 60 https://models.opencode.ai/api.json' ~/.opencode-slack/env
6. env | grep -iE '^(https?|no|all)_proxy=' | cut -d= -f1
   （プロキシの環境変数の「名前」だけ。値は貼らないでください）

3〜6 の出力を返信してください。
```

## 2026-10-24 (3): プロキシの設定をサービスに渡す

依頼文 (2) の結果で原因が分かった。

- Muse のシェルには `http(s)_proxy` / `all_proxy` / `no_proxy`（大文字も）があり、curl は 200 を返す。
- 同じ curl をボットの環境（env ファイルだけ）で実行すると、0.03 秒で `wrong version number` になる。
- opencode のログには、モデル呼び出しとカタログ取得の両方で `unknown certificate verification error` が出ていた。

VM は、プロキシを通さずに外へ :443 でつなぐと TLS を話さない何かに当たる。systemd のサービスはシェルの環境変数を引き継がないので、
opencode は直接つなごうとして失敗していた。モデルが呼べていなかったので、ボットは動いていなかった。Mac で確かめたこと:

- opencode（Bun 1.4.2）は、TLS を話さない相手に https でつなぐと、VM と同じ「unknown certificate verification error」を出す。
  見知らぬ CA（中身を検査する種類の中継、MITM）なら「unable to verify the first certificate」になるので、そうではない。
- opencode は `HTTPS_PROXY` を読む。Node（ブリッジ）は `NODE_USE_ENV_PROXY=1` がないと読まない。付ければ fetch も WebSocket もプロキシを通り、
  `NO_PROXY` の 127.0.0.1 は直接つなぐ。

直したこと:

- `install` が、実行したシェルのプロキシと CA の環境変数を env ファイルに写す（値は表示しない。ファイルは権限 600）。
  `no_proxy` / `NO_PROXY` には `127.0.0.1,localhost,::1` を足し（ブリッジ → opencode、CLI → opencode はローカル）、プロキシがあれば
  `NODE_USE_ENV_PROXY=1` も付ける。**install はプロキシが設定されたシェルで実行すること。**
- `check` を、env ファイルだけの環境（サービスと同じ）で実行するようにした。シェルにしかない設定のおかげで通ってしまうことがなくなる。
  プロキシ変数の名前と、Slack のソケット用ホストに届くかも表示する。

コンテナで確かめたこと（systemd の system サービス、root、`HOME=/home/hatch`、直接の :443 は平文を返し、プロキシだけが外に出られる）:
古いキットは VM と同じエラーで失敗し、新しいキットでは Slack・ソケットのホスト・モデル・フォールバック・カタログがすべてプロキシ経由で通った。

```text
<@U0CCCH69XMW> 原因が分かったので直しました。ボットのサービスにあなたのシェルのプロキシ設定が渡っておらず、opencode が外へ直接つなごうとして失敗していました。次をお願いします（ブリッジはまだ起動しないでください）。

1. cd ~/opencode-slack-channel && git pull --ff-only
2. ~/opencode-slack-channel/deploy/linux/setup.sh install --reconfigure
   （プロキシの環境変数が入っている、いつものシェルで実行してください。その値をボットの環境ファイルに写します。値は表示されません）
3. ~/opencode-slack-channel/deploy/linux/setup.sh check

2 の出力の最後の 10 行と、3 の出力をそのまま返信してください。
```

## 2026-10-24 (4): Zen の無料枠が VM の IP では尽きている → Zen にログインして試す

依頼文 (3) の結果、プロキシは効き、カタログ・Slack・ソケットのホストは通った。ただしモデル呼び出しが
`Free usage limit reached. Subscribe to OpenCode Go to keep going` で弾かれた。

- VM からの呼び出しが Zen に届いたのはこのときが初めて（それまでは全部 TLS の段階で失敗していた）。それでも最初から上限に達していた。
  つまり、この VM の出口の IP（プロキシ）の無料枠は、ほかの誰かがすでに使い切っていた。同じ時刻に Mac からは無料モデルが 2 秒で答えた。
- 上限はモデルごとではない。glm → deepseek → mimo → beam と 4 つとも同じ答えだった。
- Zen の無料枠は IP ごと（公式ドキュメントに数字や回復時刻の記載はない）。ログインすると枠が増えるという解説はあるが、確かめてはいない。

owner の判断（2026-10-24）: Zen に VM でログインして、無料のまま試す。Mac のボットは止めたまま。

- ログインはデバイス承認（`opencode2 auth login opencode --method device`）。VM で表示されたコードを、owner がブラウザ
  （opencode.ai にログイン済み）で承認する。コードは 1 回限りで、承認した人のアカウントにつながるだけなので、Slack に貼ってよい。
- ログインすると有料の Zen モデルも一覧に出る。ボットの設定と `autoFallback`（`freeOnly`）が選ぶのは無料モデルだけ。
- あわせてプラグインを直した。無料枠の上限に当たったら、ほかの無料モデルを 30 分外し、使えるものが無ければすぐに失敗として返す。
  これまでは 15 分ほど試し続けていた（check の `model fallback` が 240 秒で打ち切られたのはこれ）。

```text
<@U0CCCH69XMW> 無料枠がこの VM の IP では使い切られているので、opencode を Zen のアカウントにログインさせて試します。次をお願いします（ブリッジはまだ起動しないでください）。

1. cd ~/opencode-slack-channel && git pull --ff-only
2. ~/opencode-slack-channel/deploy/linux/setup.sh install --reconfigure
   （前回と同じく、プロキシの環境変数が入ったいつものシェルで）
3. ボットの opencode で Zen のログインを始める（承認されるまで待ち続けるので、切り離して動かします）:
   setsid nohup env -i bash -c 'set -a; . "$0"; set +a; exec opencode2 auth login opencode --method device' ~/.opencode-slack/env > /tmp/osc-zen-login.log 2>&1 < /dev/null &
   sleep 10; grep -E 'Enter code|https://' /tmp/osc-zen-login.log
4. 3 で出た「Enter code: …」の行と https://opencode.ai/console/device?… の URL を、このスレッドに貼ってください（1 回限りのコードで、承認した人のアカウントにつながるだけなので貼って大丈夫です）。コードには期限があるので、すぐにお願いします。
5. こちらで承認したら、tail -5 /tmp/osc-zen-login.log で完了を確かめてから、
   ~/opencode-slack-channel/deploy/linux/setup.sh check
   を実行して、ログの末尾と check の出力を返信してください。check がまだ「Free usage limit reached」なら、
   ~/opencode-slack-channel/deploy/linux/setup.sh install（opencode が再起動します）のあとにもう一度 check して、その結果も返信してください。
```

## 2026-10-24 (5): ログインしても変わらない → Mac と同じく API キーで呼ぶ

依頼文 (4) の結果: デバイス承認でのログインは完了した（`Connected to OpenCode Console`）。それでも check は全部の無料モデルで
`Free usage limit reached` のままで、opencode を再起動しても同じだった。一方 Mac の opencode（v1。ブラウザでログインしていて、
`~/.local/share/opencode/auth.json` に Zen の API キーが `"type": "api"` で入っている）は無料モデルで普通に答える。

- VM でも API キーで呼べば通るかは、**試すまで分からない**（無料枠の数え方は公式ドキュメントに書かれていない）。
- Mac で確かめたこと（2026-10-24、v2 2.0.31 を専用ディレクトリで起動）: 鍵なしで glm-5.3-flash-free が 2 秒で OK、
  `OPENCODE_API_KEY`（Mac の鍵）を入れても 3 秒で OK、cost 0。鍵を入れても無料モデルの呼び出しが壊れないことは分かったが、
  Mac の IP にはもともと枠があるので、VM で通るかの証拠にはならない。

キットに足したもの:
- `node deploy/secrets.mjs seal 'osc-pub1:…' --zen-key FILE`。FILE は opencode の `auth.json`（`opencode` の API キーを取り出す）か、鍵だけを書いたファイル。
- VM の `import` は、鍵を環境ファイルの `OPENCODE_API_KEY` に入れて、opencode を再起動する（ブリッジが動いていなければ）。
  `install --reconfigure` でも鍵は消えない。
- `setup.sh zen-logout`: opencode に保存された OpenCode Console のログインを消す（今回は鍵だけで試すため）。アカウント名は出さない。
- `check` の `model credentials` に、鍵があるか・Console のログインがあるかだけを出す（値は出さない）。

鍵があると Zen の有料モデルも一覧に出る。ボットは無料モデルだけを使うよう、次を入れた。
- セッションが有料モデルにいたら、プロンプトの前に無料モデルへ移す（プラグインの `freeOnly`）。
  サブエージェントのツールはモデルを引数で指定できるので、その対策。
- タイトル生成のモデルを glm-5.3-flash-free に固定した（`agent.title.model`）。固定しないと opencode は gpt-luna などの有料モデルを選ぶ
  （バイナリと 10/24 のカタログで確認）。固定したモデルが一覧から消えたら、セッションのモデル（無料）で作る。
- OpenCode Go（同じ `OPENCODE_API_KEY` を読む）を `disabled_providers` で外した。
- これで塞いだのは見つけた経路だけ。初めて鍵で動かしたあとは、Zen のコンソールで利用額が 0 のままか見る。

```text
<@U0CCCH69XMW> ログインしても無料枠の判定は変わりませんでした。Mac は Zen の API キーで呼んでいて通っているので、VM も API キーで試します。次をお願いします（ブリッジはまだ起動しないでください）。

1. cd ~/opencode-slack-channel && git pull --ff-only
2. ~/opencode-slack-channel/deploy/linux/setup.sh install --reconfigure
   （前回と同じく、プロキシの環境変数が入ったいつものシェルで）
3. ~/opencode-slack-channel/deploy/linux/setup.sh zen-logout
   （前回のデバイス承認でできた OpenCode Console のログインを消します。API キーだけで試すためです）
4. ~/opencode-slack-channel/deploy/linux/setup.sh keygen
5. 1〜4 の出力の末尾と、4 で出た osc-pub1:… の 1 行を、このスレッドに返信してください（公開鍵なので貼って大丈夫です）。
```

Mac 側（Muse が返した `osc-pub1:…` を使う。出力の `osc-sealed1:…` を次の依頼文に入れる）:

```sh
cd ~/work/opencode-slack-channel
node deploy/secrets.mjs seal 'osc-pub1:…' --zen-key ~/.local/share/opencode/auth.json
```

Mac と同じ鍵を使うと、VM 側だけを止めたいときも鍵ごと無効にすることになる。分けたいなら、OpenCode のコンソールで VM 用の鍵を作り、
権限 600 のファイルに鍵だけを書いて `--zen-key そのファイル` にする。

```text
<@U0CCCH69XMW> 続きです（鍵の値は表示されません）。

1. ~/opencode-slack-channel/deploy/linux/setup.sh import 'osc-sealed1:…'
2. ~/opencode-slack-channel/deploy/linux/setup.sh check

両方の出力を返信してください。
```

## 2026-10-24 (6): API キーでも上限のまま／import の直後に Slack と gh が失敗する

依頼文 (5) の結果: import は成功し、check も鍵を認識した（`Zen API key set in the bot env`、Console のログインなし）。それでも
glm-5.3-flash-free は `Free usage limit reached` のまま。あわせて `✗ Slack tokens — fetch failed (0)` と gh の失敗が出た
（22:42 の check では両方通っていた。(4) のときも、ログインの直後に同じ失敗が出て、install のやり直しで戻った）。

モデル（Mac で確かめたこと）:
- 偽の鍵を入れると、無料モデルの呼び出しが `Reconnect OpenCode Console to continue` で失敗する。つまり opencode は無料モデルにも鍵を送り、Zen は鍵を確かめている。
- VM の本物の鍵では、鍵の問題ではなく無料枠の上限で弾かれた。同じ鍵は Mac からなら通る。
- ここから、無料枠の上限は鍵では外れず、VM の出口（プロキシ）に結びついていると考えられる。ただし、VM の opencode サーバーが鍵を
  読み込んでいたことまでは確かめていない（鍵なしでも同じ答えになるため）。check に、サーバーが `OPENCODE_API_KEY` を見ているかの行を足した。

Slack と gh:
- `fetch failed (0)` は、プロキシが CONNECT に 200 以外（407 や 403）で答えたときに Node 24 が出すものだった（偽のプロキシで再現。
  プロキシにつながらないときは `ECONNREFUSED` になる）。つまり、環境ファイルに写したプロキシ設定が、その時点では断られていた。
- install をやり直すと戻るので、シェルのプロキシ設定（認証情報）が時間とともに変わり、写しが古くなる可能性がある。まだ確かめていない。
- `setup.sh netcheck` を足した: シェルの設定と環境ファイルの写しを変数ごとに比べ（同じか違うか・URL に認証情報が入っているか）、
  それぞれで slack.com / api.github.com に CONNECT して状態コードを出す。値は出さない。設定がどのファイルから来ているかも、ファイル名だけ出す。
- check の失敗の文も、何が起きたかが分かるようにした（プロキシがトンネルを断った／gh の終了コードとエラーの 1 行。URL とホスト名は伏せる）。

```text
<@U0CCCH69XMW> ありがとうございます。状態を変えずに原因を調べたいので、次をお願いします（install はまだ実行しないでください。古くなった状態を見たいためです）。

1. cd ~/opencode-slack-channel && git pull --ff-only
2. ~/opencode-slack-channel/deploy/linux/setup.sh netcheck
   （いつものプロキシの環境変数が入ったシェルで。値は表示されず、同じか違うかと状態コードだけが出ます）
3. ~/opencode-slack-channel/deploy/linux/setup.sh check --no-model
4. 2 と 3 の出力をそのまま返信してください。あわせて、このシェルのプロキシの環境変数が時間で入れ替わるもの（トークン入りで期限があるなど）かどうか、ご存じなら教えてください。
```

## 2026-10-24 (7): OpenCode Go で動かす

owner の判断（2026-10-24）: VM の opencode ボットは OpenCode Go の鍵で動かす（Zen の無料モデルは VM の出口で使えないため）。

キットの変更:
- ボットのモデルは `opencode-go/deepseek-v4.1-flash`（Mac のボットが使っていたもの）。
- フォールバックは、opencode が一覧に出している Go のモデルのうち、基本料金が入力 $0.5 / 出力 $2（100 万トークンあたり）以内のものから自動で選ぶ。
  名前の指定（glm-5.3-flash → mimo-v2.6-flash → qwen3.8-flash）は優先順のヒントで、一覧になければ飛ばす。上限を超えるモデルにセッションが
  いたら、プロンプトの前に上限内のモデルへ移す（Go の利用枠を高いモデルで使い切らないため）。
- Zen（`opencode`）は無効にした。タイトル生成は opencode の既定どおり Go の小さいモデル（gpt-luna 系）になる。
- `seal --go-key` で Go の鍵を渡す（Mac の `~/.local/share/opencode/auth.json` の `opencode-go`。Zen の鍵とは別の鍵）。VM の `import` が
  `OPENCODE_API_KEY` を置き換えて opencode を再起動する。

確かめたこと（2026-10-24、Mac とその上の Linux コンテナ。どちらも Mac の IP から）:
- 他から切り離した v2 に Go の鍵を `OPENCODE_API_KEY` で入れ、Zen を無効にすると、一覧は opencode-go の 29 モデルだけ。deepseek-v4.1-flash が 2 秒で OK。
- コンテナでキット一式（install → keygen → seal --go-key → import → check）: `✓ model answers — opencode-go/deepseek-v4.1-flash, 2 s`、
  `✓ model fallback — … → opencode-go/glm-5.3-flash, 4 s`。鍵は出力に出ていない。
- VM（Muse の出口）から Go が通るかは未確認。Go は契約したアカウントごとの枠なので IP には左右されないと考えているが、確かめるのは VM の check。
- Go の利用枠を使い切ったときのエラーの文面は未確認（そのときはフォールバックが Go の安いモデルを順に試し、どれも同じ答えなら失敗として返る）。

```text
<@U0CCCH69XMW> 方針が決まりました。opencode ボットは OpenCode Go（定額プラン）の鍵で動かします。次をお願いします（ブリッジはまだ起動しないでください）。

1. cd ~/opencode-slack-channel && git pull --ff-only
2. ~/opencode-slack-channel/deploy/linux/setup.sh netcheck
   （install の前に。プロキシの写しが古くなっているかを見るためで、状態は変えません。値は表示されません）
3. ~/opencode-slack-channel/deploy/linux/setup.sh install --reconfigure
   （いつものプロキシの環境変数が入ったシェルで。モデルの設定が Go に変わり、プロキシの写しも新しくなります）
4. ~/opencode-slack-channel/deploy/linux/setup.sh keygen
5. 2 の出力、3 の末尾、4 で出た osc-pub1:… の 1 行を、このスレッドに返信してください（公開鍵なので貼って大丈夫です）。
```

Mac 側（Muse が返した `osc-pub1:…` を使う）:

```sh
cd ~/work/opencode-slack-channel
node deploy/secrets.mjs seal 'osc-pub1:…' --go-key ~/.local/share/opencode/auth.json
```

```text
<@U0CCCH69XMW> 続きです（鍵の値は表示されません）。

1. ~/opencode-slack-channel/deploy/linux/setup.sh import 'osc-sealed1:…'
2. ~/opencode-slack-channel/deploy/linux/setup.sh check

両方の出力を返信してください。
```

## 2026-10-25: netcheck の結果（(7) の前半）

- 6 つのプロキシ変数すべてで、環境ファイルの写し（(5) の install のとき）とシェルの値が **DIFFERENT**。どちらも URL に認証情報が入っている。
  → シェルのプロキシの値は時間とともに変わる（確認済み）。設定元は `/etc/environment` と `/etc/profile.d/hatch-egress.sh`。
- ただしこのときは、古い写しも新しい値も、curl では slack.com / api.github.com に CONNECT 200 で通った。古い値がいつまで通るのかは分からない。
  (6) で check（Node の fetch と gh）が失敗した理由は、まだ説明できていない（期限切れ、それとも Node や gh の読み方の違い）。
- netcheck に足した: 環境ファイル経由とシェル経由の両方で Node の fetch と gh を試す（サービスが使うのはこちら）。
  `/etc/environment` の値がシェルと同じかどうか、設定元のファイルと環境ファイルの更新時刻も出す。

## 2026-10-25 (8): VM の作り直しから自動で戻す（start-saved を Muse の cron で）

わかったこと（Claude ボットの移行で Muse が調べた）: VM は予告なく作り直される（実測は 2026-10-24 15:31:51 UTC の 1 回。
プラットフォームの説明では、ランタイムの更新はしばしば 1 時間ごとで、そのとき VM が置き換わり得る）。`/` は消える overlay で、
残るのは `/home/hatch` だけ。`/etc/systemd/system` のサービス定義も自動起動のリンクも消え、crontab も無い。作り直しのあとも
続くのは、Muse の cron ジョブだけ（定義は VM の外にある）。(7) の import で opencode サーバーが落ちていたのもこれ
（install は 15:30 より前、`/etc/environment` の更新は 15:32:04。サーバーは止まるときに service.json を消す）。

そこで Muse の cron で 10 分ごとに `setup.sh start-saved` を実行する。何度実行しても安全で、必要なときだけ動く:

| 状態 | start-saved がすること | 出力の 1 行目 |
|---|---|---|
| `start --cutover` 以降に `stop` した、または一度も起動していない | 何もしない（止めたボットは生き返らせない） | `start-saved: not wanted …` |
| 両方のサービスが動いていて、Slack につながっていて、プロキシの写しも通る | 何もしない | `start-saved: running — nothing to do` |
| どちらかが動いていない（作り直しでサービス定義が消えた等） | install をやり直す（設定・API キー・トークン・opencode のバージョンはそのまま、プロキシ設定は写し直す ※）→ ブリッジを起動 | `start-saved: RECOVERING …` |
| 動いているが、プロキシが環境ファイルの写しを 401/403/407 で断り（2 回試す）、ほかの設定なら通す（または直近 3 回の Slack 接続がすべて失敗） | プロキシ設定を写し直して（※）両方を再起動。断られたときのコードも出す | `start-saved: RESTARTING …` |

※ 写すのは、`/etc/environment` の設定がプロキシを通ればそちら、通らなければ実行したシェルのもの（下の「10 分ごとの RESTARTING」を参照。最初は常にシェルのものだった）。

最後は `start-saved: done — the bot is running and connected`（失敗なら `error:` で始まる行、終了コード 1）。
Claude キットとの違いは、プロキシの写しを直接試すこと（curl で Slack の `api.test`）。ブリッジの Slack 接続は前から開いたまま
なので、写しが古くなってもブリッジのログには出ないが、opencode のモデルへの新しい接続はその時点から拒否される。

```text
<@U0CCCH69XMW> opencode ボットの続きです。VM が作り直されてもボットが自動で戻るようにしました（Claude ボットと同じ方式です）。次を順に実行して、出力を返信してください。bridge はまだ起動しないでください。

1. 最新版を取得
   cd ~/opencode-slack-channel && git pull --ff-only
2. 確認（読むだけです）
   uptime -s; ls /etc/systemd/system/ | grep opencode-slack || echo "opencode-slack の unit なし"
3. サービスを作り直す（前の依頼で実行済みでも、もう一度実行して大丈夫です。設定・API キー・Slack トークンはそのまま残り、プロキシ設定はいまのシェルから写し直します）
   ~/opencode-slack-channel/deploy/linux/setup.sh install 2>&1 | tail -n 8
4. ~/opencode-slack-channel/deploy/linux/setup.sh check
5. 一度手で実行（まだ切り替え前なので、何もしないはずです）
   ~/opencode-slack-channel/deploy/linux/setup.sh start-saved
   → 1 行目が "start-saved: not wanted" で始まることを確かめてください。
6. あなたの cron ジョブを 1 つ追加してください: 10 分ごとに、いつものシェル（プロキシの環境変数が入っているもの）で
   ~/opencode-slack-channel/deploy/linux/setup.sh start-saved
   を実行する。出力が "nothing to do" を含むときは報告不要です。"RECOVERING" か "RESTARTING" を含むとき、または終了コードが 0 以外のときだけ、出力をそのまま owner に知らせてください。

2〜5 の出力と、登録した cron ジョブの名前・間隔を返信してください。ボットを止めたいときは setup.sh stop を使ってください（stop すると start-saved は何もしなくなるので、cron はそのままで構いません）。
```

## 2026-10-25: (8) の結果（Muse の報告）

- `uptime -s` は 2026-10-25 00:31:51（JST）、`/etc/systemd/system` に opencode-slack の unit は無かった → (7) の import で
  サーバーが落ちていたのは VM の作り直しのため、で確定。
- install でサービス定義を作り直し、opencode サーバーが起動。check は **全項目合格**:
  OpenCode Go の `deepseek-v4.1-flash` が VM から 3 秒で応答、存在しないモデルからの切り替えも `glm-5.3-flash` へ 4 秒、
  Slack の 2 つのトークンとソケットのホスト、gh（azumag）も OK、サーバーは `OPENCODE_API_KEY` を見ている。
- `start-saved` の手動実行は `not wanted`（切り替え前なので正しい）。Muse の cron ジョブ `opencode-bot-autorecover`（10 分ごと）を登録済み。
- 残りは依頼文 3（切り替え）だけ。Mac 側のブリッジと v2 サーバーは止まったまま（plist は `.disabled`、プロセスなし）。

## 2026-10-25: 切り替え（依頼文 3）の結果

owner の OK を受けて Muse が実行。01:32:48（VM の時刻）にブリッジが起動し、`slack identity: @opencode (U0C9Y2F2HEV, bot B0C9ZRNQZV2)`、
`running`、01:32:50 に `socket connected (num_connections=1)`（この Slack アプリの接続は VM の 1 本だけ）。Muse の cron
`opencode-bot-autorecover` は、この時点から `bridge-wanted` を見て動く。owner が #agent-council でメンションし、VM のボットから
返事が来ることを確認した（移行完了）。Mac のブリッジと v2 サーバーの plist は、戻すときのために `.disabled` のまま残してある。

## 2026-10-25: 切り替え 7 分後の RESTARTING（01:39）

Muse の cron の 2 回目（切り替え後の初回）で `RESTARTING — the env file's proxy settings are refused`。両方を再起動して
`socket connected (num_connections=1)` まで戻った。写しは 01:32 の install のシェルのもの。

ただし、この判定は「Slack から HTTP 200 が返らなければ拒否」という粗いもので、一時的な遅れや Slack 側のエラーでも再起動していた。
一方で Claude ボットは、00:34 の install のシェルの写しのまま 02:00 ごろにも返事できていた（owner が確認）。写しが本当に断られたのかは
わからない。そこで:

- 判定を「プロキシが 401/403/407 で断った」ときだけにした（2 回試す）。つながらない・遅いだけなら何もしない。
  RESTARTING の行に、写しとシェルそれぞれの CONNECT / HTTP のコードを出す。
- start-saved が動いたときの行を `~/.opencode-slack/logs/start-saved.history` に残し、`setup.sh status` で直近 5 件を出す。
- netcheck の CONNECT の試験に、`/etc/environment` の設定（起動時に書かれる）も加えた。

## 2026-10-25: 10 分ごとの RESTARTING — cron のシェルの認証情報はすぐ断られる

01:39 のあとも 01:49・01:59・02:09 と cron のたびに RESTARTING（4 回連続）。02:09 の行のコードは、写しが `CONNECT/HTTP 407 000`、
シェルが `200 200`。401/403/407 だけを数える判定でも 407 なので、写しは本当に断られていた。owner は VM のまま動かして調べることにし、
Muse の調査（b7718af の netcheck ほか）でわかったこと:

- 環境ファイルの写しは CONNECT 407、Node の fetch も gh も失敗。写しは 16:49:53 UTC（cron の RESTARTING）に書かれたもので、
  調べた 16:53:16 UTC にはもう断られていた。
- いまのシェルと `/etc/environment` の設定は CONNECT 200。`/etc/environment` は 15:32:04 UTC（VM の起動時）に書かれ、
  80 分以上たっても通る。Claude ボットの写し（00:34 に Muse のふだんのシェルで install）も通ったまま。
- `/etc/profile.d/hatch-egress.sh` は固定の `export` だけ。CA は `/run/hatch/egress-tls/ca-bundle.pem`。認証情報の単位・
  有効期間・デーモンからの外向き通信について書かれたものは見つからなかった。
- cron の履歴: 01:29:47 は報告なし、01:39:47 と 01:49:47 が RESTARTING。

シェルごとに別の認証情報が配られ、cron ジョブのシェルのものは数分で断られる（ジョブが終わると無効になるのかもしれないが、未確認）。
start-saved が cron のシェルから写し直すと、その写しが数分後に断られ、次の cron がまた写し直す、という悪循環だった。
その間、ブリッジの Slack 接続は開いたままだが、opencode のモデルへの新しい接続は断られる。

直し方: サービスに渡すプロキシ設定は、`/etc/environment` のものがプロキシを通ればそちら、通らなければ実行したシェルのもの。
install・`net-refresh`・`start-saved` のすべてで同じ。出力にどちらから写したかが出る（`network settings taken from /etc/environment`、
`taking /etc/environment's proxy settings`）。netcheck には `/etc/environment = env file` が出る。コンテナの試験では、
起動時の認証（ずっと通る）と cron の実行ごとの認証（次の実行では断られる）を分けて、次を確かめた: 作り直しのあとは `/etc/environment` の
認証で戻る、cron の認証が切れても何もしない、`/etc/environment` が新しくなれば写し直す、`/etc/environment` も断られるときだけシェルのものを使う。

```text
<@U0CCCH69XMW> opencode ボットの続きです。調査ありがとうございました。原因は、cron ジョブのシェルから写したプロキシの認証情報が数分で断られることでした（写すたびに次の失効が始まる悪循環）。サービスには /etc/environment の認証情報（起動時に書かれ、長く通るもの）を渡すように直しました。次を順に実行して、出力を返信してください。ボットは動かしたままで大丈夫です（2 で一度だけ両方が再起動します）。

1. 最新版を取得
   cd ~/opencode-slack-channel && git pull --ff-only && git log -1 --oneline
2. プロキシ設定を /etc/environment から写し直して両方を再起動（値は表示されません）
   ~/opencode-slack-channel/deploy/linux/setup.sh net-refresh
   → "network settings taken from /etc/environment" の行があることを確かめてください。
3. ~/opencode-slack-channel/deploy/linux/setup.sh netcheck
4. ~/opencode-slack-channel/deploy/linux/setup.sh check
5. ~/opencode-slack-channel/deploy/linux/setup.sh status
6. 30 分以上たってから（cron が 3 回以上動いたあと）、もう一度 5 を実行して、その出力も返信してください。

cron ジョブ opencode-bot-autorecover はそのままにしてください。直っていれば、このあとの cron は "nothing to do" が続きます。RESTARTING が来たら、これまでどおり出力をそのまま owner に知らせてください。
```

## 2026-10-25: 95367d2 を VM に入れた結果（Muse の報告、02:24 JST）

- pull で 95367d2。`net-refresh` は `network settings taken from /etc/environment`（プロキシ 6 変数・no_proxy・CA 4 変数・
  NODE_USE_ENV_PROXY）、両方を再起動（opencode 02:24:43、ブリッジ 02:24:50 から active）。
- netcheck: プロキシ 6 変数と no_proxy は `/etc/environment = env file`。CONNECT は shell / envfile / etcenv の 18 通りすべて 200、
  環境ファイル経由の Node fetch（slack.com）は HTTP 200、gh も exit 0。
- check は全項目合格（Go の deepseek-v4.1-flash が 3 秒、切り替え先も 2 秒）。
- `/etc/environment` と `hatch-egress.sh` の更新時刻が **17:19:55 UTC（02:19:55 JST）** になっていた（前は 15:32:04 UTC）。
  Muse は「VM の再起動時に書き直された」としているが、02:24 の net-refresh の時点でサービスは動いていた（作り直しなら unit が消えて
  いて、02:19:47 の cron より後なので戻す機会もない）。作り直しなしで書き直された可能性が高い（未確認）。
- Hermes 側の 3b（02:1x JST ごろの netcheck）では、プロキシは認証情報なしでも誤った認証情報でも CONNECT 200 だった。
  そのままなら、このあと RESTARTING が出なくても、直したからなのか、プロキシが認証を見ていないからなのかは区別できない。

未確認: 10 分ごとの RESTARTING が止まったか（Muse が 03:02 に status を報告する予定）。そのときに区別するための追加の依頼:

```text
<@U0CCCH69XMW> opencode ボットの確認ありがとうございます。03:02 の報告に、次の 3 つも加えてください（どれも読むだけで、値は出ません）。

1. uptime -s
2. ~/opencode-slack-channel/deploy/linux/setup.sh status の出力を省略せずに全部（とくに末尾の "start-saved acted (last 5, UTC):" の行。無ければ無いと書いてください）
3. プロキシが今、認証情報を見ているかの確認（出るのは数字だけです）
   p=$(sed -n 's/^https_proxy=//p' /etc/environment | tail -n 1 | tr -d '"')
   curl -s -o /dev/null -m 20 -x "$(printf %s "$p" | sed -E 's#//[^@]*@#//#')" -w 'no-cred: %{http_connect} %{http_code}\n' https://api.github.com/zen
   curl -s -o /dev/null -m 20 -x "$(printf %s "$p" | sed -E 's#//[^@]*@#//x:y@#')" -w 'wrong-cred: %{http_connect} %{http_code}\n' https://api.github.com/zen

あわせて、netcheck で /etc/environment の更新時刻が 02:19:55 JST になっていた件について、VM の再起動（作り直し）と判断した根拠があれば教えてください。
```

## 2026-10-25: 03:02 の経過確認（Muse の報告）— 10 分ごとの再起動は止まった

`setup.sh status`（03:02 JST）: 両サービスとも 17:24:43 / 17:24:50 UTC（02:24 JST の net-refresh）から 37 分動き続けている。
`start-saved acted` の最後の 5 行（UTC）:

```text
17:09:54 RESTARTING — env file's: CONNECT/HTTP 407 000; this shell's: 200 200; taking this shell's
17:10:04 done
17:19:56 RESTARTING — env file's: CONNECT/HTTP 407 000; this shell's: 200 200; taking this shell's
17:22:14 RECOVERING — the bot should run but does not; install again …
17:22:21 done
```

- 02:24 の net-refresh のあと、cron（定時なら 02:29・02:39・02:49・02:59 の 4 回）は何もしていない（動いたときだけ履歴に残る）。直す前は 01:39〜02:19 の 5 回すべてが
  再起動していた。10 分ごとの再起動が止まったことは実測で確かめた。
- **なぜ止まったかの訂正:** `/etc/environment` は「起動時の長く通る認証情報」ではなかった。Claude キットの 02:48 の netcheck では、
  シェルの値には `user:pass@` があり、環境ファイル（= `/etc/environment`）の値には無い。`/etc/environment` のプロキシ URL には
  認証情報が入っていない。プロキシは認証情報なしの接続を通し（Hermes の 3b、02:1x JST）、期限の切れた認証情報は 407 で断る（同じ 3b で、でたらめな
  認証情報は 200 だった。断るのは期限切れだけなのかもしれないが、未確認）。
  だから `/etc/environment` を写せば切れない。キットの動き（通る方を写す）はそのままで正しい。説明だけを直した（README とコメント）。
- **02:19:55 の件の訂正:** 上の節で「作り直しなしで書き直された可能性が高い」と書いたのは、たぶん誤り。17:19:56 の RESTARTING
  には `done` が続かず、2 分後の 17:22:14 に RECOVERING（サービスが動いていない → install し直し）が記録されている。
  `/etc/environment` の書き直し（17:19:55）と合わせると、02:20 ごろに VM が作り直され、02:22 に start-saved がボットを戻した、
  と読むのが自然。そうなら、作り直しのあとの初めての自動復旧。ただし次の 2 点は未確認:
  - 作り直しがあったか（追加の依頼の `uptime -s` で決まる）。
  - 17:22:14 の start-saved を誰が動かしたか。cron の定時（毎時 9 分 47 秒〜）から外れている。
  なお、この RECOVERING は修正前の版（b7718af）で動いたので、シェルの設定を写していた。それを 02:24 の net-refresh が
  `/etc/environment` のものに置き換えた。

まだ確かめていないこと:
- 02:24 以降に、ボットがメンションに返事するか（check のモデル呼び出しは 02:24 に通った）。
- 追加の依頼（`uptime -s`、認証情報なし／誤りの CONNECT）の答え。
- 修正後の版での、作り直しからの自動復旧（RECOVERING の行に `proxy settings from /etc/environment` が出るか）。

## 2026-10-25: 5 つのボットの自動復旧ジョブを 1 つにまとめる（owner の依頼）

03:35:47 の VM の作り直しでは、各ボットの 10 分ごとのジョブが DSH・Claude・Hermes・Cline を 03:40〜03:45 に戻した。
このジョブは作り直しから戻す唯一の手段なので止めない。ただ、ボットごとに 1 つずつで Muse の負担が 5 倍になっているので、
1 つにまとめる。まとめたコマンドは 5 つの `start-saved` を順に実行し、1 つが失敗しても残りを続け、最後の終了コードで
失敗の有無を返す（`bash -c` の中で `exit` するので、Muse のシェルは閉じない。偽のキット 5 つで試験済み）。
作り直しの直後は 5 つを順に入れ直すので、合わせて 10 分ほどかかることがある（DSH は接続待ちが最長 120 秒、Hermes は 90 秒）。

```text
<@U0CCCH69XMW> ボットの自動復旧の定期ジョブを 1 つにまとめたいです。いまは 5 つのボット（opencode・Claude・Hermes・Cline・DSH）ごとに 10 分おきのジョブがあり、あなたの負担が 5 倍になっています。03:35 の VM の作り直しでは、このジョブが DSH・Claude・Hermes・Cline を 5〜10 分で戻してくれたので、止めずに 1 つにします。次を順に行って、出力を返信してください。

1. いまの定期ジョブの一覧（名前と間隔）を見せてください。自動復旧のものは opencode-bot-autorecover・claude-bot-autorecover・hermes-bot-autorecover・cline-bot-autorecover・dsh-bot-autorecover の 5 つのはずです（名前が違えば教えてください）。
2. まとめたコマンドを一度手で実行してください（動いているボットには何もしません。止まっているボットだけを戻します）:
   bash -c 'rc=0; for k in opencode-slack-channel claude-slack-channel hermes-vm-kit cline-slack-kit dsh-slack-channel; do echo "== $k"; "$HOME/$k/deploy/linux/setup.sh" start-saved 2>&1; c=$?; echo "== $k exit $c"; [ "$c" = 0 ] || rc=1; done; exit $rc'
   → 5 つとも "nothing to do" を含み、"exit 0" で終わることを確かめてください。
3. 2 が問題なければ、新しい定期ジョブを 1 つ登録してください。名前は bots-autorecover、10 分ごと、いつものシェル（プロキシの環境変数が入っているもの。HOME は /home/hatch）で 2 のコマンドを実行します。報告の条件は次のとおりです。出力に "RECOVERING"・"RESTARTING"・"error" のどれかが入ったとき、または最後の終了コードが 0 以外のときだけ、そのボットの部分（"== 名前" から "== 名前 exit N" まで）をそのまま owner に知らせてください。それ以外は報告不要です。
4. 3 を登録したあとで、1 の古い 5 つのジョブを削除してください（新しいジョブを先に入れるので、空白の時間はできません）。
5. 定期ジョブの一覧をもう一度見せてください。

2 の出力全部と、5 の一覧を返信してください。定期ジョブに実行時間の上限があれば、それも教えてください（VM の作り直しの直後は 5 つを順に入れ直すので、合わせて 10 分ほどかかることがあります）。2 で "nothing to do" 以外が出たり、exit が 0 でなかったりしたら、3・4 には進まずに、そこで返信してください。ボットを止めたいときは、これまでどおりそのボットの setup.sh stop を使ってください（止めたボットには、まとめたジョブも何もしません）。
```

### まとめた結果（Muse の報告、2026-10-25 04:2x JST）

- 古いジョブは想定どおりの 5 つ（すべて 10 分ごと）だった。
- まとめたコマンドの手動実行: 5 つとも `nothing to do` で `exit 0`（Hermes は `env file CONNECT 200, this shell CONNECT 200`）。
  opencode も `running` なので、03:35 の作り直しのあと、opencode の古いジョブが戻していたことになる（どの設定で戻したかは見ていない）。
- 新しいジョブ `bots-autorecover`（10 分ごと、実行時間の上限 30 分）を先に登録し、古い 5 つを削除した。自動復旧のジョブはこれ 1 つだけ。
- 未確認: 新しいジョブが定時に動いたこと（何も無ければ報告しない決まりなので、次の作り直しか、Muse にジョブの実行履歴を見せてもらうまでわからない）。
- 各キットの手順書に残っている古いジョブ名（`cline-bot-autorecover` など）は、いまは `bots-autorecover` のこと。

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
<@U0CCCH69XMW> Mac 側のボットを止めました。次を順に実行して、出力を返信してください。

1. cd ~/opencode-slack-channel && git pull --ff-only
2. ~/opencode-slack-channel/deploy/linux/setup.sh install 2>&1 | tail -n 5
3. ~/opencode-slack-channel/deploy/linux/setup.sh start --cutover
```

2 の install は、VM が作り直されていた場合のサービス定義と、プロキシ設定の写しをいまのシェルから作り直すため（設定・鍵・トークンはそのまま）。

出力（ブリッジのログの末尾）に `slack identity: @… (U0C9Y2F2HEV, …)` と `socket connected (num_connections=1)` があればつながっている（1 = この Slack アプリの接続はこの VM の 1 本だけ、つまり Mac 側は切れている）。そのあと #agent-council で <@U0C9Y2F2HEV> にメンションして、返事が来るかを確かめる。

## 戻すとき

```text
<@U0CCCH69XMW> ~/opencode-slack-channel/deploy/linux/setup.sh stop を実行して、出力を返信してください。
```

`setup.sh stop` は `bridge-wanted` も消すので、Muse の cron の `start-saved` は何もしなくなる（cron はそのままでよい）。
`systemctl stop` やプロセスの kill で止めると、cron が 10 分以内に起動し直してしまう。

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
- **モデルは OpenCode Go で、自動で選ぶ。** Mac は `opencode-go/deepseek-v4.1-flash` → gemma4:12b（Mac の tailnet 内の Ollama）→
  `x-preview-f-free` だった。VM は `opencode-go/deepseek-v4.1-flash` から始め、失敗したら、その時点で一覧にある Go のモデルのうち基本料金が
  入力 $0.5 / 出力 $2 以内のものを順に試す（ヒントの glm-5.3-flash → mimo-v2.6-flash → qwen3.8-flash、そのあと残りを新しい順）。
  Zen の無料モデルは使わない（VM の出口の IP では無料枠が尽きていた。「2026-10-24 (5)〜(7)」）。
- **`secrets-hygiene.md` を VM では instructions に入れた。** Mac では `~/.config/opencode/rules/` に置いてあるだけで、opencode.json から読まれていない。GitHub に投稿するときは `~/.opencode-slack/agent-guards/gh-comment` 経由になる。
- **Mac のグローバルプラグイン（auto-continue / loop / fiosracht-model-sync）は入れない。** ボットのセッションで動いた記録が無く、fiosracht プロバイダはもう無い。
- **Zen 無料モデルの日次枠は IP ごと**（とされる）なので、VM は Mac と別の枠になる。VM の IP では尽きていたので、Zen の API キーで呼ぶ（「2026-10-24 (5)」）。
