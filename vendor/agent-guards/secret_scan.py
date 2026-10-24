#!/usr/bin/env python3
"""secret_scan.py — GitHub へ投稿する本文の秘密情報スキャン（stdlib のみ）

用途: PR / Issue コメント・本文を投稿する直前に本文ファイルを走査し、
資格情報らしき文字列があれば exit 1 で投稿を止める。

設計方針:
- 検出した値そのものは絶対に出力しない（先頭数文字 + *** + 長さのみ）。
- 既知の公開サンプル（AWS ドキュメントの例示キー等）は除外する。
- `<REDACTED>` / `…` / `***` を含むプレースホルダは検出しない。
- 行末に `secret-scan:allow` がある行はスキップ（テスト・文書用）。

exit code: 0 = clean, 1 = 検出あり, 2 = 使い方/IO エラー
"""
from __future__ import annotations

import argparse
import bisect
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

ALLOW_MARKER = "secret-scan:allow"

# 公開ドキュメントに載っている実在しないサンプル値
ALLOWLIST_EXACT = frozenset(
    {
        "AKIAIOSFODNN7EXAMPLE",
        "AKIAI44QH8DHBEXAMPLE",
        "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    }
)

# プレースホルダの目印。含まれていたら本物ではないとみなす。
# 注意: "xxx" のような短い英字列を目印にすると、実トークンにたまたま
#       含まれた場合に取りこぼす。目印は「人が伏せたと分かる形」に限定する。
PLACEHOLDER_MARKERS = ("<", "…", "***", "redacted", "placeholder")

# URL 資格情報の説明用プレースホルダ。`scheme://user:pass@` のような仕様説明まで
# 止めると関門が邪魔になり、やがて無効化されるため、明白な説明用の値だけ通す。
DOC_PLACEHOLDER_PASSWORDS = frozenset(
    {"pass", "password", "pwd", "secret", "s3cr3t", "hunter2", "yourpassword", "redacted"}
)
DOC_PLACEHOLDER_HOSTS = frozenset(
    {"host", "hostname", "example.com", "example.org", "localhost", "your-host", "yourhost"}
)


@dataclass(frozen=True)
class Rule:
    name: str
    pattern: re.Pattern[str]


RULES: tuple[Rule, ...] = (
    # GitHub: OAuth app (gho_) / PAT (ghp_) / app (ghs_) / user-to-server (ghu_) / refresh (ghr_)
    Rule("github-token", re.compile(r"\bgh[opusr]_[A-Za-z0-9]{36}\b")),
    Rule("github-fine-grained-pat", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{22,}\b")),
    Rule("slack-token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}")),
    Rule("slack-webhook", re.compile(r"https://hooks\.slack\.com/services/[A-Za-z0-9/]{20,}")),
    Rule("aws-access-key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    Rule("google-api-key", re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b")),
    Rule("gitlab-pat", re.compile(r"\bglpat-[A-Za-z0-9_\-]{20,}")),
    # Stripe 等の sk_live_ / sk-live- は専用規則で拾う（先に評価して分類を優先）。
    Rule("stripe-live-key", re.compile(r"\b[rs]k[-_](?:live|test)[-_][A-Za-z0-9]{10,}")),
    Rule(
        "openai-or-anthropic-key",
        re.compile(r"\bsk-(?!ant-)(?!live[-_])(?!test[-_])[A-Za-z0-9_\-]{20,}"),
    ),
    Rule("private-key-block", re.compile(r"-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----")),
    Rule("jwt", re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}")),
    Rule("bearer-header", re.compile(r"(?i)\bauthorization\s*:\s*bearer\s+[A-Za-z0-9._\-]{16,}")),
    Rule("url-credentials", re.compile(r"(?i)\b[a-z][a-z0-9+.\-]*://[^/\s:@]+:[^@\s/]{3,}@")),
    # key=value / "key": "value" 形。
    # 注意: 旧実装は \b(api_key|token|...) として _ の後で境界が切れず
    #       SLACK_BOT_TOKEN= を取りこぼした。キーワード前に [A-Za-z0-9_.-]* を許す。
    Rule(
        "key-value-pair",
        re.compile(
            r"(?i)(?:^|[\s\"'`{,(])[A-Za-z0-9_.\-]{0,40}"
            r"(?:api[_\-]?key|token|secret|passwd|password|credential|private[_\-]?key)"
            r"[A-Za-z0-9_.\-]{0,20}\s*[:=]\s*[\"']?[A-Za-z0-9_\-+/=.]{16,}"
        ),
    ),
)


@dataclass(frozen=True)
class Finding:
    line: int
    column: int
    offset: int
    length: int
    rule: str
    masked: str

    def as_dict(self) -> dict[str, object]:
        return {
            "line": self.line,
            "column": self.column,
            "rule": self.rule,
            "masked": self.masked,
            "length": self.length,
        }


