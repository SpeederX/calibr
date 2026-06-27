import test from "node:test";
import assert from "node:assert/strict";
import { parseModelIdentity, intakeModel, lightCacheMatch, planCatalogIntake } from "../dist/engine/catalog/modelIntake.js";

// ---- filename identity ------------------------------------------------------

test("parseModelIdentity splits model / variant / series / params", () => {
  assert.deepEqual(parseModelIdentity("Qwen3.5-9B-Q4_K_M"),
    { model: "Qwen3.5-9B", series: "Qwen3.5", variant: "Q4_K_M", params_b: 9, is_moe_heuristic: false });
  assert.deepEqual(parseModelIdentity("Qwen3-30B-A3B-Q4_K_M"),
    { model: "Qwen3-30B-A3B", series: "Qwen3", variant: "Q4_K_M", params_b: 30, is_moe_heuristic: true });
  assert.deepEqual(parseModelIdentity("Qwen3.5-0.8B-UD-Q4_K_XL"),
    { model: "Qwen3.5-0.8B", series: "Qwen3.5", variant: "UD-Q4_K_XL", params_b: 0.8, is_moe_heuristic: false });
});

test("parseModelIdentity falls back to unknown variant", () => {
  const id = parseModelIdentity("weirdmodel");
  assert.equal(id.variant, "unknown");
  assert.equal(id.model, "weirdmodel");
});

// ---- intake orchestration ---------------------------------------------------

const READABLE = {
  architecture: "qwen3moe", block_count: 48, context_length: 40960, tensor_count: 579,
  tensor_data_offset: 1000, tensor_bytes: 18550716416, global_tensor_bytes: 430290944,
  expert_tensor_bytes: 17553162240, block_tensor_bytes: [],
};
const UNREADABLE = {
  architecture: null, block_count: null, context_length: null, tensor_count: 0,
  tensor_data_offset: null, tensor_bytes: null, global_tensor_bytes: null,
  expert_tensor_bytes: null, block_tensor_bytes: [],
};

function makeFs(present) {
  return {
    exists: () => present,
    sizeBytes: () => 18800000000,
    pickMmproj: () => null,
    join: (...p) => p.join("/"),
    baseName: (p) => p.split("/").pop(),
    dirName: (p) => p.split("/").slice(0, -1).join("/"),
    stripGgufExt: (n) => n.replace(/\.gguf$/, ""),
  };
}

const entry = { hf_repo: "unsloth/Qwen3-30B-A3B-GGUF", hf_file: "Qwen3-30B-A3B-Q4_K_M.gguf", target_dir: "Qwen3-30B-A3B" };
const payload = { entry, destRoot: "/models" };

test("intakeModel: present + matching signature -> ok with metadata", async () => {
  const res = await intakeModel(payload, {
    ensurePresent: async () => { throw new Error("must not download a present file"); },
    readLocalHeader: async () => READABLE,
    readRemoteHeader: async () => READABLE,
    fs: makeFs(true),
  });
  assert.equal(res.ok, true);
  assert.equal(res.metadata.model, "Qwen3-30B-A3B");
  assert.equal(res.metadata.is_moe, true);              // A3B heuristic + experts
  assert.equal(res.metadata.gguf_expert_tensor_bytes, 17553162240);
  assert.equal(res.metadata.path, "/models/Qwen3-30B-A3B/Qwen3-30B-A3B-Q4_K_M.gguf");
});

test("intakeModel: missing file downloads first", async () => {
  let downloaded = false;
  const res = await intakeModel(payload, {
    ensurePresent: async () => { downloaded = true; return { ok: true }; },
    readLocalHeader: async () => READABLE,
    readRemoteHeader: async () => READABLE,
    fs: makeFs(false),
  });
  assert.equal(downloaded, true);
  assert.equal(res.ok, true);
});

test("intakeModel: failed download surfaces download_failed", async () => {
  const res = await intakeModel(payload, {
    ensurePresent: async () => ({ ok: false, reason: "network down" }),
    readLocalHeader: async () => READABLE,
    readRemoteHeader: async () => READABLE,
    fs: makeFs(false),
  });
  assert.equal(res.ok, false);
  assert.equal(res.errorKind, "download_failed");
});

