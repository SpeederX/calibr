import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test("preferences view exposes the VRAM warning preference", async () => {
  const dir = mkdtempSync(join(tmpdir(), "calibr-preferences-"));
  process.env.CALIBR_CONFIG = join(dir, "config.json");
  writeFileSync(process.env.CALIBR_CONFIG, "{}", "utf8");
  const { PreferencesView } = await import(`../dist/PreferencesView.js?cache=${Date.now()}`);
  try {
    const { lastFrame, unmount } = render(
      React.createElement(PreferencesView, { onExit: () => {} })
    );
    await tick();
    const frame = lastFrame();
    assert.match(frame, /preferences/);
    assert.match(frame, /saved defaults/);
    assert.match(frame, /vram usage warning/);
    assert.match(frame, /10%/);
    assert.match(frame, /VRAM used before the run \/ total VRAM x 100/);
    assert.match(frame, /1500 \/ 8192 = 18\.3%/);
    assert.match(frame, /planned advanced defaults/);
    assert.match(frame, /gpu layers sweep/);
    assert.match(frame, /cpu moe sweep/);
    assert.match(frame, /polling interval/);
    assert.match(frame, /left\/right or -\/\+/);
    unmount();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