def mask(value: str) -> str:
    """値を先頭6文字だけ残して伏せる。6文字は識別子としては十分で、秘密としては無価値。"""
    if len(value) <= 10:
        return "***"
    return value[:6] + "***"


def _is_placeholder(value: str) -> bool:
    lowered = value.lower()
    return any(marker in lowered for marker in PLACEHOLDER_MARKERS)


_URL_CREDS_RE = re.compile(
    r"(?i)\b[a-z][a-z0-9+.\-]*://([^/\s:@]+):([^@\s/]{3,})@([^/\s:]+)?"
)


def _is_doc_placeholder_url(value: str) -> bool:
    match = _URL_CREDS_RE.search(value)
    if not match:
        return False
    password = match.group(2).lower()
    host = (match.group(3) or "").lower()
    return password in DOC_PLACEHOLDER_PASSWORDS or host in DOC_PLACEHOLDER_HOSTS


def _line_index(starts: list[int], offset: int) -> int:
    return bisect.bisect_right(starts, offset) - 1


def scan_text(text: str) -> list[Finding]:
    """本文を走査して Finding を返す（重複スパンは最初のルールだけ採用）。"""
    starts = [0]
    for m in re.finditer("\n", text):
        starts.append(m.end())

    findings: list[Finding] = []
    seen: set[tuple[int, int]] = set()

    for rule in RULES:
        for match in rule.pattern.finditer(text):
            value = match.group(0)
            if value in ALLOWLIST_EXACT or _is_placeholder(value):
                continue
            if rule.name == "url-credentials" and _is_doc_placeholder_url(value):
                continue

            line_idx = _line_index(starts, match.start())
            line_start = starts[line_idx]
            line_end = text.find("\n", line_start)
            if line_end == -1:
                line_end = len(text)
            if ALLOW_MARKER in text[line_start:line_end]:
                continue

            column = match.start() - line_start + 1
            span = (line_idx + 1, column)
            if span in seen:
                continue
            seen.add(span)

            findings.append(
                Finding(
                    line=line_idx + 1,
                    column=column,
                    offset=match.start(),
                    length=len(value),
                    rule=rule.name,
                    masked=mask(value),
                )
            )

    findings.sort(key=lambda f: (f.line, f.column))
    return findings


def redact_text(text: str, findings: list[Finding]) -> str:
    out = text
    for finding in sorted(findings, key=lambda f: f.offset, reverse=True):
        out = (
            out[: finding.offset]
            + f"[REDACTED:{finding.rule}]"
            + out[finding.offset + finding.length :]
        )
    return out


def read_inputs(paths: list[str]) -> list[tuple[str, str]]:
    if not paths:
        return [("<stdin>", sys.stdin.read())]
    items: list[tuple[str, str]] = []
    for raw in paths:
        if raw == "-":
            items.append(("<stdin>", sys.stdin.read()))
        else:
            items.append((raw, Path(raw).read_text(encoding="utf-8")))
    return items


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="secret_scan.py",
        description="投稿本文の秘密情報スキャン（検出値は出力しない）",
    )
    parser.add_argument("paths", nargs="*", help="走査するファイル。省略時は stdin。")
    parser.add_argument("--json", action="store_true", help="JSON で結果を出す")
    parser.add_argument("--redact", action="store_true", help="検出部を伏せた本文を stdout へ")
    parser.add_argument("--quiet", action="store_true", help="検出時も詳細を出さない（exit code のみ）")
    args = parser.parse_args(argv)

    try:
        inputs = read_inputs(args.paths)
    except OSError as exc:
        print(f"secret_scan: {exc}", file=sys.stderr)
        return 2

    all_findings: list[tuple[str, Finding]] = []
    redacted: list[str] = []

    for name, text in inputs:
        findings = scan_text(text)
        all_findings.extend((name, f) for f in findings)
        if args.redact:
            redacted.append(redact_text(text, findings))

    if args.redact:
        sys.stdout.write("\n".join(redacted))

    if args.json:
        payload = {
            "clean": not all_findings,
            "findings": [
                {"file": name, **finding.as_dict()} for name, finding in all_findings
            ],
        }
        print(json.dumps(payload, ensure_ascii=False, indent=2))

    elif all_findings and not args.quiet and not args.redact:
        for name, finding in all_findings:
            print(
                f"{name}:{finding.line}:{finding.column}: "
                f"{finding.rule}: {finding.masked} ({finding.length} chars)",
                file=sys.stderr,
            )
        print(
            f"secret_scan: {len(all_findings)} 件の秘密情報らしき文字列を検出。投稿しないこと。",
            file=sys.stderr,
        )
    elif not all_findings and not args.quiet:
        print("secret_scan: clean", file=sys.stderr)

    return 1 if all_findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