test("intakeModel: unreadable GGUF is an error", async () => {
  const res = await intakeModel(payload, {
    ensurePresent: async () => ({ ok: true }),
    readLocalHeader: async () => UNREADABLE,
    readRemoteHeader: async () => READABLE,
    fs: makeFs(true),
  });
  assert.equal(res.ok, false);
  assert.equal(res.errorKind, "unreadable_gguf");
});

test("intakeModel: signature mismatch blocks (wrong/tampered file)", async () => {
  const res = await intakeModel(payload, {
    ensurePresent: async () => ({ ok: true }),
    readLocalHeader: async () => READABLE,
    readRemoteHeader: async () => ({ ...READABLE, architecture: "llama", tensor_bytes: 123 }),
    fs: makeFs(true),
  });
  assert.equal(res.ok, false);
  assert.equal(res.errorKind, "signature_mismatch");
  assert.match(res.error, /architecture/);
});

// ---- light match + pre-pass -------------------------------------------------

test("lightCacheMatch: missing / size match / size mismatch / unverified", () => {
  assert.deepEqual(lightCacheMatch({ exists: false, localSize: 0, catalogSize: 100 }), { cached: false, reason: "missing" });
  assert.equal(lightCacheMatch({ exists: true, localSize: 100, catalogSize: 100 }).cached, true);
  assert.equal(lightCacheMatch({ exists: true, localSize: 90, catalogSize: 100 }).cached, false);
  assert.deepEqual(lightCacheMatch({ exists: true, localSize: 90, catalogSize: null }), { cached: true, reason: "present (size unverified)" });
});

test("planCatalogIntake summarises count + transfer over the scope", () => {
  const entries = [
    { id: "a", hf_repo: "r/a", hf_file: "a.gguf", target_dir: "A", size_bytes: 100 }, // present, match -> cached
    { id: "b", hf_repo: "r/b", hf_file: "b.gguf", target_dir: "B", size_bytes: 200 }, // missing -> download
    { id: "c", hf_repo: "r/c", hf_file: "c.gguf", target_dir: "C", size_bytes: 300 }, // present wrong size -> download
  ];
  const sizes = { "/m/A/a.gguf": 100, "/m/C/c.gguf": 999 };
  const fs = {
    join: (...p) => p.join("/"),
    exists: (p) => p in sizes,
    sizeBytes: (p) => sizes[p] ?? 0,
  };
  const plan = planCatalogIntake(entries, "/m", fs);
  assert.equal(plan.total, 3);
  assert.equal(plan.toDownload, 2);              // b (missing) + c (size mismatch)
  assert.equal(plan.transferBytes, 500);         // 200 + 300
  assert.equal(plan.items.find((i) => i.id === "a").cached, true);
});

test("intakeModel: offline remote leaves signature unverified but proceeds", async () => {
  const res = await intakeModel(payload, {
    ensurePresent: async () => ({ ok: true }),
    readLocalHeader: async () => READABLE,
    readRemoteHeader: async () => null,
    fs: makeFs(true),
  });
  assert.equal(res.ok, true);
  assert.equal(res.signatureUnverified, true);
});

test("intakeModel: present file matching the catalog size skips download", async () => {
  const res = await intakeModel(
    { entry: { ...entry, size_bytes: 18800000000 }, destRoot: "/models" },
    {
      ensurePresent: async () => { throw new Error("must not download a size-matching file"); },
      readLocalHeader: async () => READABLE,
      readRemoteHeader: async () => null,
      fs: makeFs(true), // sizeBytes() === 18800000000
    },
  );
  assert.equal(res.ok, true);
  assert.equal(res.downloaded, false);
});

test("intakeModel: present file with the wrong size re-downloads (size-based)", async () => {
  let downloaded = false;
  const res = await intakeModel(
    { entry: { ...entry, size_bytes: 18800000000 }, destRoot: "/models" },
    {
      ensurePresent: async () => { downloaded = true; return { ok: true }; },
      readLocalHeader: async () => READABLE,
      readRemoteHeader: async () => null,
      fs: { ...makeFs(true), sizeBytes: () => 999 }, // present but wrong size
    },
  );
  assert.equal(downloaded, true);
  assert.equal(res.ok, true);
  assert.equal(res.downloaded, true);
});
