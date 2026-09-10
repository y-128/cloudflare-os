import { describe, expect, it } from "vitest";
import { dnsRecordsMatch } from "../workers/lib/cloudflare-email";

// DKIM のタグ値と base64 公開鍵は大文字小文字を区別する (RFC 6376)。異なる鍵を
// 「既存で充足」と判定すると、誤った鍵のまま進み署名検証が通らなくなる。
describe("DNSレコード比較の型依存", () => {
  it("大文字小文字だけ異なる DKIM 鍵を別物として扱う", () => {
    const a = { type: "TXT", name: "k._domainkey.example.com", content: '"v=DKIM1; p=AbCdEf"' };
    const b = { type: "TXT", name: "k._domainkey.example.com", content: '"v=DKIM1; p=abcdef"' };
    expect(dnsRecordsMatch(a, b)).toBe(false);
  });

  it("引用符とチャンク分割は吸収する", () => {
    const a = { type: "TXT", name: "k._domainkey.example.com", content: '"v=DKIM1; p=AAAA" "BBBB"' };
    const b = { type: "TXT", name: "k._domainkey.example.com", content: "v=DKIM1; p=AAAABBBB" };
    expect(dnsRecordsMatch(a, b)).toBe(true);
  });

  it("ホスト名は大文字小文字と末尾ドットを無視する", () => {
    const a = { type: "MX", name: "example.com", content: "Route1.MX.Cloudflare.net.", priority: 5 };
    const b = { type: "MX", name: "example.com", content: "route1.mx.cloudflare.net", priority: 5 };
    expect(dnsRecordsMatch(a, b)).toBe(true);
  });
});
