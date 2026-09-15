import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Disposable test-only certificates, never used for deployed applications.
export function testCertificate(privateKey: string, expired = false) {
  const directory = mkdtempSync(join(tmpdir(), "yaota-test-cert-"));
  try {
    const keyPath = join(directory, "key.pem");
    const certPath = join(directory, "cert.pem");
    writeFileSync(keyPath, privateKey, { mode: 0o600 });
    execFileSync("openssl", ["req", "-new", "-x509", "-key", keyPath, "-out", certPath, "-days", "365", "-subj", "/CN=yaota-test-only"], { stdio: "ignore" });
    if (expired) execFileSync("openssl", ["x509", "-in", certPath, "-signkey", keyPath, "-days", "-1", "-out", certPath], { stdio: "ignore" });
    return readFileSync(certPath, "utf8");
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
