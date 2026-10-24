# opencode-slack-channel

opencode v2 サーバー（`opencode2 serve --service`）を Slack から使うためのボット。
**Slack のスレッド 1 本 = opencode のセッション 1 つ**。Socket Mode なので公開 URL は不要。Node ≥ 22、npm 依存なし。

仕様の根拠（Hermes / DSH ボットとの比較・レビュー）は [docs/SPEC.md](docs/SPEC.md)。

## 動き

- チャンネルでは**メンションされた投稿だけ**に反応する。DM はメンション不要。
- トップレベルでメンション → その投稿をスレッドの起点に新しいセッションを作る。スレッド内でメンションすると同じセッションの続きになる。
- 返信はスレッドに投稿する（`thread_ts` は常に親の ts）。👀 → ✅ / ❌ / ⏹ でリアクションを付け替える。
- opencode には `[名前 | Slack user <@U…>] 本文` の形で送る。スレッド途中で初めて呼ばれたときは過去の発言を、2 回目以降は前回以降の差分を文脈として付ける。
- セッション作成時に、Slack 用の指示（名乗り・送信者の扱い・整形・簡潔さ・できないこと）を instructions として注入する。
- 実行中に届いた投稿はキューに積み、ターンが終わると順に送る。
- モデル提供元の失敗で再試行待ちになったり、何も進まなくなったりしたら、スレッドに知らせ、限度を超えたら中断して失敗として返す（`upstreamRetry` / `stall`）。黙ったまま待ち続けない。再試行の直前にモデルが切り替わった（フォールバック。opencode 側の rate-limit-fallback プラグインなど）ときは、失敗したモデルと切り替え先も書き、中断時には失敗したモデルを並べる。
- 再起動しても、実行中だったセッションを引き継ぎ、終わったら返信する（依頼者へのメンションは付かない）。
- 許可（`permission.asked`）と質問（`form.created`）は、スレッドにボタン付きで出す。期限（既定 30 分）を過ぎると、許可は拒否・質問は取り消しになる。
- 許可リスト:
  - `allowedChannelIds` / `allowedUserIds` は**既定で拒否**（`allowedUserIds` を空にすると誰も使えない。全員に開放するなら `"*"`）。
  - `allowedBotIds` に載った bot だけが、メンションしたときに処理される。
  - bot の投稿はチャンネルごとに 5 分 20 件まで。超えたら 10 分間無視する。
  - 承認や回答ができるのは許可された人間だけで、bot はコマンドも使えない。

## コマンド

DM、ボットが作業中のスレッド、またはメンション付きで使える。

| コマンド | 動作 |
|---|---|
| `!new` | このスレッドとセッションの対応を切る（次の投稿で新しいセッション） |
| `!stop` | 実行中のターンを中断し、キューを空にする |
| `!steer <text>` | 実行中のターンに指示を差し込む |
| `!status` | セッション ID・モデル・状態 |
| `!allow` / `!always` / `!deny` | 許可プロンプトに答える |
| `!answer <text>` / `!cancel` | 質問に答える / 取り消す（文字入力の質問は、スレッドに普通に書いても答えになる） |
| `!id` | チャンネル ID と自分のユーザー ID |
| `!help` | 使い方 |

## セットアップ

