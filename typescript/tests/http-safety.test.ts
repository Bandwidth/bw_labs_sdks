import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BwSttClient } from "../src/client";
import { ProtocolError } from "../src/errors";

let cert: Buffer;
let key: Buffer;
let directory: string;
let originalCertificates: string[];
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "sdk-tls-"));
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1",
    "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"),
  ], { stdio: "ignore" });
  cert = readFileSync(join(directory, "cert.pem"));
  key = readFileSync(join(directory, "key.pem"));
  originalCertificates = getCACertificates("default");
  setDefaultCACertificates([...originalCertificates, cert.toString()]);
});
afterAll(() => {
  setDefaultCACertificates(originalCertificates);
  rmSync(directory, { recursive: true, force: true });
});

async function listen(server: Server, secure = false): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing address");
  return `${secure ? "https" : "http"}://127.0.0.1:${address.port}`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

describe.each([301, 302, 303, 307, 308])("HTTP %i", (status) => {
  describe.each(["cross-origin", "same-origin", "downgrade"])("%s", (destination) => {
    it.each(["get", "submit", "delete", "transcribe"])("rejects %s without forwarding credentials", async (method) => {
      const received: IncomingMessage["headers"][] = [];
      const sources: IncomingMessage["headers"][] = [];
      const sink = createHttpServer((request, response) => {
        received.push(request.headers);
        response.end("{}");
      });
      let location = "";
      const handler = (request: IncomingMessage, response: ServerResponse) => {
        if (request.url === "/redirected") {
          received.push(request.headers);
          response.end("{}");
          return;
        }
        sources.push(request.headers);
        request.resume();
        response.writeHead(status, { Location: location });
        response.end();
      };
      const secure = destination === "downgrade";
      const source = secure ? createHttpsServer({ key, cert }, handler) : createHttpServer(handler);
      try {
        const targetUrl = await listen(sink);
        const sourceUrl = await listen(source, secure);
        location = `${destination === "same-origin" ? sourceUrl : targetUrl}/redirected`;
        const client = new BwSttClient({ apiKey: "synthetic-key", baseUrl: sourceUrl });
        const request = method === "transcribe" ? client.transcribe(new Uint8Array([0, 0]))
          : method === "submit" ? client.transcriptions.submit({ audio: new Uint8Array([0, 0]) })
            : method === "get" ? client.transcriptions.get("job-1") : client.transcriptions.delete("job-1");
        await expect(request).rejects.toBeInstanceOf(ProtocolError);
        expect(sources).toHaveLength(1);
        expect(sources[0]?.["user-agent"]).toBe("bw-stt-typescript/0.2.0");
        expect(received).toEqual([]);
      } finally {
        await close(source);
        await close(sink);
      }
    });
  });
});
