import test from "node:test";
import assert from "node:assert/strict";
import { resolveDownloadPlan, downloadModel } from "../dist/engine/catalog/modelDownload.js";

// ---- pure decision ---------------------------------------------------------

test("resolveDownloadPlan: complete final is skipped", () => {
  assert.deepEqual(
    resolveDownloadPlan({ finalExists: true, finalSize: 10, partExists: false, partSize: 0, expectedSize: 10, calibrOwned: true }),
    { kind: "skip", reason: "complete" },
  );
});

test("resolveDownloadPlan: user-owned size mismatch is left untouched", () => {
  assert.deepEqual(
    resolveDownloadPlan({ finalExists: true, finalSize: 7, partExists: false, partSize: 0, expectedSize: 10, calibrOwned: false }),
    { kind: "skip", reason: "user-owned-mismatch" },
  );
});

test("resolveDownloadPlan: calibr-owned mismatch restarts (may overwrite)", () => {
  assert.deepEqual(
    resolveDownloadPlan({ finalExists: true, finalSize: 7, partExists: false, partSize: 0, expectedSize: 10, calibrOwned: true }),
    { kind: "restart" },
  );
});

test("resolveDownloadPlan: partial part resumes; oversize part restarts", () => {
  assert.deepEqual(
    resolveDownloadPlan({ finalExists: false, finalSize: 0, partExists: true, partSize: 4, expectedSize: 10, calibrOwned: false }),
    { kind: "resume", fromBytes: 4 },
  );
  assert.deepEqual(
    resolveDownloadPlan({ finalExists: false, finalSize: 0, partExists: true, partSize: 99, expectedSize: 10, calibrOwned: false }),
    { kind: "restart" },
  );
});

// ---- orchestrator (injected deps) ------------------------------------------

function makeFs(initial = {}) {
  const files = new Map(Object.entries(initial).map(([k, v]) => [k, Buffer.from(v)]));
  return {
    files,
    exists: (p) => files.has(p),
    size: (p) => (files.get(p)?.length ?? 0),
    ensureDir: () => {},
    append: (p, chunk) => files.set(p, Buffer.concat([files.get(p) ?? Buffer.alloc(0), Buffer.from(chunk)])),
    truncate: (p) => files.set(p, Buffer.alloc(0)),
    rename: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    remove: (p) => files.delete(p),
  };
}

function bytes(n) { return new Uint8Array(n).fill(1); }
async function* yieldChunks(...chunks) { for (const c of chunks) yield c; }
const fixedHasher = (hex) => () => ({ update() {}, hex: () => hex });
const throwHttp = async () => { throw new Error("httpGet must not be called"); };

const base = { repo: "r/m", file: "m.gguf", destPath: "/m.gguf", calibrOwned: false };

test("downloadModel: fresh download verifies size + sha and renames atomically", async () => {
  const fs = makeFs();
  const calls = [];
  const res = await downloadModel(base, {
    remoteInfo: async () => ({ size: 10, sha: "ABC", url: "u" }),
    httpGet: async (url, opts) => { calls.push(opts); return { status: 200, total: 10, chunks: yieldChunks(bytes(5), bytes(5)) }; },
    fs,
    hasher: fixedHasher("abc"),
  });
  assert.equal(res.ok, true);
  assert.equal(res.action, "restart");
  assert.equal(res.bytes, 10);
  assert.equal(res.verified, true);
  assert.equal(fs.size("/m.gguf"), 10);
  assert.equal(fs.exists("/m.gguf.part"), false);
  assert.deepEqual(calls, [{}]); // no range header on a fresh download
});

test("downloadModel: complete file is skipped without any HTTP", async () => {
  const fs = makeFs({ "/m.gguf": bytes(10) });
  const res = await downloadModel(base, {
    remoteInfo: async () => ({ size: 10, sha: "abc", url: "u" }),
    httpGet: throwHttp, fs,
  });
  assert.equal(res.ok, true);
  assert.equal(res.action, "skip");
  assert.equal(res.verified, true);
});

test("downloadModel: user file with a different size is never clobbered", async () => {
  const fs = makeFs({ "/m.gguf": bytes(7) });
  const res = await downloadModel(base, {
    remoteInfo: async () => ({ size: 10, sha: "abc", url: "u" }),
    httpGet: throwHttp, fs,
  });
  assert.equal(res.ok, true);
  assert.equal(res.action, "user-owned-mismatch");
  assert.equal(fs.size("/m.gguf"), 7); // untouched
});

test("downloadModel: resumes a partial with a Range request", async () => {
  const fs = makeFs({ "/m.gguf.part": bytes(4) });
  const calls = [];
  const res = await downloadModel(base, {
    remoteInfo: async () => ({ size: 10, sha: null, url: "u" }),
    httpGet: async (url, opts) => { calls.push(opts); return { status: 206, total: 10, chunks: yieldChunks(bytes(6)) }; },
    fs,
  });
  assert.equal(res.ok, true);
  assert.equal(res.action, "resume");
  assert.equal(fs.size("/m.gguf"), 10);
  assert.deepEqual(calls, [{ rangeFrom: 4 }]);
});

test("downloadModel: server ignoring the range (200) restarts from zero", async () => {
  const fs = makeFs({ "/m.gguf.part": bytes(4) });
  const res = await downloadModel(base, {
    remoteInfo: async () => ({ size: 10, sha: null, url: "u" }),
    httpGet: async () => ({ status: 200, total: 10, chunks: yieldChunks(bytes(10)) }),
    fs,
  });
  assert.equal(res.ok, true);
  assert.equal(fs.size("/m.gguf"), 10); // not 4+10
});

test("downloadModel: size mismatch keeps the part and fails", async () => {
  const fs = makeFs();
  const res = await downloadModel(base, {
    remoteInfo: async () => ({ size: 10, sha: null, url: "u" }),
    httpGet: async () => ({ status: 200, total: 10, chunks: yieldChunks(bytes(8)) }),
    fs,
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /size mismatch/);
  assert.equal(fs.exists("/m.gguf"), false);
  assert.equal(fs.exists("/m.gguf.part"), true); // kept for resume
});

test("downloadModel: sha mismatch removes the part and fails", async () => {
  const fs = makeFs();
  const res = await downloadModel(base, {
    remoteInfo: async () => ({ size: 10, sha: "abc", url: "u" }),
    httpGet: async () => ({ status: 200, total: 10, chunks: yieldChunks(bytes(10)) }),
    fs,
    hasher: fixedHasher("def"),
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /sha256 mismatch/);
  assert.equal(fs.exists("/m.gguf.part"), false);
});

test("downloadModel: missing remote file fails cleanly", async () => {
  const fs = makeFs();
  const res = await downloadModel(base, { remoteInfo: async () => null, httpGet: throwHttp, fs });
  assert.equal(res.ok, false);
  assert.match(res.reason, /not found/);
});