1. **Slack アプリを作る**: [api.slack.com/apps](https://api.slack.com/apps) → *Create New App* → *From a manifest* → ワークスペースを選び、[slack-app-manifest.yaml](slack-app-manifest.yaml) を貼る → *Create*。
   - *Basic Information* → *App-Level Tokens* → *Generate*（scope `connections:write`）で `xapp-` トークンを発行する。
   - *Install App* → *Install to Workspace* で `xoxb-` トークンを発行する。
2. **トークンを保存**: `./set-tokens.sh`（入力は表示されない。`~/.config/opencode-slack-channel/tokens.json` に権限 600 で保存）。
3. **設定**: [config.example.json](config.example.json) を `~/.config/opencode-slack-channel/config.json` にコピーし、`allowedUserIds` に自分のメンバー ID（Slack のプロフィール → ⋮ → *メンバー ID をコピー*）を入れる。チャンネルで使うなら `allowedChannelIds` も設定する（ボットを `/invite` しておく）。
4. **起動**:
   - 手動: `node bin/opencode-slack-channel.js`
   - 常駐: `./launchd/install.sh`（ログは `~/Library/Logs/opencode-slack-channel.log`、外すときは `./launchd/install.sh uninstall`）

opencode サーバーの URL とパスワードは、v2 サービスが書く `~/.local/state/opencode/service.json` から毎回読む（Basic 認証、ユーザー名 `opencode`）。サービスを再起動してパスワードが変わっても追従する。

### Linux（clone してスクリプト 1 本）

```sh
git clone https://github.com/azumag/opencode-slack-channel.git ~/opencode-slack-channel
~/opencode-slack-channel/deploy/linux/setup.sh install   # Node・opencode CLI・設定・サービス。Slack にはまだつながない
~/opencode-slack-channel/deploy/linux/setup.sh keygen    # トークン受け渡し用の公開鍵（osc-pub1:…）を出す
~/opencode-slack-channel/deploy/linux/setup.sh import 'osc-sealed1:…'
~/opencode-slack-channel/deploy/linux/setup.sh check
~/opencode-slack-channel/deploy/linux/setup.sh start --cutover   # 旧ボットを止めてから
```

- sudo 不要。Node ≥ 22 が無ければ公式 tarball を検証して入れる。opencode は専用の設定・データディレクトリ（`~/.opencode-slack/xdg`。`OPENCODE_CONFIG_DIR` と `XDG_DATA/STATE/CACHE_HOME`）で動かすので、その機械の `~/.config/opencode` には触れない。`XDG_CONFIG_HOME` は変えないので、ボットの中の gh / git は普段の `~/.config` を読む。
- install を実行したシェルのプロキシ・CA の環境変数（`https_proxy` など）を、サービスの環境ファイルに写す（サービスはシェルの環境を引き継がないため。ブリッジ用に `NODE_USE_ENV_PROXY=1`、ローカル宛ては `no_proxy` に足す）。`check` はその環境ファイルだけの環境で走る。`netcheck` は、いま実行しているシェルのプロキシ設定と環境ファイルの写しを比べ、それぞれで Slack / GitHub に CONNECT できるかを試す（値は出さず、同じか違うかと状態コードだけ）。
- systemd のユーザーサービス（root なら system サービス）で常駐する。systemd が無ければバックグラウンドのループで動かし、復帰用の crontab 行（`start-saved`）を表示する。
- 移設先の機械は作り直されることがある（Muse の VM は `/home` だけが残り、`/etc/systemd/system` のサービス定義は消える。プロキシの認証情報も変わる）。`start-saved` を cron で 10 分ごとに実行すると、`start --cutover` で起動して `stop` していないボットだけを戻す。サービスが動いていなければ install をやり直して（設定・API キー・入っている opencode のバージョンはそのまま、プロキシ設定は写し直す）起動する。動いていても、プロキシが環境ファイルの写しを 401/403/407 で断り、ほかの設定なら通すときは、写し直して両方を再起動する（ブリッジの Slack 接続は前からつながったままでも、opencode のモデルへの新しい接続は拒否されるため。つながらない・遅いだけでは再起動しない）。写すプロキシ設定は、`/etc/environment` のものがプロキシを通ればそちら、通らなければ実行したシェルのもの（Muse の VM はシェルごと・cron の実行ごとに認証情報付きのプロキシ URL を配り、cron の実行のものは数分で断られる。`/etc/environment` のプロキシ URL には認証情報が無く、切れることがない。install と `net-refresh` も同じ）。動いたときの記録は `setup.sh status` に出る。それ以外は何もしない。`net-refresh` は、写し直しと再起動だけを手で行う。試験は `tests/linux-container/run.sh up` のあと `run.sh e2e`（systemd 入りのコンテナ、認証付きプロキシ、偽の Slack）。
- モデルは OpenCode Go（定額プラン）の `deepseek-v4.1-flash`。失敗したら、その時点で opencode が一覧に出している Go のモデルのうち、基本料金が上限（入力 $0.5 / 出力 $2、100 万トークンあたり）以内のものへ自動で切り替える（同梱のフォールバックプラグインの `autoFallback.maxCost`。[vendor/README.md](vendor/README.md)）。モデルが増えたり消えたりしても設定を直さなくてよい。上限を超えるモデルにセッションがいたら、プロンプトの前に上限内のモデルへ移す。
- Go の API キーは、元の機械で `seal … --go-key <auth.json か鍵だけのファイル>` で暗号化し、`import` すると環境ファイルの `OPENCODE_API_KEY` に入って opencode が再起動する（`install --reconfigure` でも残る）。`check` は鍵の有無と、opencode サーバーが鍵を見ているかだけを表示する（値は出さない）。
- Zen（`opencode`）は `disabled_providers` で外す。Zen の無料モデルは、移設先（Muse の VM）の出口の IP では無料枠が尽きていて、Zen の API キーを入れても使えなかった。同じ `OPENCODE_API_KEY` で Zen の有料モデルが請求されないようにもなる。Zen で動かす場合は `seal --zen-key` と `setup.sh zen-logout`（保存された OpenCode Console のログインを消す）が使える。
- トークンは平文で運ばない。移設先が作った公開鍵に向けて、元の機械で `node deploy/secrets.mjs seal` で暗号化した 1 行を渡す。
- 別の人（アシスタント）に頼んで移すときの手順と依頼文は [docs/MUSE_HANDOFF.md](docs/MUSE_HANDOFF.md)。

## 設定項目

| キー | 既定 | 意味 |
|---|---|---|
| `model` | サーバー既定 | `{ "providerID", "id" }`。新しいセッションのモデル |
| `agent` | サーバー既定 | エージェント（`build` など） |
| `permissions` | なし | 新しいセッションに付けるルール `[{ action, resource, effect: allow\|deny\|ask }]`。エージェントのルールより優先される。bash ツールの action 名は **`shell`** |
| `cwd` / `channelCwd` | `~/work` / `{}` | セッションの作業ディレクトリ（チャンネルごとに上書きできる） |
| `allowedChannelIds` / `allowAllChannels` | `[]` / `false` | 反応するチャンネル |
| `allowDirectMessages` | `true` | DM を受けるか |
| `allowedUserIds` | `[]`（誰も使えない） | 使える人。`"*"` なら全員 |
| `allowedBotIds` | `[]` | メンションしてきたら処理する bot（ユーザー ID `U…` か bot ID `B…`） |
| `mentionUserIds` | `[]` | エージェントが本文に書いた `<@U…>` を実メンションにしてよい ID |
| `ccUserIds` | `[]` | 全返信の先頭に CC する user ID |
| `replyMention` | `always` | 返信の先頭で送信者をメンションするか（`always` / `humans` / `off`。DM では付けない） |
| `loopGuard` | 20 件 / 300 秒 → 600 秒 | bot 投稿の上限 |
| `upstreamRetry` | `{ maxAttempts: 3, maxWaitMs: 300000 }` | モデル提供元の失敗（レート制限・endpoint unavailable など）で opencode が再試行を予約したら、スレッドに ⚠️ で知らせる（依頼者へのメンション付き。2回目以降は同じメッセージを書き換え）。次の試行の番号が `maxAttempts` に達するか（opencode は最初の再試行を 2 と数えるので、既定の 3 は「2 回失敗したら」）、次の試行まで `maxWaitMs` を超えるなら、ターンを中断して失敗として返す。0 でその条件を無効化 |
| `stall` | `{ noticeMs: 600000, giveUpMs: 1800000 }` | 実行中なのに opencode から何のイベントもない時間。`noticeMs` で知らせ、`giveUpMs` で中断して失敗として返す。0 で無効化 |
| `threadContextMessages` / `channelContextMessages` | 30 / 10 | 文脈として付ける件数 |
| `replyMode` | `last` | `last` は最後のテキストだけ、`all` はターン中の全テキスト |
| `maxReplyChars` | 4000 | 返信を分割する長さ |
| `interactiveTimeoutMs` | 1800000 | 許可・質問の期限（0 なら無期限） |
| `instructions` | なし | Slack 用の指示に追記する文 |
| `stateFile` | `~/.local/state/opencode-slack-channel/state.json` | スレッドとセッションの対応表 |

## テスト

```sh
node tests/run.mjs                      # 単体 + 結合（偽の Slack / 偽の opencode）
node smoke/opencode-live.mjs            # 本物の opencode サーバー + 偽の Slack（作ったセッションは削除する）
```

## 既知の制限

- テキストのみ（添付ファイルは渡さない。`file_share` は本文だけ使う）。
- ストリーミング表示、`assistant.threads.setStatus` には未対応。
- v2 の既定エージェント `build` は全ツールを allow にしている。Slack から危険な操作をさせたくない場合は `permissions` で ask / deny を付ける。
